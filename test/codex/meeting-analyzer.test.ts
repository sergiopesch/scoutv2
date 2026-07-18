import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
  emptyBusinessGraph,
  type BusinessGraph,
  type Utterance
} from "../../src/shared/types.js";
import {
  CodexMeetingAnalyzer,
  type AppServerAnalyzerClient
} from "../../src/server/codex/meeting-analyzer.js";
import type { RpcNotification } from "../../src/server/codex/app-server-client.js";

class FakeAnalyzerClient implements AppServerAnalyzerClient {
  readonly requests: Array<{
    method: string;
    params: Record<string, unknown>;
  }> = [];
  readonly events = new EventEmitter();
  initializeCount = 0;
  turnResultText = "";
  holdTurn = false;
  holdThreadStart = false;
  closed = false;
  private releaseHeldThreadStart?: () => void;

  async initialize(): Promise<void> {
    this.initializeCount += 1;
  }

  async request<T>(
    method: string,
    params: Record<string, unknown>
  ): Promise<T> {
    this.requests.push({ method, params });
    if (method === "thread/start" || method === "thread/resume") {
      if (this.holdThreadStart) {
        await new Promise<void>((resolve) => {
          this.releaseHeldThreadStart = resolve;
        });
      }
      return { thread: { id: "thread-1" } } as T;
    }
    if (method === "turn/start") {
      if (!this.holdTurn) {
        queueMicrotask(() => this.completeTurn(this.turnResultText));
      }
      return { turn: { id: "turn-1" } } as T;
    }
    if (method === "turn/interrupt") return {} as T;
    throw new Error(`Unexpected request: ${method}`);
  }

  releaseThreadStart(): void {
    this.releaseHeldThreadStart?.();
  }

  onNotification(
    listener: (notification: RpcNotification) => void
  ): () => void {
    this.events.on("notification", listener);
    return () => this.events.off("notification", listener);
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  completeTurn(text: string): void {
    this.events.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "agentMessage",
          id: "message-1",
          text
        }
      }
    } satisfies RpcNotification);
    this.events.emit("notification", {
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          status: "completed",
          error: null,
          items: []
        }
      }
    } satisfies RpcNotification);
  }
}

const utterance: Utterance = {
  id: "utterance-1",
  sequence: 1,
  participantId: "participant-1",
  participantName: "Alex",
  text: "Sales exports HubSpot leads to a spreadsheet every Friday.",
  startedAt: 1_000,
  endedAt: 4_000,
  finalized: true
};

const graph: BusinessGraph = {
  topic: { id: "lead-handoff", label: "Lead handoff" },
  nodes: [
    {
      id: "hubspot",
      kind: "system",
      label: "HubSpot",
      state: "current",
      confidence: 1,
      evidenceUtteranceIds: [utterance.id]
    },
    {
      id: "spreadsheet",
      kind: "artifact",
      label: "Spreadsheet export",
      state: "current",
      confidence: 1,
      evidenceUtteranceIds: [utterance.id]
    }
  ],
  edges: [
    {
      id: "hubspot-to-sheet",
      from: "hubspot",
      to: "spreadsheet",
      kind: "produces",
      state: "current",
      confidence: 1,
      evidenceUtteranceIds: [utterance.id]
    }
  ],
  pains: [],
  contradictions: [],
  suggestedQuestion: {
    text: "Who receives the Friday spreadsheet?",
    evidenceUtteranceIds: [utterance.id]
  }
};

const analyzeInput = () => ({
  sessionId: "session-1",
  currentGraph: emptyBusinessGraph(),
  participants: [
    { id: "participant-1", name: "Alex", role: "client" as const }
  ],
  newUtterances: [{ ...utterance, participantRole: "client" as const }]
});

const waitUntil = async (predicate: () => boolean): Promise<void> => {
  for (let attempts = 0; attempts < 50; attempts += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Condition was not reached.");
};

describe("CodexMeetingAnalyzer", () => {
  it("returns a schema-validated complete graph after authoritative turn completion", async () => {
    const client = new FakeAnalyzerClient();
    client.turnResultText = JSON.stringify(graph);
    const analyzer = new CodexMeetingAnalyzer({ client, turnTimeoutMs: 2_000 });

    await expect(analyzer.analyze(analyzeInput())).resolves.toEqual({
      threadId: "thread-1",
      graph
    });

    const turnStart = client.requests.find(
      (request) => request.method === "turn/start"
    );
    expect(turnStart?.params.outputSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: [
        "topic",
        "nodes",
        "edges",
        "pains",
        "contradictions",
        "suggestedQuestion"
      ]
    });
    const outputSchema = turnStart?.params.outputSchema as {
      properties?: {
        edges?: {
          items?: {
            required?: string[];
          };
        };
      };
    };
    expect(outputSchema.properties?.edges?.items?.required).toContain("label");
    expect(JSON.stringify(turnStart?.params.input)).toContain(utterance.id);
    expect(JSON.stringify(turnStart?.params.input)).toContain(
      "CURRENT ACCEPTED GRAPH"
    );
    const prompt = (
      turnStart?.params.input as Array<{ text?: string }> | undefined
    )?.[0]?.text;
    expect(prompt).toContain('"participantRole":"client"');
    expect(client.initializeCount).toBe(1);
    await analyzer.close();
    expect(client.closed).toBe(true);
  });

  it("rejects malformed structured output", async () => {
    const client = new FakeAnalyzerClient();
    client.turnResultText = "not-json";
    const analyzer = new CodexMeetingAnalyzer({ client, turnTimeoutMs: 2_000 });

    await expect(analyzer.analyze(analyzeInput())).rejects.toThrow(
      "returned malformed structured JSON"
    );
    await analyzer.close();
  });

  it("normalizes nullable structured-output optionals before domain validation", async () => {
    const client = new FakeAnalyzerClient();
    client.turnResultText = JSON.stringify({
      ...graph,
      edges: graph.edges.map((edge) => ({ ...edge, label: null })),
      suggestedQuestion: null
    });
    const analyzer = new CodexMeetingAnalyzer({ client, turnTimeoutMs: 2_000 });

    const result = await analyzer.analyze(analyzeInput());
    expect(result).toMatchObject({
      graph: {
        edges: [{ id: "hubspot-to-sheet" }]
      }
    });
    expect(result.graph.edges[0]?.label).toBeUndefined();
    expect(result.graph.suggestedQuestion).toBeUndefined();
    await analyzer.close();
  });

  it("rejects graph references that were not present in accepted or new evidence", async () => {
    const client = new FakeAnalyzerClient();
    client.turnResultText = JSON.stringify({
      ...graph,
      nodes: [
        {
          ...graph.nodes[0],
          evidenceUtteranceIds: ["invented-utterance"]
        }
      ],
      edges: [],
      suggestedQuestion: undefined
    });
    const analyzer = new CodexMeetingAnalyzer({ client, turnTimeoutMs: 2_000 });

    await expect(analyzer.analyze(analyzeInput())).rejects.toThrow(
      "returned invalid graph references"
    );
    await analyzer.close();
  });

  it("rejects a concurrent analysis for the same meeting without a second turn/start", async () => {
    const client = new FakeAnalyzerClient();
    client.turnResultText = JSON.stringify(graph);
    client.holdTurn = true;
    const analyzer = new CodexMeetingAnalyzer({ client, turnTimeoutMs: 2_000 });

    const firstAnalysis = analyzer.analyze(analyzeInput());
    await waitUntil(() =>
      client.requests.some((request) => request.method === "turn/start")
    );
    await expect(analyzer.analyze(analyzeInput())).rejects.toThrow(
      "already active"
    );
    expect(
      client.requests.filter((request) => request.method === "turn/start")
    ).toHaveLength(1);

    client.completeTurn(client.turnResultText);
    await expect(firstAnalysis).resolves.toEqual({
      threadId: "thread-1",
      graph
    });
    await analyzer.close();
  });

  it("retires the session thread and interrupts an active turn on reset", async () => {
    const client = new FakeAnalyzerClient();
    client.turnResultText = JSON.stringify(graph);
    client.holdTurn = true;
    const analyzer = new CodexMeetingAnalyzer({ client, turnTimeoutMs: 2_000 });

    const firstAnalysis = analyzer.analyze(analyzeInput());
    await waitUntil(() =>
      client.requests.some((request) => request.method === "turn/start")
    );
    await analyzer.resetSession("session-1");

    expect(
      client.requests.find((request) => request.method === "turn/interrupt")
    ).toMatchObject({
      params: { threadId: "thread-1", turnId: "turn-1" }
    });

    client.completeTurn(client.turnResultText);
    await firstAnalysis;
    client.holdTurn = false;
    await analyzer.analyze(analyzeInput());
    expect(
      client.requests.filter((request) => request.method === "thread/start")
    ).toHaveLength(2);
    await analyzer.close();
  });

  it("does not bind a thread that finishes starting after reset", async () => {
    const client = new FakeAnalyzerClient();
    client.turnResultText = JSON.stringify(graph);
    client.holdThreadStart = true;
    const analyzer = new CodexMeetingAnalyzer({ client, turnTimeoutMs: 2_000 });

    const staleAnalysis = analyzer.analyze(analyzeInput());
    await waitUntil(() =>
      client.requests.some((request) => request.method === "thread/start")
    );
    await analyzer.resetSession("session-1");
    client.releaseThreadStart();
    await expect(staleAnalysis).rejects.toThrow("reset during analysis");

    client.holdThreadStart = false;
    await analyzer.analyze(analyzeInput());
    expect(
      client.requests.filter((request) => request.method === "thread/start")
    ).toHaveLength(2);
    await analyzer.close();
  });
});
