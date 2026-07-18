import express, {
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response
} from "express";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Server } from "node:http";
import { z } from "zod";
import { AnalysisCoordinator } from "./analysis-coordinator.js";
import { loadConfig, type AppConfig } from "./config.js";
import type {
  MeetingAnalyzer,
  NormalizedMeetingEvent,
  RecallAdapter
} from "./contracts.js";
import {
  CodexAppServerClient,
  CodexMeetingAnalyzer
} from "./codex/index.js";
import {
  createRecallWebhookHandler,
  RecallClient,
  recallRawJsonBody
} from "./recall/index.js";
import { SessionStore } from "./session-store.js";
import { toWhiteboardSnapshot } from "../shared/types.js";

const DevUtteranceSchema = z
  .object({
    id: z.string().min(1),
    sequence: z.number().int().nonnegative(),
    participantId: z.string().min(1),
    participantName: z.string().min(1),
    text: z.string().min(1),
    startedAt: z.number(),
    endedAt: z.number(),
    finalized: z.literal(true)
  })
  .strict();

export interface ScoutRuntimeDependencies {
  analyzer?: MeetingAnalyzer;
  recall?: RecallAdapter;
  statusRecall?: RecallAdapter;
  store?: SessionStore;
}

export interface ScoutRuntime {
  app: express.Express;
  config: AppConfig;
  store: SessionStore;
  coordinator: AnalysisCoordinator;
  close(): Promise<void>;
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

const publicDirectory = (): string => path.resolve(process.cwd(), "public");

const routeParam = (value: string | string[] | undefined): string =>
  Array.isArray(value) ? (value[0] ?? "") : (value ?? "");

export const createScoutRuntime = (
  config: AppConfig = loadConfig(),
  dependencies: ScoutRuntimeDependencies = {}
): ScoutRuntime => {
  const app = express();
  const store = dependencies.store ?? new SessionStore();
  const analyzer =
    dependencies.analyzer ??
    new CodexMeetingAnalyzer({
      client: new CodexAppServerClient({ command: config.codex.binary }),
      model: config.codex.model,
      effort: config.codex.reasoningEffort
    });
  const coordinator = new AnalysisCoordinator(
    store,
    analyzer,
    config.analysisDelayMs,
    config.analysisRerunDelayMs
  );
  const recall =
    dependencies.recall ??
    (config.recall
      ? new RecallClient({
          apiBaseUrl: config.recall.apiBaseUrl,
          apiKey: config.recall.apiKey,
          webhookSecret: config.recall.workspaceVerificationSecret,
          outputMode: config.recall.outputMode
        })
      : undefined);
  const statusRecall =
    dependencies.statusRecall ??
    (config.recall
      ? new RecallClient({
          apiBaseUrl: config.recall.apiBaseUrl,
          apiKey: config.recall.apiKey,
          webhookSecret: config.recall.statusWebhookSecret,
          outputMode: config.recall.outputMode
        })
      : recall);
  const sessionTokens = new Map<string, string>();
  const botSessions = new Map<string, string>();
  const publicDir = publicDirectory();

  const applyEvents = async (
    sessionId: string,
    events: NormalizedMeetingEvent[]
  ): Promise<void> => {
    for (const event of events) {
      if (event.type === "participant.joined") {
        store.upsertParticipant(sessionId, event.participant);
        continue;
      }
      if (event.type === "transcript.final") {
        store.upsertParticipant(sessionId, {
          id: event.utterance.participantId,
          name: event.utterance.participantName
        });
        store.appendUtterance(sessionId, event.utterance);
        store.setStatus(sessionId, "listening");
        const existing = store.getRequired(sessionId).recall;
        store.setRecall(sessionId, {
          ...existing,
          status: "active"
        });
        coordinator.schedule(sessionId);
        continue;
      }
      store.setStatus(sessionId, sessionStatusFromBot(event.status));
      const existing = store.getRequired(sessionId).recall;
      store.setRecall(sessionId, {
        ...existing,
        status: integrationStatusFromBot(event.status),
        detail: event.detail
      });
    }
  };

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
    createRecallWebhookHandler({
      adapter: recall,
      onEvents: (events) => applyEvents(sessionId, events),
      onAsyncError: (error) => {
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
    createRecallWebhookHandler({
      adapter: statusRecall,
      onEvents: async (events) => {
        const grouped = new Map<string, NormalizedMeetingEvent[]>();
        for (const event of events) {
          if (event.type !== "bot.status" || !event.botId) continue;
          const sessionId = botSessions.get(event.botId);
          if (!sessionId) continue;
          const group = grouped.get(sessionId) ?? [];
          group.push(event);
          grouped.set(sessionId, group);
        }
        for (const [sessionId, sessionEvents] of grouped) {
          await applyEvents(sessionId, sessionEvents);
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
    express.static(path.resolve(process.cwd(), "node_modules/mermaid/dist"))
  );
  app.use(express.static(publicDir));

  app.get("/health", (_request, response) => {
    response.json({
      ok: true,
      recallConfigured: Boolean(recall && config.publicBaseUrl)
    });
  });

  app.post("/api/sessions", (request, response) => {
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

    const snapshot = store.create(meetingUrl);
    const sessionToken = randomBytes(24).toString("base64url");
    sessionTokens.set(sessionToken, snapshot.id);

    response.status(201).json({
      sessionId: snapshot.id,
      operatorUrl: `/operator/${snapshot.id}`,
      whiteboardUrl: `/whiteboard/${snapshot.id}`
    });

    if (!recall || !config.publicBaseUrl) {
      store.setRecall(snapshot.id, {
        status: "error",
        detail:
          "Recall requires RECALL_API_KEY, RECALL_WORKSPACE_VERIFICATION_SECRET, and PUBLIC_API_BASE_URL."
      });
      return;
    }

    store.setRecall(snapshot.id, {
      status: "connecting",
      detail: `Creating bot in ${config.recall?.region ?? "configured"} region`
    });
    void recall
      .createBot({
        meetingUrl,
        botName: "Live Architect",
        publicBaseUrl: config.publicBaseUrl,
        sessionId: snapshot.id,
        sessionToken
      })
      .then(({ botId }) => {
        botSessions.set(botId, snapshot.id);
        store.setRecall(snapshot.id, {
          status: "waiting",
          botId,
          detail: "Waiting for host admission"
        });
        store.setStatus(snapshot.id, "waiting_for_admission");
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        store.setRecall(snapshot.id, { status: "error", detail: message });
        store.setStatus(snapshot.id, "error");
      });
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

  app.get("/api/whiteboards/:sessionId", (request, response) => {
    const snapshot = store.get(request.params.sessionId);
    if (!snapshot) {
      response.status(404).json({ error: "session not found" });
      return;
    }
    response.setHeader("Cache-Control", "no-store");
    response.json(toWhiteboardSnapshot(snapshot));
  });

  app.post("/api/sessions/:sessionId/analyze", (request, response) => {
    if (!store.get(request.params.sessionId)) {
      response.status(404).json({ error: "session not found" });
      return;
    }
    void coordinator.analyzeNow(request.params.sessionId);
    response.status(202).json({ accepted: true });
  });

  if (config.allowDevIngest) {
    app.post("/api/dev/sessions/:sessionId/utterances", (request, response) => {
      if (!store.get(request.params.sessionId)) {
        response.status(404).json({ error: "session not found" });
        return;
      }
      const parsed = DevUtteranceSchema.safeParse(request.body);
      if (!parsed.success) {
        response.status(400).json({ error: "invalid finalized utterance" });
        return;
      }
      store.upsertParticipant(request.params.sessionId, {
        id: parsed.data.participantId,
        name: parsed.data.participantName
      });
      const snapshot = store.appendUtterance(
        request.params.sessionId,
        parsed.data
      );
      coordinator.schedule(request.params.sessionId);
      response.status(202).json(snapshot);
    });
  }

  app.get("/events/:sessionId", (request, response) => {
    if (!store.get(request.params.sessionId)) {
      response.status(404).end();
      return;
    }

    response.status(200);
    response.setHeader("Content-Type", "text/event-stream");
    response.setHeader("Cache-Control", "no-cache, no-transform");
    response.setHeader("Connection", "keep-alive");
    response.setHeader("X-Accel-Buffering", "no");
    response.flushHeaders();

    const unsubscribe = store.subscribe(request.params.sessionId, (next) => {
      response.write(`event: session\ndata: ${JSON.stringify(next)}\n\n`);
    });
    const heartbeat = setInterval(() => {
      response.write(": heartbeat\n\n");
    }, 15_000);

    request.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  app.get("/events/whiteboards/:sessionId", (request, response) => {
    if (!store.get(request.params.sessionId)) {
      response.status(404).end();
      return;
    }

    response.status(200);
    response.setHeader("Content-Type", "text/event-stream");
    response.setHeader("Cache-Control", "no-cache, no-transform");
    response.setHeader("Connection", "keep-alive");
    response.setHeader("X-Accel-Buffering", "no");
    response.flushHeaders();

    const unsubscribe = store.subscribe(request.params.sessionId, (next) => {
      response.write(
        `event: whiteboard\ndata: ${JSON.stringify(toWhiteboardSnapshot(next))}\n\n`
      );
    });
    const heartbeat = setInterval(() => {
      response.write(": heartbeat\n\n");
    }, 15_000);

    request.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  app.get("/operator/:sessionId", (_request, response) => {
    response.sendFile(path.join(publicDir, "operator.html"));
  });

  app.get("/whiteboard/:sessionId", (_request, response) => {
    response.sendFile(path.join(publicDir, "whiteboard.html"));
  });

  return {
    app,
    config,
    store,
    coordinator,
    close: () => coordinator.close()
  };
};

export const startScoutServer = (
  config: AppConfig = loadConfig()
): { runtime: ScoutRuntime; server: Server } => {
  const runtime = createScoutRuntime(config);
  const server = runtime.app.listen(config.port, config.host, () => {
    console.log(
      `Scout v2 listening on http://${config.host}:${String(config.port)}`
    );
    console.log(
      `Recall region: ${config.recall?.region ?? "not configured"}`
    );
  });
  return { runtime, server };
};

const isEntrypoint =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isEntrypoint) {
  const { runtime, server } = startScoutServer();
  const shutdown = () => {
    server.close(() => {
      void runtime.close().finally(() => process.exit(0));
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
