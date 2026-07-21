import express, {
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response
} from "express";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import path from "node:path";
import type { Server } from "node:http";
import { once } from "node:events";
import { z } from "zod";
import { AnalysisCoordinator } from "./analysis-coordinator.js";
import { loadConfig, type AppConfig } from "./config.js";
import type {
  DependencyReadiness,
  MeetingAnalyzer,
  NormalizedMeetingEvent,
  RecallAdapter
} from "./contracts.js";
import {
  CodexAppServerClient,
  CodexHandoffLauncher,
  CodexMeetingAnalyzer
} from "./codex/index.js";
import {
  createRecallWebhookHandler,
  MAX_MEETING_TIMESTAMP_SECONDS,
  RecallBotCreationAmbiguousError,
  RecallClient,
  recallRawJsonBody
} from "./recall/index.js";
import { SessionStore } from "./session-store.js";
import { SessionRevisionConflictError } from "./session-store.js";
import {
  buildCodexHandoffPackage
} from "./codex/handoff-package.js";
import {
  BusinessGraphSchema,
  validateCustomerEvidence,
  validateGraphReferences
} from "../shared/schemas.js";
import {
  toWhiteboardSnapshot,
  type PostCallReviewState,
  type SessionSnapshot,
  type WhiteboardSnapshot
} from "../shared/types.js";

const DevUtteranceSchema = z
  .object({
    id: z.string().min(1),
    sequence: z.number().int().nonnegative(),
    participantId: z.string().min(1),
    participantName: z.string().min(1),
    text: z.string().min(1),
    startedAt: z.number().finite().nonnegative().max(MAX_MEETING_TIMESTAMP_SECONDS),
    endedAt: z.number().finite().nonnegative().max(MAX_MEETING_TIMESTAMP_SECONDS),
    finalized: z.literal(true)
  })
  .strict()
  .refine((utterance) => utterance.endedAt >= utterance.startedAt, {
    message: "endedAt must not precede startedAt"
  });

const ProcessingStateSchema = z
  .object({
    paused: z.boolean()
  })
  .strict();

const OperatorSelectionSchema = z
  .object({
    participantId: z.string().min(1)
  })
  .strict();

const PostCallEditSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    graph: BusinessGraphSchema,
    notes: z.string().max(50_000),
    annotations: z
      .record(
        z.string().min(1).max(64),
        z
          .object({
            targetType: z.enum(["node", "edge", "pain", "contradiction"]),
            disposition: z.enum(["accepted", "amended", "unsupported"]),
            note: z.string().max(4_000)
          })
          .strict()
      )
      .default({})
  })
  .strict();

const normalizeReviewAnnotations = (
  graph: SessionSnapshot["graph"],
  annotations: PostCallReviewState["annotations"]
): PostCallReviewState["annotations"] => {
  const itemIds = {
    node: new Set(graph.nodes.map((item) => item.id)),
    edge: new Set(graph.edges.map((item) => item.id)),
    pain: new Set(graph.pains.map((item) => item.id)),
    contradiction: new Set(graph.contradictions.map((item) => item.id))
  };
  return Object.fromEntries(
    Object.entries(annotations).flatMap(([id, annotation]) => {
      const note = annotation.note.trim();
      if (!note) return [];
      if (!itemIds[annotation.targetType].has(id)) {
        throw new Error(
          `Review annotation ${id} does not match an existing ${annotation.targetType}.`
        );
      }
      return [[id, { ...annotation, note }]];
    })
  );
};

const HandoffPrepareSchema = z
  .object({
    expectedGraphRevision: z.number().int().nonnegative(),
    expectedReviewRevision: z.number().int().nonnegative()
  })
  .strict();

const RECALL_BOT_NAME = "Live Architect";
const MAX_EVENT_FUTURE_SKEW_MS = 5 * 60 * 1_000;

const safeOrderingTimestamp = (value: number | undefined): number => {
  const now = Date.now();
  return value !== undefined &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= now + MAX_EVENT_FUTURE_SKEW_MS
    ? value
    : now;
};

export interface ScoutRuntimeDependencies {
  analyzer?: MeetingAnalyzer;
  recall?: RecallAdapter;
  statusRecall?: RecallAdapter;
  store?: SessionStore;
  logger?: (record: Record<string, unknown>) => void;
  handoffRootDir?: string;
  handoffLauncher?: Pick<CodexHandoffLauncher, "launch" | "close">;
}

export interface ScoutRuntime {
  app: express.Express;
  config: AppConfig;
  store: SessionStore;
  coordinator: AnalysisCoordinator;
  readiness(): Promise<ScoutReadiness>;
  close(): Promise<void>;
}

export interface ScoutReadiness {
  ok: boolean;
  mode: "live" | "rehearsal" | "unavailable";
  codex: DependencyReadiness;
  recall: DependencyReadiness;
}

const sessionStatusFromBot = (
  status: string
): "creating" | "waiting_for_admission" | "listening" | "ended" | "error" => {
  switch (status) {
    case "waiting_for_admission":
      return "waiting_for_admission";
    case "listening":
      return "listening";
    case "ended":
      return "ended";
    case "error":
      return "error";
    default:
      return "creating";
  }
};

const integrationStatusFromBot = (
  status: string
): "connecting" | "waiting" | "active" | "idle" | "error" => {
  switch (status) {
    case "waiting_for_admission":
      return "waiting";
    case "listening":
      return "active";
    case "ended":
      return "idle";
    case "error":
      return "error";
    default:
      return "connecting";
  }
};

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));

const projectRoot = (): string => {
  const candidates = [
    process.cwd(),
    path.resolve(moduleDirectory, "../.."),
    path.resolve(moduleDirectory, "../../..")
  ];
  const resolved = candidates.find(
    (candidate) =>
      existsSync(path.join(candidate, "package.json")) &&
      existsSync(path.join(candidate, "public"))
  );
  if (!resolved) {
    throw new Error("Unable to locate the Scout project root and public assets.");
  }
  return resolved;
};

const routeParam = (value: string | string[] | undefined): string =>
  Array.isArray(value) ? (value[0] ?? "") : (value ?? "");

const postCallBlocker = (snapshot: SessionSnapshot): string | undefined => {
  if (snapshot.status !== "ended") {
    return "The meeting must end before post-call review begins.";
  }
  if (snapshot.analysis.status === "running") {
    return "Scout is still finalizing the accepted map.";
  }
  if (snapshot.analysis.status === "queued" || snapshot.analysis.pendingUtteranceCount > 0) {
    return "Analyze the remaining finalized utterances before post-call review.";
  }
  return undefined;
};

const handoffBlocker = (snapshot: SessionSnapshot): string | undefined =>
  postCallBlocker(snapshot) ?? (
    snapshot.postCall.approvedAt === undefined
      ? "Review and approve the final diagrams before launching work in Codex."
      : undefined
  );

export const createScoutRuntime = (
  config: AppConfig = loadConfig(),
  dependencies: ScoutRuntimeDependencies = {}
): ScoutRuntime => {
  const app = express();
  const log =
    dependencies.logger ??
    (process.env.VITEST
      ? () => {}
      : (record: Record<string, unknown>) => {
          console.log(
            JSON.stringify({ timestamp: new Date().toISOString(), ...record })
          );
        });
  const metrics = {
    sessionsCreated: 0,
    sessionCreateFailures: 0,
    recallIntegrationErrors: 0,
    analysesStarted: 0,
    analysesCompleted: 0,
    analysesFailed: 0,
    analysisDurationMsTotal: 0
  };
  const store = dependencies.store ?? new SessionStore();
  const analyzer =
    dependencies.analyzer ??
    new CodexMeetingAnalyzer({
      client: new CodexAppServerClient({ command: config.codex.binary }),
      model: config.codex.model,
      effort: config.codex.reasoningEffort,
      structuredDiagnosis: config.codex.structuredDiagnosis ?? false
    });
  const coordinator = new AnalysisCoordinator(
    store,
    analyzer,
    config.analysisDelayMs,
    config.analysisRerunDelayMs,
    config.maxAutomaticAnalysisTurnsPerSession,
    config.analysisMaxBatchUtterances,
    config.analysisMaxBatchBytes,
    (record) =>
      {
        if (record.event === "analysis.started") metrics.analysesStarted += 1;
        if (record.event === "analysis.completed") {
          metrics.analysesCompleted += 1;
          metrics.analysisDurationMsTotal += Number(record.durationMs ?? 0);
        }
        if (record.event === "analysis.failed") metrics.analysesFailed += 1;
        log({
          level: record.event === "analysis.failed" ? "error" : "info",
          ...record
        });
      }
  );
  const handoffLauncher =
    dependencies.handoffLauncher ??
    new CodexHandoffLauncher({
      clientFactory: () =>
        new CodexAppServerClient({ command: config.codex.binary })
    });
  const recall =
    dependencies.recall ??
    (config.recall
      ? new RecallClient({
          apiBaseUrl: config.recall.apiBaseUrl,
          apiKey: config.recall.apiKey,
          workspaceVerificationSecret:
            config.recall.workspaceVerificationSecret,
          webhookVerificationMode: "workspace",
          outputMode: config.recall.outputMode,
          retry: {
            requestTimeoutMs: config.recall.requestTimeoutMs,
            maxAttempts: config.recall.maxRetries + 1
          }
        })
      : undefined);
  const statusRecall =
    dependencies.statusRecall ??
    (config.recall
      ? new RecallClient({
          apiBaseUrl: config.recall.apiBaseUrl,
          apiKey: config.recall.apiKey,
          workspaceVerificationSecret:
            config.recall.statusWebhookVerificationMode === "workspace"
              ? config.recall.statusWebhookSecret
              : undefined,
          legacySvixWebhookSecret:
            config.recall.statusWebhookVerificationMode === "svix"
              ? config.recall.statusWebhookSecret
              : undefined,
          webhookVerificationMode:
            config.recall.statusWebhookVerificationMode === "svix"
              ? "legacy-svix-dashboard"
              : "workspace",
          outputMode: config.recall.outputMode,
          retry: {
            requestTimeoutMs: config.recall.requestTimeoutMs,
            maxAttempts: config.recall.maxRetries + 1
          }
        })
      : recall);
  const sessionTokens = new Map<string, string>();
  const tokensBySession = new Map<string, string>();
  const whiteboardSessions = new Map<string, string>();
  const whiteboardIdsBySession = new Map<string, string>();
  const recallCorrelationIdsBySession = new Map<string, string>();
  const botSessions = new Map<string, string>();
  const pendingBotCreates = new Set<string>();
  const botCreateOperations = new Map<string, Promise<void>>();
  const retiringSessions = new Map<string, Promise<void>>();
  const processingTransitions = new Map<string, Promise<void>>();
  const resumingSessions = new Set<string>();
  const sessionEpochs = new Map<string, number>();
  const recallEventHighWater = new Map<string, number>();
  const participantEventHighWater = new Map<string, number>();
  const sseResponsesBySession = new Map<string, Set<Response>>();
  const rootDir = projectRoot();
  const handoffRootDir = dependencies.handoffRootDir ?? rootDir;
  const publicDir = path.join(rootDir, "public");
  let closing = false;

  const liveRecallConfigured = Boolean(recall && config.publicBaseUrl);
  const mode: ScoutReadiness["mode"] = liveRecallConfigured
    ? "live"
    : config.allowDevIngest
      ? "rehearsal"
      : "unavailable";
  let readinessCheck: Promise<ScoutReadiness> | undefined;
  let lastReadiness: { checkedAt: number; value: ScoutReadiness } | undefined;

  const checkDependency = async (
    dependency: { checkReadiness?(): Promise<DependencyReadiness> } | undefined,
    fallback: DependencyReadiness
  ): Promise<DependencyReadiness> => {
    if (!dependency?.checkReadiness) return fallback;
    let timeout: NodeJS.Timeout | undefined;
    try {
      const timedOut = new Promise<DependencyReadiness>((resolve) => {
        timeout = setTimeout(
          () => resolve({ ready: false, detail: "Readiness check timed out." }),
          15_000
        );
        timeout.unref();
      });
      const result = await Promise.race([
        dependency.checkReadiness(),
        timedOut
      ]);
      return result;
    } catch (error) {
      return {
        ready: false,
        detail: error instanceof Error ? error.message : String(error)
      };
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  };

  const readiness = async (): Promise<ScoutReadiness> => {
    if (lastReadiness && Date.now() - lastReadiness.checkedAt < 5_000) {
      return lastReadiness.value;
    }
    if (readinessCheck) return readinessCheck;
    readinessCheck = (async () => {
      const [codex, recallState] = await Promise.all([
        analyzer.resetSession
          ? checkDependency(analyzer, {
              ready: false,
              detail: "Codex readiness check is unavailable"
            })
          : Promise.resolve({
              ready: false,
              detail: "Codex analyzer cannot reset meeting threads"
            }),
        mode === "live"
          ? recall?.leaveBot
            ? checkDependency(recall, {
                ready: false,
                detail: "Recall readiness check is unavailable"
              })
            : Promise.resolve({
                ready: false,
                detail: "Recall bot retirement is unavailable"
              })
          : Promise.resolve({
              ready: mode === "rehearsal",
              detail:
                mode === "rehearsal"
                  ? "Recall bypassed in explicit rehearsal mode"
                  : "Recall and PUBLIC_API_BASE_URL are required"
            })
      ]);
      const value: ScoutReadiness = {
        ok: !closing && codex.ready && recallState.ready && mode !== "unavailable",
        mode,
        codex,
        recall: recallState
      };
      lastReadiness = { checkedAt: Date.now(), value };
      return value;
    })().finally(() => {
      readinessCheck = undefined;
    });
    return readinessCheck;
  };

  void readiness().then((state) => {
    log({
      level: state.ok ? "info" : "warn",
      event: "runtime.readiness",
      mode: state.mode,
      ready: state.ok,
      codexReady: state.codex.ready,
      recallReady: state.recall.ready
    });
  });

  const setListeningUnlessTerminal = (sessionId: string): void => {
    const status = store.getRequired(sessionId).status;
    if (status !== "ended" && status !== "error") {
      store.setStatus(sessionId, "listening");
    }
  };

  const activeSessionCount = (): number =>
    store
      .list()
      .filter((session) =>
        ["creating", "waiting_for_admission", "listening", "analyzing"].includes(
          session.status
        )
      ).length;

  const sseClientCount = (): number =>
    [...sseResponsesBySession.values()].reduce(
      (count, responses) => count + responses.size,
      0
    );

  const closeSessionStreams = (sessionId: string): void => {
    const responses = sseResponsesBySession.get(sessionId);
    if (!responses) return;
    sseResponsesBySession.delete(sessionId);
    for (const response of responses) {
      try {
        response.end();
      } catch {
        // The connection is already gone; retention/shutdown still proceeds.
      }
    }
  };

  const retireSession = (
    sessionId: string,
    reason: "retention" | "shutdown"
  ): Promise<void> => {
    const existingRetirement = retiringSessions.get(sessionId);
    if (existingRetirement) return existingRetirement;
    const snapshot = store.get(sessionId);
    if (!snapshot) return Promise.resolve();

    const operation = Promise.resolve()
      .then(async () => {
        closeSessionStreams(sessionId);
        // Invalidate webhook work that captured the previous epoch before the
        // retirement began. Deleting an epoch whose value was zero would fail
        // open because applyEvents deliberately defaults a missing epoch to 0.
        sessionEpochs.set(sessionId, (sessionEpochs.get(sessionId) ?? 0) + 1);
        pendingBotCreates.delete(sessionId);
        resumingSessions.delete(sessionId);
        recallEventHighWater.delete(sessionId);
        for (const key of participantEventHighWater.keys()) {
          if (key.startsWith(`${sessionId}:`)) {
            participantEventHighWater.delete(key);
          }
        }

        // A pause/resume transition owns the right to mutate the session until
        // it settles. Await it before deleting retained state so it cannot
        // resume later and write into a removed session.
        const transition = processingTransitions.get(sessionId);
        if (transition) await transition.catch(() => undefined);
        if (processingTransitions.get(sessionId) === transition) {
          processingTransitions.delete(sessionId);
        }

        const latestSnapshot = store.get(sessionId) ?? snapshot;
        const correlationId = recallCorrelationIdsBySession.get(sessionId);
        const botIds = latestSnapshot.recall.botId
          ? [latestSnapshot.recall.botId]
          : correlationId && recall?.findBotsByCorrelationId
            ? await recall.findBotsByCorrelationId(correlationId)
            : [];
        for (const botId of botIds) {
          if (recall?.leaveBot) {
            try {
              await recall.leaveBot(botId);
            } catch (error) {
              log({
                level: "warn",
                event: "recall.bot_retire_failed",
                sessionId,
                botId,
                detail: error instanceof Error ? error.message : String(error)
              });
              throw error;
            }
          }
          botSessions.delete(botId);
        }

        const token = tokensBySession.get(sessionId);
        if (token) sessionTokens.delete(token);
        tokensBySession.delete(sessionId);
        const whiteboardId = whiteboardIdsBySession.get(sessionId);
        if (whiteboardId) whiteboardSessions.delete(whiteboardId);
        whiteboardIdsBySession.delete(sessionId);
        recallCorrelationIdsBySession.delete(sessionId);
        coordinator.forgetSession(sessionId);
        store.delete(sessionId);
        sessionEpochs.delete(sessionId);
        log({ level: "info", event: "session.retired", sessionId, reason });
      })
      .catch((error) => {
        log({
          level: "error",
          event: "session.retire_failed",
          sessionId,
          reason,
          detail: error instanceof Error ? error.message : String(error)
        });
        throw error;
      })
      .finally(() => {
        if (retiringSessions.get(sessionId) === operation) {
          retiringSessions.delete(sessionId);
        }
      });
    retiringSessions.set(sessionId, operation);
    return operation;
  };

  const cleanupTimer = setInterval(() => {
    const cutoff = Date.now() - config.sessionRetentionMs;
    for (const snapshot of store.list()) {
      if (
        (snapshot.status === "ended" || snapshot.status === "error") &&
        snapshot.updatedAt <= cutoff
      ) {
        void retireSession(snapshot.id, "retention").catch(() => {
          // The retained session and bot mapping remain available for the next
          // cleanup pass, which retries retirement after transient failures.
        });
      }
    }
  }, Math.min(60_000, config.sessionRetentionMs));
  cleanupTimer.unref();

  const applyEvents = async (
    sessionId: string,
    events: NormalizedMeetingEvent[],
    expectedEpoch: number
  ): Promise<void> => {
    if ((sessionEpochs.get(sessionId) ?? 0) !== expectedEpoch) return;
    for (const event of events) {
      if (!store.get(sessionId)) return;
      if (
        store.getRequired(sessionId).processing.paused &&
        !resumingSessions.has(sessionId) &&
        (event.type === "transcript.partial" ||
          event.type === "transcript.final")
      ) {
        continue;
      }
      if (event.type === "participant.joined") {
        store.upsertParticipant(sessionId, {
          ...event.participant,
          present: event.participant.present ?? true
        });
        continue;
      }
      if (event.type === "participant.changed") {
        const occurredAt = safeOrderingTimestamp(event.occurredAt);
        const highWaterKey = `${sessionId}:${event.participant.id}`;
        const previous = participantEventHighWater.get(highWaterKey) ?? 0;
        if (occurredAt < previous) continue;
        participantEventHighWater.set(highWaterKey, occurredAt);
        store.upsertParticipant(sessionId, {
          ...event.participant,
          present: event.action === "left" ? false : (event.participant.present ?? true),
          ...(event.action === "left" ? { leftAt: occurredAt } : {})
        });
        continue;
      }
      if (event.type === "transcript.partial") {
        store.upsertParticipant(sessionId, {
          id: event.utterance.participantId,
          name: event.utterance.participantName,
          present: true
        });
        store.appendUtterance(sessionId, event.utterance);
        setListeningUnlessTerminal(sessionId);
        continue;
      }
      if (event.type === "transcript.final") {
        store.upsertParticipant(sessionId, {
          id: event.utterance.participantId,
          name: event.utterance.participantName,
          present: true
        });
        store.appendUtterance(sessionId, event.utterance);
        setListeningUnlessTerminal(sessionId);
        const current = store.getRequired(sessionId);
        if (current.status !== "ended" && current.status !== "error") {
          store.setRecall(sessionId, {
            ...current.recall,
            status: "active"
          });
        }
        coordinator.schedule(sessionId);
        continue;
      }
      if (event.type === "integration.error") {
        metrics.recallIntegrationErrors += 1;
        const occurredAt = safeOrderingTimestamp(event.occurredAt);
        const previous = recallEventHighWater.get(sessionId) ?? 0;
        if (occurredAt < previous) continue;
        recallEventHighWater.set(sessionId, occurredAt);
        const existing = store.getRequired(sessionId).recall;
        store.setRecall(sessionId, {
          ...existing,
          status: "error",
          detail: `${event.code}: ${event.detail}`,
          lastEventAt: occurredAt
        });
        if (event.fatal && store.getRequired(sessionId).status !== "ended") {
          store.setStatus(sessionId, "error");
        }
        log({
          level: event.fatal ? "error" : "warn",
          event: "recall.integration_error",
          sessionId,
          code: event.code,
          fatal: event.fatal
        });
        continue;
      }
      const occurredAt = safeOrderingTimestamp(event.occurredAt);
      const previous = recallEventHighWater.get(sessionId) ?? 0;
      if (occurredAt < previous) continue;
      const currentStatus = store.getRequired(sessionId).status;
      if (
        (currentStatus === "error" && event.status !== "error") ||
        (currentStatus === "ended" &&
          event.status !== "ended" &&
          event.status !== "error")
      ) {
        continue;
      }
      recallEventHighWater.set(sessionId, occurredAt);
      store.setStatus(sessionId, sessionStatusFromBot(event.status));
      const existing = store.getRequired(sessionId).recall;
      store.setRecall(sessionId, {
        ...existing,
        status: integrationStatusFromBot(event.status),
        detail: event.detail,
        lastEventAt: occurredAt
      });
      if (event.status === "ended") coordinator.schedule(sessionId);
    }
  };

  const enqueueProcessingOperation = (
    sessionId: string,
    operation: () => void | Promise<void>
  ): Promise<void> => {
    const previous = processingTransitions.get(sessionId) ?? Promise.resolve();
    const transition = previous
      .catch(() => undefined)
      .then(operation);
    processingTransitions.set(sessionId, transition);
    void transition.then(
      () => {
        if (processingTransitions.get(sessionId) === transition) {
          processingTransitions.delete(sessionId);
        }
      },
      () => {
        if (processingTransitions.get(sessionId) === transition) {
          processingTransitions.delete(sessionId);
        }
      }
    );
    return transition;
  };

  const transitionProcessing = (
    sessionId: string,
    paused: boolean
  ): Promise<void> =>
    enqueueProcessingOperation(sessionId, async () => {
      const current = store.getRequired(sessionId);
      if (current.processing.paused === paused) return;
      const acceptsDuringResume =
        !paused && Boolean(recall && current.recall.botId) && current.status !== "ended";
      if (acceptsDuringResume) resumingSessions.add(sessionId);
      try {
        if (recall && current.recall.botId && current.status !== "ended") {
          if (paused) await recall.pauseRecording(current.recall.botId);
          else await recall.resumeRecording(current.recall.botId);
        }

        store.setProcessingPaused(sessionId, paused);
        coordinator.setPaused(sessionId, paused);
        const nextRecall = store.getRequired(sessionId).recall;
        store.setRecall(sessionId, {
          ...nextRecall,
          detail: current.status === "ended"
            ? paused
              ? "Post-meeting processing paused"
              : "Post-meeting processing enabled for pending finalized evidence"
            : current.recall.botId
            ? paused
              ? "Recording and real-time transcription paused"
              : "Recording and real-time transcription active"
            : paused
              ? "Server processing paused; waiting for an active Recall bot"
              : "Live server processing active; waiting for an active Recall bot"
        });
      } finally {
        if (acceptsDuringResume) resumingSessions.delete(sessionId);
      }
    });

  const dynamicWebhook: RequestHandler = (
    request: Request,
    response: Response,
    next: NextFunction
  ) => {
    if (!recall) {
      response.status(503).json({ error: "Recall is not configured" });
      return;
    }
    const sessionId = sessionTokens.get(routeParam(request.params.sessionToken));
    if (!sessionId) {
      response.status(404).json({ error: "unknown webhook token" });
      return;
    }
    const expectedEpoch = sessionEpochs.get(sessionId) ?? 0;
    createRecallWebhookHandler({
      adapter: recall,
      onEvents: (events) => applyEvents(sessionId, events, expectedEpoch),
      onAsyncError: (error) => {
        if ((sessionEpochs.get(sessionId) ?? 0) !== expectedEpoch) return;
        const message = error instanceof Error ? error.message : String(error);
        store.setRecall(sessionId, { status: "error", detail: message });
      }
    })(request, response, next);
  };

  const statusWebhook: RequestHandler = (
    request: Request,
    response: Response,
    next: NextFunction
  ) => {
    if (!statusRecall) {
      response.status(503).json({ error: "Recall is not configured" });
      return;
    }
    const expectedEpochs = new Map(sessionEpochs);
    createRecallWebhookHandler({
      adapter: statusRecall,
      onEvents: async (events) => {
        const grouped = new Map<string, NormalizedMeetingEvent[]>();
        for (const event of events) {
          if (
            (event.type !== "bot.status" && event.type !== "integration.error") ||
            !event.botId
          ) {
            continue;
          }
          const sessionId = botSessions.get(event.botId);
          if (!sessionId) {
            // Recall can publish status before the create-bot response reaches
            // Scout. Ask it to retry while any create is in flight so that the
            // event is not acknowledged and permanently lost in that window.
            if (pendingBotCreates.size > 0) {
              throw new Error(
                `Recall status arrived before bot ${event.botId} was mapped to its session.`
              );
            }
            continue;
          }
          const group = grouped.get(sessionId) ?? [];
          group.push(event);
          grouped.set(sessionId, group);
        }
        for (const [sessionId, sessionEvents] of grouped) {
          await applyEvents(
            sessionId,
            sessionEvents,
            expectedEpochs.get(sessionId) ?? 0
          );
        }
      }
    })(request, response, next);
  };

  app.post("/webhooks/recall/status", recallRawJsonBody, statusWebhook);
  app.post(
    "/webhooks/recall/:sessionToken",
    recallRawJsonBody,
    dynamicWebhook
  );

  app.use(express.json({ limit: "1mb" }));
  app.use(
    "/vendor/mermaid",
    express.static(path.join(rootDir, "node_modules/mermaid/dist"), {
      setHeaders: (response) => response.setHeader("Cache-Control", "no-store")
    })
  );
  app.use(
    express.static(publicDir, {
      setHeaders: (response) => response.setHeader("Cache-Control", "no-store")
    })
  );

  app.get("/livez", (_request, response) => {
    response.status(closing ? 503 : 200).json({ ok: !closing });
  });

  const readinessHandler: RequestHandler = async (_request, response) => {
    const state = await readiness();
    response.status(state.ok ? 200 : 503).json(state);
  };
  app.get("/readyz", readinessHandler);
  app.get("/health", readinessHandler);
  app.get("/metrics", async (_request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.json({
      ...metrics,
      activeSessions: activeSessionCount(),
      retainedSessions: store.list().length,
      sseClients: sseClientCount(),
      readiness: await readiness()
    });
  });

  app.post("/api/sessions", async (request, response) => {
    const meetingUrl =
      typeof request.body?.meetingUrl === "string"
        ? request.body.meetingUrl.trim()
        : "";
    try {
      const url = new URL(meetingUrl);
      if (url.protocol !== "https:") throw new Error("not https");
    } catch {
      response.status(400).json({ error: "a valid HTTPS meetingUrl is required" });
      return;
    }

    const ready = await readiness();
    if (!ready.ok) {
      response.status(503).json({
        error: "Scout is not ready to create a session",
        readiness: ready
      });
      return;
    }

    if (activeSessionCount() >= config.maxActiveSessions) {
      response.status(429).json({
        error: `active session limit reached (${config.maxActiveSessions})`
      });
      return;
    }

    const snapshot = store.create(meetingUrl);
    sessionEpochs.set(snapshot.id, 0);
    const sessionToken = randomBytes(24).toString("base64url");
    const whiteboardId = randomBytes(24).toString("base64url");
    sessionTokens.set(sessionToken, snapshot.id);
    tokensBySession.set(snapshot.id, sessionToken);
    whiteboardSessions.set(whiteboardId, snapshot.id);
    whiteboardIdsBySession.set(snapshot.id, whiteboardId);

    if (mode === "rehearsal") {
      store.setRecall(snapshot.id, {
        status: "idle",
        detail: "Explicit rehearsal mode; use finalized dev ingest"
      });
      store.setStatus(snapshot.id, "listening");
      metrics.sessionsCreated += 1;
      log({ level: "info", event: "session.created", sessionId: snapshot.id, mode });
      response.status(201).json({
        sessionId: snapshot.id,
        operatorUrl: `/operator/${snapshot.id}`,
        whiteboardUrl: `/whiteboard/${whiteboardId}`,
        mode
      });
      return;
    }

    if (!recall || !config.publicBaseUrl) {
      sessionTokens.delete(sessionToken);
      tokensBySession.delete(snapshot.id);
      whiteboardSessions.delete(whiteboardId);
      whiteboardIdsBySession.delete(snapshot.id);
      sessionEpochs.delete(snapshot.id);
      store.delete(snapshot.id);
      response.status(503).json({ error: "Recall live mode is not configured" });
      return;
    }

    const correlationId = randomBytes(24).toString("base64url");
    // A per-session nonce makes the provider-side display name unpredictable
    // before the bot joins. Recall participant events do not carry a trusted
    // "this is your bot" marker, so the adapter locks the first exact match to
    // this unique name and rejects later same-name human participants as bots.
    const botName = `${RECALL_BOT_NAME} · ${randomBytes(8).toString("base64url")}`;
    recallCorrelationIdsBySession.set(snapshot.id, correlationId);

    store.setRecall(snapshot.id, {
      status: "connecting",
      detail: `Creating bot in ${config.recall?.region ?? "configured"} region`
    });
    pendingBotCreates.add(snapshot.id);
    let finishCreateOperation!: () => void;
    const createOperation = new Promise<void>((resolve) => {
      finishCreateOperation = resolve;
    });
    botCreateOperations.set(snapshot.id, createOperation);
    try {
      const { botId } = await recall.createBot({
        meetingUrl,
        botName,
        publicBaseUrl: config.publicBaseUrl,
        sessionId: snapshot.id,
        correlationId,
        sessionToken,
        whiteboardId
      });
      if (closing && store.get(snapshot.id)) {
        botSessions.set(botId, snapshot.id);
        store.setRecall(snapshot.id, {
          status: "error",
          botId,
          detail: "Scout began shutting down while Recall created the bot"
        });
        store.setStatus(snapshot.id, "error");
        metrics.sessionCreateFailures += 1;
        log({
          level: "warn",
          event: "session.create_aborted",
          sessionId: snapshot.id,
          botId,
          reason: "runtime closing"
        });
        response.status(503).json({ error: "Scout is shutting down" });
        return;
      }
      if (!store.get(snapshot.id)) {
        await recall.leaveBot?.(botId);
        response.status(503).json({ error: "Scout session is no longer available" });
        return;
      }
      botSessions.set(botId, snapshot.id);
      store.setRecall(snapshot.id, {
        status: "waiting",
        botId,
        detail: "Waiting for host admission"
      });
      store.setStatus(snapshot.id, "waiting_for_admission");
      metrics.sessionsCreated += 1;
      log({
        level: "info",
        event: "session.created",
        sessionId: snapshot.id,
        botId,
        mode
      });
      response.status(201).json({
        sessionId: snapshot.id,
        operatorUrl: `/operator/${snapshot.id}`,
        whiteboardUrl: `/whiteboard/${whiteboardId}`,
        mode
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      metrics.sessionCreateFailures += 1;
      if (
        error instanceof RecallBotCreationAmbiguousError &&
        store.get(snapshot.id)
      ) {
        store.setRecall(snapshot.id, {
          status: "error",
          detail: message
        });
        store.setStatus(snapshot.id, "error");
        log({
          level: "error",
          event: "session.create_ambiguous",
          sessionId: snapshot.id,
          correlationId: error.correlationId,
          detail: message
        });
        response.status(502).json({
          error: message,
          sessionId: snapshot.id,
          operatorUrl: `/operator/${snapshot.id}`,
          whiteboardUrl: `/whiteboard/${whiteboardId}`,
          cleanupPending: true
        });
        return;
      }
      sessionTokens.delete(sessionToken);
      tokensBySession.delete(snapshot.id);
      whiteboardSessions.delete(whiteboardId);
      whiteboardIdsBySession.delete(snapshot.id);
      recallCorrelationIdsBySession.delete(snapshot.id);
      sessionEpochs.delete(snapshot.id);
      coordinator.forgetSession(snapshot.id);
      store.delete(snapshot.id);
      log({
        level: "error",
        event: "session.create_failed",
        sessionId: snapshot.id,
        detail: message
      });
      response.status(502).json({ error: `Recall bot creation failed: ${message}` });
    } finally {
      pendingBotCreates.delete(snapshot.id);
      botCreateOperations.delete(snapshot.id);
      finishCreateOperation();
    }
  });

  app.get("/api/sessions/:sessionId", (request, response) => {
    const snapshot = store.get(request.params.sessionId);
    if (!snapshot) {
      response.status(404).json({ error: "session not found" });
      return;
    }
    response.setHeader("Cache-Control", "no-store");
    response.json(snapshot);
  });

  app.get("/api/reviews/:sessionId", (request, response) => {
    const snapshot = store.get(routeParam(request.params.sessionId));
    if (!snapshot) {
      response.status(404).json({ error: "session not found" });
      return;
    }
    response.setHeader("Cache-Control", "no-store");
    response.json({
      ...snapshot,
      postCallReady: postCallBlocker(snapshot) === undefined,
      postCallBlocker: postCallBlocker(snapshot)
    });
  });

  app.put("/api/reviews/:sessionId", (request, response) => {
    const sessionId = routeParam(request.params.sessionId);
    const snapshot = store.get(sessionId);
    if (!snapshot) {
      response.status(404).json({ error: "session not found" });
      return;
    }
    const blocker = postCallBlocker(snapshot);
    if (blocker) {
      response.status(409).json({ error: blocker, current: snapshot });
      return;
    }
    const parsed = PostCallEditSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({
        error: "The post-call edit is not a valid complete graph snapshot.",
        issues: parsed.error.issues
      });
      return;
    }
    const finalizedIds = new Set(
      snapshot.utterances
        .filter((utterance) => utterance.finalized)
        .map((utterance) => utterance.id)
    );
    const customerParticipantIds = new Set(
      snapshot.participants
        .filter((participant) => participant.role === "customer")
        .map((participant) => participant.id)
    );
    const customerUtteranceIds = new Set(
      snapshot.utterances
        .filter(
          (utterance) =>
            utterance.finalized &&
            customerParticipantIds.has(utterance.participantId)
        )
        .map((utterance) => utterance.id)
    );
    const graphErrors = [
      ...validateGraphReferences(parsed.data.graph, finalizedIds),
      ...validateCustomerEvidence(parsed.data.graph, customerUtteranceIds, {
        allowPostCallEditorial: true
      })
    ];
    if (graphErrors.length > 0) {
      response.status(422).json({
        error: "The edited graph failed its evidence or semantic checks.",
        issues: graphErrors
      });
      return;
    }
    let annotations: PostCallReviewState["annotations"];
    try {
      annotations = normalizeReviewAnnotations(
        parsed.data.graph,
        parsed.data.annotations
      );
    } catch (error) {
      response.status(422).json({
        error: "A review annotation does not match the edited graph.",
        issues: [error instanceof Error ? error.message : String(error)]
      });
      return;
    }
    try {
      const updated = store.editPostCall(
        sessionId,
        parsed.data.expectedRevision,
        parsed.data.graph,
        parsed.data.notes,
        annotations
      );
      response.setHeader("Cache-Control", "no-store");
      response.json({
        ...updated,
        postCallReady: true
      });
    } catch (error) {
      if (error instanceof SessionRevisionConflictError) {
        response.status(409).json({
          error: error.message,
          current: store.getRequired(sessionId)
        });
        return;
      }
      response.status(409).json({
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  app.get("/api/handoffs/:sessionId", (request, response) => {
    const snapshot = store.get(routeParam(request.params.sessionId));
    if (!snapshot) {
      response.status(404).json({ error: "session not found" });
      return;
    }
    const blocker = handoffBlocker(snapshot);
    response.setHeader("Cache-Control", "no-store");
    if (blocker) {
      response.json({ ready: false, blocker });
      return;
    }
    response.json({ ready: true, package: buildCodexHandoffPackage(snapshot) });
  });

  app.get("/api/handoffs/:sessionId/download", (request, response) => {
    const snapshot = store.get(routeParam(request.params.sessionId));
    if (!snapshot) {
      response.status(404).json({ error: "session not found" });
      return;
    }
    const blocker = handoffBlocker(snapshot);
    if (blocker) {
      response.status(409).json({ error: blocker });
      return;
    }
    const handoff = buildCodexHandoffPackage(snapshot);
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader(
      "Content-Disposition",
      `attachment; filename="scout-${snapshot.id.slice(0, 8)}-package.json"`
    );
    response.send(`${JSON.stringify(handoff, null, 2)}\n`);
  });

  const launchCodexHandoff: RequestHandler = async (request, response) => {
    const sessionId = routeParam(request.params.sessionId);
    const snapshot = store.get(sessionId);
    if (!snapshot) {
      response.status(404).json({ error: "session not found" });
      return;
    }
    const blocker = handoffBlocker(snapshot);
    if (blocker) {
      response.status(409).json({ error: blocker });
      return;
    }
    const parsed = HandoffPrepareSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({
        error: "Expected graph and review revisions are required before Scout launches Codex work."
      });
      return;
    }
    if (
      parsed.data.expectedGraphRevision !== snapshot.revision ||
      parsed.data.expectedReviewRevision !== snapshot.postCall.revision
    ) {
      response.status(409).json({
        error: "The reviewed package changed. Reload and inspect the latest revision before launching Codex."
      });
      return;
    }
    try {
      const prepared = await handoffLauncher.launch(handoffRootDir, snapshot);
      log({
        level: "info",
        event: "codex.handoff_launched",
        sessionId,
        directory: prepared.directory,
        leadThreadId: prepared.lead.threadId,
        taskCount: prepared.tasks.length,
        reviewRevision: snapshot.postCall.revision
      });
      response.setHeader("Cache-Control", "no-store");
      response.status(201).json(prepared);
    } catch (error) {
      log({
        level: "error",
        event: "codex.handoff_launch_failed",
        sessionId,
        detail: error instanceof Error ? error.message : String(error)
      });
      response.status(500).json({
        error: "Scout could not launch the approved work in Codex."
      });
    }
  };
  app.post("/api/handoffs/:sessionId/launch", launchCodexHandoff);
  // Kept as a compatibility alias for older Scout clients. Both routes launch
  // the reviewed revision; neither returns a draft-only deep link.
  app.post("/api/handoffs/:sessionId/prepare", launchCodexHandoff);

  app.get("/api/whiteboards/:whiteboardId", (request, response) => {
    const whiteboardId = routeParam(request.params.whiteboardId);
    const sessionId = whiteboardSessions.get(whiteboardId);
    const snapshot = sessionId ? store.get(sessionId) : undefined;
    if (!snapshot) {
      response.status(404).json({ error: "session not found" });
      return;
    }
    response.setHeader("Cache-Control", "no-store");
    response.json(toWhiteboardSnapshot(snapshot, whiteboardId));
  });

  app.put("/api/sessions/:sessionId/processing", async (request, response) => {
    const sessionId = routeParam(request.params.sessionId);
    if (!store.get(sessionId)) {
      response.status(404).json({ error: "session not found" });
      return;
    }
    const parsed = ProcessingStateSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: "paused must be a boolean" });
      return;
    }
    try {
      await transitionProcessing(sessionId, parsed.data.paused);
      response.setHeader("Cache-Control", "no-store");
      response.json(store.getRequired(sessionId));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      response.status(502).json({ error: message });
    }
  });

  app.put("/api/sessions/:sessionId/operator", async (request, response) => {
    const sessionId = request.params.sessionId;
    const snapshot = store.get(sessionId);
    if (!snapshot) {
      response.status(404).json({ error: "session not found" });
      return;
    }
    if (snapshot.status === "ended") {
      response.status(409).json({
        error: "Operator identity is locked after the meeting ends. Start a new review if attribution must be corrected."
      });
      return;
    }
    const parsed = OperatorSelectionSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: "participantId is required" });
      return;
    }
    let updated: SessionSnapshot;
    try {
      updated = store.selectOperator(
        sessionId,
        parsed.data.participantId
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      response.status(400).json({ error: message });
      return;
    }
    try {
      const previousRoleRevision = snapshot.roleRevision;
      if (
        updated.roleRevision !== previousRoleRevision ||
        coordinator.needsRoleReset(sessionId)
      ) {
        await coordinator.rolesChanged(sessionId);
      } else {
        coordinator.schedule(sessionId);
      }
      response.setHeader("Cache-Control", "no-store");
      response.json(store.getRequired(sessionId));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      response.status(409).json({ error: message });
    }
  });

  app.post("/api/sessions/:sessionId/analyze", (request, response) => {
    const snapshot = store.get(request.params.sessionId);
    if (!snapshot) {
      response.status(404).json({ error: "session not found" });
      return;
    }
    const blocker = coordinator.manualBlocker(request.params.sessionId);
    if (blocker) {
      response.status(409).json({ error: blocker });
      return;
    }
    void coordinator.analyzeNow(request.params.sessionId);
    response.status(202).json({ accepted: true });
  });

  app.post("/api/sessions/:sessionId/reset", async (request, response) => {
    const sessionId = request.params.sessionId;
    if (!store.get(sessionId)) {
      response.status(404).json({ error: "session not found" });
      return;
    }

    sessionEpochs.set(sessionId, (sessionEpochs.get(sessionId) ?? 0) + 1);
    try {
      await enqueueProcessingOperation(sessionId, async () => {
        const retirement = coordinator.resetSession(sessionId);
        store.resetContext(sessionId);
        await retirement;
      });
      response.setHeader("Cache-Control", "no-store");
      response.json(store.getRequired(sessionId));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      response.status(500).json({ error: message });
    }
  });

  if (mode === "rehearsal") {
    app.post("/api/dev/sessions/:sessionId/utterances", (request, response) => {
      if (!store.get(request.params.sessionId)) {
        response.status(404).json({ error: "session not found" });
        return;
      }
      if (store.getRequired(request.params.sessionId).processing.paused) {
        response.status(409).json({
          error: "live processing is paused; incoming utterances are discarded"
        });
        return;
      }
      const parsed = DevUtteranceSchema.safeParse(request.body);
      if (!parsed.success) {
        response.status(400).json({ error: "invalid finalized utterance" });
        return;
      }
      if (
        Buffer.byteLength(parsed.data.text, "utf8") >
        config.analysisMaxBatchBytes
      ) {
        response.status(413).json({
          error: `utterance exceeds the ${config.analysisMaxBatchBytes}-byte analysis limit`
        });
        return;
      }
      store.upsertParticipant(request.params.sessionId, {
        id: parsed.data.participantId,
        name: parsed.data.participantName,
        isBot: false,
        present: true
      });
      const snapshot = store.appendUtterance(
        request.params.sessionId,
        parsed.data
      );
      coordinator.schedule(request.params.sessionId);
      response.status(202).json(snapshot);
    });
  }

  const streamSession = (
    request: Request,
    response: Response,
    eventName: "session" | "whiteboard",
    resolvedSessionId?: string,
    whiteboardId?: string
  ): void => {
    const sessionId = resolvedSessionId ?? routeParam(request.params.sessionId);
    if (!store.get(sessionId)) {
      response.status(404).end();
      return;
    }
    const sessionConnectionCount = sseResponsesBySession.get(sessionId)?.size ?? 0;
    if (
      sseClientCount() >= config.maxSseConnections ||
      sessionConnectionCount >= config.maxSseConnectionsPerSession
    ) {
      response.setHeader("Retry-After", "5");
      response.status(429).json({ error: "SSE connection limit reached" });
      return;
    }

    response.status(200);
    response.setHeader("Content-Type", "text/event-stream");
    response.setHeader("Cache-Control", "no-cache, no-transform");
    response.setHeader("Connection", "keep-alive");
    response.setHeader("X-Accel-Buffering", "no");
    response.flushHeaders();
    const sessionResponses =
      sseResponsesBySession.get(sessionId) ?? new Set<Response>();
    sessionResponses.add(response);
    sseResponsesBySession.set(sessionId, sessionResponses);

    let closed = false;
    let blocked = false;
    let pendingFrame: string | undefined;
    type StreamSnapshot = SessionSnapshot | WhiteboardSnapshot;
    let queuedSnapshot: StreamSnapshot | undefined;
    let coalesceTimer: NodeJS.Timeout | undefined;
    let lastWhiteboardSignature: string | undefined;
    let publishedInitial = false;
    let unsubscribe = (): void => {};

    const writeFrame = (frame: string): void => {
      if (closed) return;
      if (blocked) {
        pendingFrame = frame;
        return;
      }
      try {
        blocked = !response.write(frame);
      } catch {
        cleanup();
      }
    };

    const publish = (snapshot: StreamSnapshot): void => {
      if (eventName === "whiteboard") {
        const projected = {
          ...(snapshot as WhiteboardSnapshot),
          id: whiteboardId ?? (snapshot as WhiteboardSnapshot).id
        };
        const signature = JSON.stringify({
          revision: projected.revision,
          roleRevision: projected.roleRevision,
          status: projected.status,
          analysis: projected.analysis.status,
          paused: projected.processing.paused
        });
        if (signature === lastWhiteboardSignature) return;
        lastWhiteboardSignature = signature;
        writeFrame(`event: whiteboard\ndata: ${JSON.stringify(projected)}\n\n`);
        return;
      }
      writeFrame(`event: session\ndata: ${JSON.stringify(snapshot)}\n\n`);
    };

    const queuePublish = (snapshot: StreamSnapshot): void => {
      if (!publishedInitial) {
        publishedInitial = true;
        publish(snapshot);
        return;
      }
      queuedSnapshot = snapshot;
      if (coalesceTimer) return;
      coalesceTimer = setTimeout(() => {
        coalesceTimer = undefined;
        const next = queuedSnapshot;
        queuedSnapshot = undefined;
        if (next) publish(next);
      }, 50);
      coalesceTimer.unref();
    };

    const heartbeat = setInterval(() => {
      if (!blocked) writeFrame(": heartbeat\n\n");
    }, 15_000);
    heartbeat.unref();

    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      if (coalesceTimer) clearTimeout(coalesceTimer);
      unsubscribe();
      const responses = sseResponsesBySession.get(sessionId);
      responses?.delete(response);
      if (responses?.size === 0) sseResponsesBySession.delete(sessionId);
    };

    response.on("drain", () => {
      blocked = false;
      const frame = pendingFrame;
      pendingFrame = undefined;
      if (frame) writeFrame(frame);
    });
    request.once("close", cleanup);
    response.once("close", cleanup);
    unsubscribe = eventName === "whiteboard"
      ? store.subscribeWhiteboard(sessionId, queuePublish)
      : store.subscribe(sessionId, queuePublish);
  };

  app.get("/events/:sessionId", (request, response) => {
    streamSession(request, response, "session");
  });

  app.get("/events/whiteboards/:whiteboardId", (request, response) => {
    const whiteboardId = routeParam(request.params.whiteboardId);
    const sessionId = whiteboardSessions.get(whiteboardId);
    if (!sessionId) {
      response.status(404).end();
      return;
    }
    streamSession(request, response, "whiteboard", sessionId, whiteboardId);
  });

  app.get("/operator/:sessionId", (_request, response) => {
    response.sendFile(path.join(publicDir, "operator.html"));
  });

  app.get("/whiteboard/:sessionId", (_request, response) => {
    response.sendFile(path.join(publicDir, "whiteboard.html"));
  });

  app.get("/review/:sessionId", (_request, response) => {
    response.sendFile(path.join(publicDir, "whiteboard.html"));
  });

  app.get("/handoff/:sessionId", (_request, response) => {
    response.sendFile(path.join(publicDir, "handoff.html"));
  });

  app.use(
    (
      error: unknown,
      request: Request,
      response: Response,
      next: NextFunction
    ): void => {
      if (response.headersSent) {
        next(error);
        return;
      }
      const candidateStatus =
        error && typeof error === "object" && "status" in error
          ? Number((error as { status?: unknown }).status)
          : Number.NaN;
      const status =
        Number.isInteger(candidateStatus) &&
        candidateStatus >= 400 &&
        candidateStatus < 500
          ? candidateStatus
          : 500;
      log({
        level: status >= 500 ? "error" : "warn",
        event: "http.request_rejected",
        method: request.method,
        status,
        errorType: error instanceof Error ? error.name : typeof error
      });
      response.status(status).json({
        error:
          status === 413
            ? "request body too large"
            : status < 500
              ? "invalid request body"
              : "internal server error"
      });
    }
  );

  let closePromise: Promise<void> | undefined;
  const closeRuntime = (): Promise<void> => {
    if (closePromise) return closePromise;
    closing = true;
    lastReadiness = undefined;
    clearInterval(cleanupTimer);
    for (const sessionId of [...sseResponsesBySession.keys()]) {
      closeSessionStreams(sessionId);
    }

    const shutdownDeadlineAt = Date.now() + config.shutdownGraceMs;
    const quiesceTasks = [
      ...processingTransitions.values(),
      ...retiringSessions.values(),
      ...botCreateOperations.values()
    ];
    const collectFailures = (
      failures: unknown[],
      results: PromiseSettledResult<unknown>[]
    ): void => {
      failures.push(
        ...results
          .filter(
            (result): result is PromiseRejectedResult =>
              result.status === "rejected"
          )
          .map((result) => result.reason)
      );
    };
    const retryRetirement = async (sessionId: string): Promise<void> => {
      let lastFailure: unknown;
      while (Date.now() < shutdownDeadlineAt) {
        try {
          await retireSession(sessionId, "shutdown");
          return;
        } catch (error) {
          lastFailure = error;
          const remainingMs = shutdownDeadlineAt - Date.now();
          if (remainingMs <= 10) break;
          await new Promise<void>((resolve) => {
            const retryTimer = setTimeout(resolve, Math.min(250, remainingMs - 5));
            retryTimer.unref();
          });
        }
      }
      throw lastFailure ?? new Error(`Unable to retire session ${sessionId}.`);
    };
    const shutdownWork = (async () => {
      const failures: unknown[] = [];
      collectFailures(failures, await Promise.allSettled(quiesceTasks));
      collectFailures(
        failures,
        await Promise.allSettled([
          ...store.list().map((snapshot) => retryRetirement(snapshot.id)),
          coordinator.close(),
          handoffLauncher.close()
        ])
      );
      if (failures.length > 0) {
        throw new AggregateError(failures, "Scout shutdown cleanup failed");
      }
      sessionTokens.clear();
      tokensBySession.clear();
      whiteboardSessions.clear();
      whiteboardIdsBySession.clear();
      recallCorrelationIdsBySession.clear();
      botSessions.clear();
      pendingBotCreates.clear();
      botCreateOperations.clear();
      resumingSessions.clear();
      sessionEpochs.clear();
      recallEventHighWater.clear();
      participantEventHighWater.clear();
    })();

    closePromise = new Promise<void>((resolve, reject) => {
      let finished = false;
      const finish = (error?: unknown): void => {
        if (finished) return;
        finished = true;
        clearTimeout(deadline);
        if (error === undefined) resolve();
        else reject(error);
      };
      const deadline = setTimeout(() => {
        log({
          level: "warn",
          event: "runtime.shutdown_deadline_exceeded",
          graceMs: config.shutdownGraceMs,
          pendingProcessingTransitions: processingTransitions.size,
          pendingBotCreates: botCreateOperations.size,
          pendingRetirements: retiringSessions.size
        });
        finish(
          new Error(
            `Scout shutdown exceeded the ${config.shutdownGraceMs}ms cleanup deadline.`
          )
        );
      }, config.shutdownGraceMs);
      void shutdownWork.then(() => finish(), finish);
    });
    return closePromise;
  };

  return {
    app,
    config,
    store,
    coordinator,
    readiness,
    close: closeRuntime
  };
};

export const startScoutServer = (
  config: AppConfig = loadConfig()
): { runtime: ScoutRuntime; server: Server } => {
  const runtime = createScoutRuntime(config);
  const server = runtime.app.listen(config.port, config.host, () => {
    console.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "info",
      event: "server.listening",
      host: config.host,
      port: config.port,
      recallRegion: config.recall?.region ?? "not configured"
    }));
  });
  return { runtime, server };
};

const isEntrypoint =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isEntrypoint) {
  const { runtime, server } = startScoutServer();
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    const serverClosed = once(server, "close");
    server.close();
    const deadline = setTimeout(() => {
      server.closeAllConnections();
      console.error(JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "warn",
        event: "server.shutdown_deadline_exceeded",
        graceMs: runtime.config.shutdownGraceMs
      }));
      process.exit(1);
    }, runtime.config.shutdownGraceMs);
    void Promise.all([serverClosed, runtime.close()])
      .then(() => {
        clearTimeout(deadline);
        process.exit(0);
      })
      .catch((error: unknown) => {
        clearTimeout(deadline);
        console.error(JSON.stringify({
          timestamp: new Date().toISOString(),
          level: "error",
          event: "server.shutdown_failed",
          detail: error instanceof Error ? error.message : String(error)
        }));
        process.exit(1);
      });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
