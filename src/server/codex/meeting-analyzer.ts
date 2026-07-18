import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { BusinessGraphSchema, validateGraphReferences } from "../../shared/schemas.js";
import type {
  BusinessGraph,
  Participant,
  Utterance
} from "../../shared/types.js";
import type {
  AnalyzeMeetingInput,
  AnalyzeMeetingResult,
  MeetingAnalyzer
} from "../contracts.js";
import {
  CodexAppServerClient,
  type RpcNotification
} from "./app-server-client.js";

interface ThreadStartResponse {
  thread: { id: string };
}

interface TurnStartResponse {
  turn: {
    id: string;
  };
}

interface AgentMessage {
  type: "agentMessage";
  id: string;
  text: string;
}

interface Turn {
  id: string;
  status: "completed" | "interrupted" | "failed" | "inProgress";
  error?: {
    message: string;
    additionalDetails?: string | null;
  } | null;
  items?: Array<
    | AgentMessage
    | {
        type: string;
        id: string;
      }
  >;
}

interface ItemCompletedParams {
  threadId: string;
  turnId: string;
  item: AgentMessage | { type: string; id: string };
}

interface TurnCompletedParams {
  threadId: string;
  turn: Turn;
}

export interface AppServerAnalyzerClient {
  initialize(): Promise<void>;
  request<T>(method: string, params: Record<string, unknown>): Promise<T>;
  onNotification(
    listener: (notification: RpcNotification) => void
  ): () => void;
  close(): Promise<void>;
}

export interface CodexMeetingAnalyzerOptions {
  client?: AppServerAnalyzerClient;
  turnTimeoutMs?: number;
  model?: string;
  effort?:
    | "none"
    | "minimal"
    | "low"
    | "medium"
    | "high"
    | "xhigh"
    | "max"
    | "ultra";
}

type TurnWaiter = {
  resolve: (turn: Turn) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

const ANALYST_INSTRUCTIONS = `You are Live Architect, a meeting discovery analyst.
For every turn, return one complete BusinessGraph matching the supplied JSON schema.
Use only the supplied utterance IDs as evidence. Preserve previously supported facts unless new evidence corrects them.
Build a reliable model of the prospective customer's business. Operator and interviewer words are context only: do not turn their questions, examples, assumptions, or leading suggestions into customer pains, goals, constraints, contradictions, or other graph claims. Every graph finding must cite designated-customer utterances. A customer may confirm or elaborate on an operator suggestion, but cite the customer's utterance, never the suggestion.
Distinguish current, desired, hypothesis, and unknown states. Do not invent participant identities.
Treat client utterances as discovery evidence. Treat operator utterances as questions, framing, or hypotheses unless a client confirms them.
When a participant role is unknown, do not guess whether they are the operator or a client.
Keep labels concise for a 1280x720 workflow diagram. Return structured output only.`;

type JsonSchema = Record<string, unknown>;

const asSchema = (value: unknown): JsonSchema | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonSchema)
    : undefined;

const nullableSchema = (schema: unknown): JsonSchema => ({
  anyOf: [schema, { type: "null" }]
});

/**
 * OpenAI structured outputs require every object property to appear in
 * `required`. Domain-optional fields are therefore represented as nullable at
 * the model boundary, then normalized back before Zod validation.
 */
const makeStructuredOutputCompatible = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(makeStructuredOutputCompatible);
  }
  const schema = asSchema(value);
  if (!schema) return value;

  const result = Object.fromEntries(
    Object.entries(schema).map(([key, child]) => [
      key,
      makeStructuredOutputCompatible(child)
    ])
  ) as JsonSchema;
  const properties = asSchema(schema.properties);
  if (properties) {
    const previouslyRequired = new Set(
      Array.isArray(schema.required)
        ? schema.required.filter((item): item is string => typeof item === "string")
        : []
    );
    const compatibleProperties = Object.fromEntries(
      Object.entries(properties).map(([key, child]) => {
        const compatible = makeStructuredOutputCompatible(child);
        return [
          key,
          previouslyRequired.has(key)
            ? compatible
            : nullableSchema(compatible)
        ];
      })
    );
    result.properties = compatibleProperties;
    result.required = Object.keys(properties);
    result.additionalProperties = false;
  }
  return result;
};

const graphOutputSchema = makeStructuredOutputCompatible(
  z.toJSONSchema(BusinessGraphSchema)
);

const normalizeStructuredGraph = (value: unknown): unknown => {
  const graph = asSchema(value);
  if (!graph) return value;
  const normalized = structuredClone(graph);
  if (normalized.suggestedQuestion === null) {
    delete normalized.suggestedQuestion;
  }
  if (Array.isArray(normalized.edges)) {
    normalized.edges = normalized.edges.map((edge) => {
      const record = asSchema(edge);
      if (!record || record.label !== null) return edge;
      const normalizedEdge = { ...record };
      delete normalizedEdge.label;
      return normalizedEdge;
    });
  }
  return normalized;
};

const evidenceIdsFromGraph = (graph: BusinessGraph): Set<string> => {
  const ids = new Set<string>();
  const groups = [
    ...graph.nodes.map((item) => item.evidenceUtteranceIds),
    ...graph.edges.map((item) => item.evidenceUtteranceIds),
    ...graph.pains.map((item) => item.evidenceUtteranceIds),
    ...graph.contradictions.map((item) => item.evidenceUtteranceIds),
    ...(graph.suggestedQuestion
      ? [graph.suggestedQuestion.evidenceUtteranceIds]
      : [])
  ];
  for (const group of groups) {
    for (const id of group) ids.add(id);
  }
  return ids;
};

const turnKey = (threadId: string, turnId: string): string =>
  `${threadId}:${turnId}`;

const isAgentMessage = (value: unknown): value is AgentMessage => {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.type === "agentMessage" &&
    typeof candidate.id === "string" &&
    typeof candidate.text === "string"
  );
};

const buildAnalysisPrompt = (
  currentGraph: BusinessGraph,
  participants: Participant[],
  newUtterances: Utterance[]
): string => {
  const customerIds = new Set(
    participants
      .filter((participant) => participant.role === "customer")
      .map((participant) => participant.id)
  );
  const customerUtterances = newUtterances.filter((utterance) =>
    customerIds.has(utterance.participantId)
  );
  const operatorContext = newUtterances.filter(
    (utterance) => !customerIds.has(utterance.participantId)
  );
  return `Update the business model from finalized meeting evidence.

Return the complete graph, not a patch. Preserve supported prior elements and stable IDs.
Every node, edge, pain, contradiction, and suggested question must cite one or more designated-customer utterance IDs. Do not establish a claim from operator context alone. If customer evidence is insufficient, leave the claim out and ask a question that targets the gap.

PARTICIPANT ROLES
${JSON.stringify(participants)}

DESIGNATED CUSTOMER PARTICIPANTS
${JSON.stringify(participants.filter((participant) => participant.role === "customer"))}

CURRENT ACCEPTED GRAPH
${JSON.stringify(currentGraph)}

NEW FINALIZED CUSTOMER EVIDENCE (the only new utterances you may cite)
${JSON.stringify(customerUtterances)}

NEW OPERATOR / INTERVIEWER CONTEXT (do not cite this as evidence)
${JSON.stringify(operatorContext)}
`;
};

export class CodexMeetingAnalyzer implements MeetingAnalyzer {
  private readonly client: AppServerAnalyzerClient;
  private readonly turnTimeoutMs: number;
  private readonly model?: string;
  private readonly effort?: CodexMeetingAnalyzerOptions["effort"];
  private readonly threadsBySession = new Map<string, string>();
  private readonly sessionsByThread = new Map<string, string>();
  private readonly sessionGenerations = new Map<string, number>();
  private readonly activeSessions = new Map<string, symbol>();
  private readonly activeThreads = new Set<string>();
  private readonly activeTurnsBySession = new Map<
    string,
    { threadId: string; turnId: string; analysisToken: symbol }
  >();
  private readonly scratchDirectories = new Map<string, string>();
  private readonly completedTurns = new Map<string, Turn>();
  private readonly messagesByTurn = new Map<string, AgentMessage[]>();
  private readonly turnWaiters = new Map<string, TurnWaiter>();
  private readonly removeNotificationListener: () => void;
  private closed = false;

  constructor(options: CodexMeetingAnalyzerOptions = {}) {
    this.client = options.client ?? new CodexAppServerClient();
    this.turnTimeoutMs = options.turnTimeoutMs ?? 120_000;
    this.model = options.model;
    this.effort = options.effort;
    this.removeNotificationListener = this.client.onNotification((notification) =>
      this.handleNotification(notification)
    );
  }

  async analyze(input: AnalyzeMeetingInput): Promise<AnalyzeMeetingResult> {
    if (this.closed) throw new Error("Codex meeting analyzer is closed.");
    if (this.activeSessions.has(input.sessionId)) {
      throw new Error(
        `A Codex analysis turn is already active for session ${input.sessionId}.`
      );
    }
    if (input.newUtterances.length === 0) {
      throw new Error("Codex analysis requires at least one finalized utterance.");
    }
    if (input.newUtterances.some((utterance) => !utterance.finalized)) {
      throw new Error("Codex analysis accepts finalized utterances only.");
    }

    const analysisToken = Symbol(input.sessionId);
    const generation = this.sessionGenerations.get(input.sessionId) ?? 0;
    this.activeSessions.set(input.sessionId, analysisToken);
    try {
      await this.client.initialize();
      const threadId = await this.ensureThread(input);
      if (!this.isCurrentGeneration(input.sessionId, generation)) {
        this.releaseThreadBinding(input.sessionId, threadId);
        throw new Error(`Session ${input.sessionId} was reset during analysis.`);
      }
      if (this.activeThreads.has(threadId)) {
        throw new Error(
          `A Codex analysis turn is already active for thread ${threadId}.`
        );
      }
      this.activeThreads.add(threadId);
      try {
        const turnResponse = await this.client.request<TurnStartResponse>(
          "turn/start",
          {
            threadId,
            input: [
              {
                type: "text",
                text: buildAnalysisPrompt(
                  input.currentGraph,
                  input.participants,
                  input.newUtterances
                ),
                text_elements: []
              }
            ],
            approvalPolicy: "never",
            ...(this.model ? { model: this.model } : {}),
            ...(this.effort ? { effort: this.effort } : {}),
            outputSchema: graphOutputSchema
          }
        );
        if (!this.isCurrentGeneration(input.sessionId, generation)) {
          this.releaseThreadBinding(input.sessionId, threadId);
          void this.client
            .request("turn/interrupt", {
              threadId,
              turnId: turnResponse.turn.id
            })
            .catch(() => {});
          throw new Error(`Session ${input.sessionId} was reset during analysis.`);
        }
        this.activeTurnsBySession.set(input.sessionId, {
          threadId,
          turnId: turnResponse.turn.id,
          analysisToken
        });

        const turn = await this.waitForTurn(threadId, turnResponse.turn.id);
        if (turn.status !== "completed") {
          const detail = turn.error?.message ?? turn.status;
          throw new Error(`Codex analysis turn did not complete: ${detail}`);
        }

        const graph = this.parseGraphResult(
          threadId,
          turn,
          input.currentGraph,
          input.newUtterances
        );
        return { threadId, graph };
      } finally {
        this.activeThreads.delete(threadId);
        const activeTurn = this.activeTurnsBySession.get(input.sessionId);
        if (activeTurn?.analysisToken === analysisToken) {
          this.activeTurnsBySession.delete(input.sessionId);
        }
      }
    } finally {
      if (this.activeSessions.get(input.sessionId) === analysisToken) {
        this.activeSessions.delete(input.sessionId);
      }
    }
  }

  async resetSession(sessionId: string): Promise<void> {
    this.sessionGenerations.set(
      sessionId,
      (this.sessionGenerations.get(sessionId) ?? 0) + 1
    );
    const threadId = this.threadsBySession.get(sessionId);
    if (threadId) {
      this.threadsBySession.delete(sessionId);
      this.sessionsByThread.delete(threadId);
    }
    this.activeSessions.delete(sessionId);

    const activeTurn = this.activeTurnsBySession.get(sessionId);
    this.activeTurnsBySession.delete(sessionId);
    if (!activeTurn) return;

    void this.client
      .request("turn/interrupt", {
        threadId: activeTurn.threadId,
        turnId: activeTurn.turnId
      })
      .catch(() => {
        // The coordinator generation barrier still rejects this turn if it
        // completed or became unreachable before interruption was acknowledged.
      });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.removeNotificationListener();
    for (const waiter of this.turnWaiters.values()) {
      clearTimeout(waiter.timeout);
      waiter.reject(new Error("Codex meeting analyzer closed."));
    }
    this.turnWaiters.clear();
    await this.client.close();
    await Promise.all(
      [...this.scratchDirectories.values()].map((directory) =>
        rm(directory, { recursive: true, force: true })
      )
    );
    this.scratchDirectories.clear();
  }

  private async ensureThread(input: AnalyzeMeetingInput): Promise<string> {
    const knownThreadId = this.threadsBySession.get(input.sessionId);
    if (knownThreadId) {
      if (input.threadId && input.threadId !== knownThreadId) {
        throw new Error(
          `Session ${input.sessionId} is already bound to Codex thread ${knownThreadId}.`
        );
      }
      return knownThreadId;
    }

    const cwd = await this.getScratchDirectory(input.sessionId);
    const commonParams = {
      cwd,
      approvalPolicy: "never",
      sandbox: "read-only",
      baseInstructions: ANALYST_INSTRUCTIONS
    };
    const response = input.threadId
      ? await this.client.request<ThreadStartResponse>("thread/resume", {
          threadId: input.threadId,
          ...commonParams
        })
      : await this.client.request<ThreadStartResponse>(
          "thread/start",
          commonParams
        );
    const threadId = response.thread.id;
    if (input.threadId && threadId !== input.threadId) {
      throw new Error(
        `Codex resumed unexpected thread ${threadId}; expected ${input.threadId}.`
      );
    }
    const owningSession = this.sessionsByThread.get(threadId);
    if (owningSession && owningSession !== input.sessionId) {
      throw new Error(
        `Codex thread ${threadId} is already bound to session ${owningSession}.`
      );
    }
    this.threadsBySession.set(input.sessionId, threadId);
    this.sessionsByThread.set(threadId, input.sessionId);
    return threadId;
  }

  private isCurrentGeneration(sessionId: string, generation: number): boolean {
    return (this.sessionGenerations.get(sessionId) ?? 0) === generation;
  }

  private releaseThreadBinding(sessionId: string, threadId: string): void {
    if (this.threadsBySession.get(sessionId) === threadId) {
      this.threadsBySession.delete(sessionId);
    }
    if (this.sessionsByThread.get(threadId) === sessionId) {
      this.sessionsByThread.delete(threadId);
    }
  }

  private async getScratchDirectory(sessionId: string): Promise<string> {
    const existing = this.scratchDirectories.get(sessionId);
    if (existing) return existing;
    const directory = await mkdtemp(join(tmpdir(), "scoutv2-codex-"));
    this.scratchDirectories.set(sessionId, directory);
    return directory;
  }

  private waitForTurn(threadId: string, turnId: string): Promise<Turn> {
    const key = turnKey(threadId, turnId);
    const completed = this.completedTurns.get(key);
    if (completed) {
      this.completedTurns.delete(key);
      return Promise.resolve(completed);
    }

    return new Promise<Turn>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.turnWaiters.delete(key);
        reject(
          new Error(
            `Timed out waiting for authoritative turn/completed for ${turnId}.`
          )
        );
      }, this.turnTimeoutMs);
      timeout.unref();
      this.turnWaiters.set(key, { resolve, reject, timeout });
    });
  }

  private handleNotification(notification: RpcNotification): void {
    if (notification.method === "item/completed") {
      const params = notification.params as ItemCompletedParams;
      if (!params || !isAgentMessage(params.item)) return;
      const key = turnKey(params.threadId, params.turnId);
      const messages = this.messagesByTurn.get(key) ?? [];
      messages.push(params.item);
      this.messagesByTurn.set(key, messages);
      return;
    }

    if (notification.method !== "turn/completed") return;
    const params = notification.params as TurnCompletedParams;
    if (!params?.threadId || !params.turn?.id) return;
    const key = turnKey(params.threadId, params.turn.id);
    const waiter = this.turnWaiters.get(key);
    if (waiter) {
      this.turnWaiters.delete(key);
      clearTimeout(waiter.timeout);
      waiter.resolve(params.turn);
    } else {
      this.completedTurns.set(key, params.turn);
    }
  }

  private parseGraphResult(
    threadId: string,
    turn: Turn,
    currentGraph: BusinessGraph,
    newUtterances: Utterance[]
  ): BusinessGraph {
    const key = turnKey(threadId, turn.id);
    const notificationMessages = this.messagesByTurn.get(key) ?? [];
    this.messagesByTurn.delete(key);
    const turnMessages = (turn.items ?? []).filter(isAgentMessage);
    const message = [...notificationMessages, ...turnMessages].at(-1);
    if (!message) {
      throw new Error(
        `Completed Codex turn ${turn.id} contained no structured agent message.`
      );
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(message.text);
    } catch {
      throw new Error(
        `Codex turn ${turn.id} returned malformed structured JSON.`
      );
    }

    const parsed = BusinessGraphSchema.safeParse(
      normalizeStructuredGraph(decoded)
    );
    if (!parsed.success) {
      throw new Error(
        `Codex turn ${turn.id} returned an invalid BusinessGraph: ${z.prettifyError(parsed.error)}`
      );
    }

    const validUtteranceIds = evidenceIdsFromGraph(currentGraph);
    for (const utterance of newUtterances) {
      validUtteranceIds.add(utterance.id);
    }
    const referenceErrors = validateGraphReferences(
      parsed.data,
      validUtteranceIds
    );
    if (referenceErrors.length > 0) {
      throw new Error(
        `Codex turn ${turn.id} returned invalid graph references: ${referenceErrors.join(" ")}`
      );
    }
    return parsed.data;
  }
}
