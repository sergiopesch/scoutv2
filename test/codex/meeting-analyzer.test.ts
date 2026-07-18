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
  failAfterTurnStartResponse = false;
  closed = false;
  connectionGeneration = 1;
  preflightResult: { ready: boolean; detail?: string } = { ready: true };
  readonly preflightOptions: Array<{ model?: string; effort?: string }> = [];
  readonly mcpStatusResponses: unknown[] = [];
  private nextMcpStatusResponse = 0;
  private nextThreadId = 1;
  private nextTurnId = 1;
  private activeThreadId?: string;
  private activeTurnId?: string;
  private releaseHeldThreadStart?: () => void;

  async initialize(): Promise<void> {
    this.initializeCount += 1;
  }

  async request<T>(
    method: string,
    params: Record<string, unknown>
  ): Promise<T> {
    this.requests.push({ method, params });
    if (method === "mcpServerStatus/list") {
      return (this.mcpStatusResponses[this.nextMcpStatusResponse++] ?? {
        data: [],
        nextCursor: null
      }) as T;
    }
    if (method === "thread/start" || method === "thread/resume") {
      const threadId =
        method === "thread/resume" && typeof params.threadId === "string"
          ? params.threadId
          : `thread-${this.nextThreadId++}`;
      if (this.holdThreadStart) {
        await new Promise<void>((resolve) => {
          this.releaseHeldThreadStart = resolve;
        });
      }
      return { thread: { id: threadId } } as T;
    }
    if (method === "turn/start") {
      const threadId = String(params.threadId);
      const turnId = `turn-${this.nextTurnId++}`;
      this.activeThreadId = threadId;
      this.activeTurnId = turnId;
      if (!this.holdTurn) {
        queueMicrotask(() =>
          this.completeTurn(this.turnResultText, { threadId, turnId })
        );
      }
      if (this.failAfterTurnStartResponse) {
        queueMicrotask(() => this.failConnection());
      }
      return { turn: { id: turnId } } as T;
    }
    if (method === "turn/interrupt") return {} as T;
    throw new Error(`Unexpected request: ${method}`);
  }

  releaseThreadStart(): void {
    this.releaseHeldThreadStart?.();
  }

  getConnectionGeneration(): number {
    return this.connectionGeneration;
  }

  async preflight(options: {
    model?: string;
    effort?: string;
  } = {}): Promise<{
    ready: boolean;
    detail?: string;
    connectionGeneration: number;
  }> {
    this.preflightOptions.push(options);
    return {
      ...this.preflightResult,
      connectionGeneration: this.connectionGeneration
    };
  }

  onNotification(
    listener: (notification: RpcNotification) => void
  ): () => void {
    this.events.on("notification", listener);
    return () => this.events.off("notification", listener);
  }

  onFailure(listener: (error: Error) => void): () => void {
    this.events.on("failure", listener);
    return () => this.events.off("failure", listener);
  }

  failConnection(error = new Error("simulated child exit")): void {
    this.events.emit("failure", error);
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  emitAgentMessage(
    text: string,
    options: {
      threadId?: string;
      turnId?: string;
      id?: string;
      phase?: "commentary" | "final_answer" | null;
    } = {}
  ): void {
    const threadId = options.threadId ?? this.activeThreadId ?? "thread-1";
    const turnId = options.turnId ?? this.activeTurnId ?? "turn-1";
    this.events.emit("notification", {
      method: "item/completed",
      params: {
        threadId,
        turnId,
        item: {
          type: "agentMessage",
          id: options.id ?? "message-1",
          text,
          ...(options.phase !== undefined ? { phase: options.phase } : {})
        }
      }
    } satisfies RpcNotification);
  }

  completeTurn(
    text: string,
    options: {
      threadId?: string;
      turnId?: string;
      status?: "completed" | "interrupted" | "failed" | "inProgress";
      items?: unknown[];
      emitMessage?: boolean;
      phase?: "commentary" | "final_answer" | null;
    } = {}
  ): void {
    const threadId = options.threadId ?? this.activeThreadId ?? "thread-1";
    const turnId = options.turnId ?? this.activeTurnId ?? "turn-1";
    if (options.emitMessage !== false) {
      this.emitAgentMessage(text, {
        threadId,
        turnId,
        phase: options.phase
      });
    }
    this.events.emit("notification", {
      method: "turn/completed",
      params: {
        threadId,
        turn: {
          id: turnId,
          status: options.status ?? "completed",
          error:
            options.status === "failed"
              ? { message: "simulated turn failure" }
              : null,
          items: options.items ?? []
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
  topic: {
    id: "lead-handoff",
    label: "Lead handoff",
    evidenceUtteranceIds: [utterance.id]
  },
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
    { id: "participant-1", name: "Alex", role: "customer" as const }
  ],
  newUtterances: [{ ...utterance, participantRole: "customer" as const }]
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

    const threadStart = client.requests.find(
      (request) => request.method === "thread/start"
    );
    expect(threadStart?.params).toMatchObject({
      runtimeWorkspaceRoots: [expect.any(String)],
      approvalPolicy: "never",
      permissions: "scout-analysis",
      environments: [],
      dynamicTools: [],
      selectedCapabilityRoots: [],
      config: {
        web_search: "disabled",
        features: {
          plugins: false,
          apps: false,
          enable_mcp_apps: false,
          browser_use: false,
          computer_use: false,
          multi_agent: false,
          image_generation: false
        },
        permissions: {
          "scout-analysis": {
            filesystem: {
              ":minimal": "read",
              ":workspace_roots": { ".": "read" }
            },
            network: { enabled: false }
          }
        },
        shell_environment_policy: { inherit: "none" },
        apps: { _default: { enabled: false } }
      }
    });
    expect(threadStart?.params).not.toHaveProperty("config.mcp_servers");
    expect(threadStart?.params).not.toHaveProperty("sandbox");
    expect(threadStart?.params.developerInstructions).toContain(
      "untrusted evidence"
    );

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
    expect(prompt).toContain('"participantRole":"customer"');
    expect(JSON.stringify(turnStart?.params.input)).toContain(
      "NEW FINALIZED CUSTOMER EVIDENCE"
    );
    expect(client.initializeCount).toBe(1);
    expect(client.requests[0]?.method).toBe("mcpServerStatus/list");
    await analyzer.close();
    expect(client.closed).toBe(true);
  });

  it.each([
    [
      "tools",
      {
        tools: { dangerous_tool: { name: "dangerous_tool" } },
        resources: [],
        resourceTemplates: []
      }
    ],
    [
      "resources",
      {
        tools: {},
        resources: [{ name: "private", uri: "file:///private" }],
        resourceTemplates: []
      }
    ],
    [
      "resource templates",
      {
        tools: {},
        resources: [],
        resourceTemplates: [
          { name: "private", uriTemplate: "file:///{path}" }
        ]
      }
    ]
  ])(
    "fails closed on advertised MCP %s before starting a thread",
    async (_label, capability) => {
      const client = new FakeAnalyzerClient();
      client.mcpStatusResponses.push({
        data: [
          {
            name: "unexpected-server",
            authStatus: "unsupported",
            ...capability
          }
        ],
        nextCursor: null
      });
      const analyzer = new CodexMeetingAnalyzer({
        client,
        turnTimeoutMs: 2_000
      });

      await expect(
        analyzer.analyze({ ...analyzeInput(), threadId: "persisted-thread" })
      ).rejects.toThrow("advertised MCP capabilities");
      expect(
        client.requests.some(
          (request) =>
            request.method === "thread/start" ||
            request.method === "thread/resume" ||
            request.method === "turn/start"
        )
      ).toBe(false);
      await analyzer.close();
    }
  );

  it("paginates and caches a successful MCP capability audit", async () => {
    const client = new FakeAnalyzerClient();
    client.turnResultText = JSON.stringify(graph);
    client.mcpStatusResponses.push(
      { data: [], nextCursor: "page-2" },
      { data: [], nextCursor: null }
    );
    const analyzer = new CodexMeetingAnalyzer({ client, turnTimeoutMs: 2_000 });

    const first = await analyzer.analyze(analyzeInput());
    await analyzer.analyze({
      ...analyzeInput(),
      threadId: first.threadId,
      currentGraph: graph
    });

    const audits = client.requests.filter(
      (request) => request.method === "mcpServerStatus/list"
    );
    expect(audits).toHaveLength(2);
    expect(audits[0]?.params).toEqual({ detail: "full", limit: 100 });
    expect(audits[1]?.params).toEqual({
      detail: "full",
      limit: 100,
      cursor: "page-2"
    });
    await analyzer.close();
  });

  it("fails closed when MCP capability pagination exceeds its bound", async () => {
    const client = new FakeAnalyzerClient();
    for (let page = 1; page <= 20; page += 1) {
      client.mcpStatusResponses.push({
        data: [],
        nextCursor: `page-${String(page + 1)}`
      });
    }
    const analyzer = new CodexMeetingAnalyzer({ client, turnTimeoutMs: 2_000 });

    await expect(analyzer.analyze(analyzeInput())).rejects.toThrow(
      "pagination safety limit"
    );
    expect(
      client.requests.filter(
        (request) => request.method === "mcpServerStatus/list"
      )
    ).toHaveLength(20);
    expect(
      client.requests.some(
        (request) =>
          request.method === "thread/start" || request.method === "turn/start"
      )
    ).toBe(false);
    await analyzer.close();
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

  it("rejects operator utterances as graph evidence inside the analyzer boundary", async () => {
    const operatorUtterance = {
      ...utterance,
      id: "operator-utterance",
      participantId: "operator-1",
      participantName: "Morgan",
      text: "It sounds like spreadsheets are painful.",
      participantRole: "operator" as const
    };
    const client = new FakeAnalyzerClient();
    client.turnResultText = JSON.stringify({
      ...graph,
      nodes: [
        {
          ...graph.nodes[0],
          evidenceUtteranceIds: [operatorUtterance.id]
        }
      ],
      edges: [],
      suggestedQuestion: undefined
    });
    const analyzer = new CodexMeetingAnalyzer({ client, turnTimeoutMs: 2_000 });

    await expect(
      analyzer.analyze({
        ...analyzeInput(),
        participants: [
          ...analyzeInput().participants,
          { id: "operator-1", name: "Morgan", role: "operator" as const }
        ],
        newUtterances: [
          ...analyzeInput().newUtterances,
          operatorUtterance
        ]
      })
    ).rejects.toThrow("returned invalid graph references");
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
    const staleResult = expect(firstAnalysis).rejects.toThrow(
      "reset during analysis"
    );
    await analyzer.resetSession("session-1");
    await staleResult;

    expect(
      client.requests.find((request) => request.method === "turn/interrupt")
    ).toMatchObject({
      params: { threadId: "thread-1", turnId: "turn-1" }
    });

    client.completeTurn(client.turnResultText);
    client.holdTurn = false;
    await expect(analyzer.analyze(analyzeInput())).resolves.toMatchObject({
      threadId: "thread-2",
      graph
    });
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

  it("does not let a stale thread/start overwrite a replacement analysis", async () => {
    const client = new FakeAnalyzerClient();
    client.turnResultText = JSON.stringify(graph);
    client.holdThreadStart = true;
    const analyzer = new CodexMeetingAnalyzer({ client, turnTimeoutMs: 2_000 });

    const staleAnalysis = analyzer.analyze(analyzeInput());
    await waitUntil(
      () =>
        client.requests.filter((request) => request.method === "thread/start")
          .length === 1
    );
    await analyzer.resetSession("session-1");
    client.holdThreadStart = false;

    const replacement = await analyzer.analyze(analyzeInput());
    expect(replacement.threadId).toBe("thread-2");
    const staleResult = expect(staleAnalysis).rejects.toThrow(
      "reset during analysis"
    );
    client.releaseThreadStart();
    await staleResult;

    await expect(
      analyzer.analyze({
        ...analyzeInput(),
        threadId: replacement.threadId,
        currentGraph: graph
      })
    ).resolves.toMatchObject({ threadId: "thread-2" });
    expect(
      client.requests.filter((request) => request.method === "thread/start")
    ).toHaveLength(2);
    await analyzer.close();
  });

  it("reuses one persistent thread for sequential turns in the same meeting", async () => {
    const client = new FakeAnalyzerClient();
    client.turnResultText = JSON.stringify(graph);
    const analyzer = new CodexMeetingAnalyzer({ client, turnTimeoutMs: 2_000 });

    const first = await analyzer.analyze(analyzeInput());
    const nextUtterance = {
      ...utterance,
      id: "utterance-2",
      sequence: 2,
      text: "The spreadsheet is sent to operations."
    };
    const second = await analyzer.analyze({
      ...analyzeInput(),
      threadId: first.threadId,
      currentGraph: graph,
      newUtterances: [
        { ...nextUtterance, participantRole: "customer" as const }
      ]
    });

    expect(second.threadId).toBe(first.threadId);
    expect(
      client.requests.filter((request) => request.method === "thread/start")
    ).toHaveLength(1);
    expect(
      client.requests.filter((request) => request.method === "turn/start")
    ).toHaveLength(2);
    expect(
      client.requests.filter(
        (request) => request.method === "mcpServerStatus/list"
      )
    ).toHaveLength(1);
    await analyzer.close();
  });

  it("keeps separate meetings on separate persistent threads", async () => {
    const client = new FakeAnalyzerClient();
    client.turnResultText = JSON.stringify(graph);
    const analyzer = new CodexMeetingAnalyzer({ client, turnTimeoutMs: 2_000 });

    const first = await analyzer.analyze(analyzeInput());
    const second = await analyzer.analyze({
      ...analyzeInput(),
      sessionId: "session-2"
    });

    expect(first.threadId).toBe("thread-1");
    expect(second.threadId).toBe("thread-2");
    await analyzer.close();
  });

  it("resumes a persisted thread and reloads it after app-server recovery", async () => {
    const client = new FakeAnalyzerClient();
    client.turnResultText = JSON.stringify(graph);
    const analyzer = new CodexMeetingAnalyzer({ client, turnTimeoutMs: 2_000 });

    const first = await analyzer.analyze({
      ...analyzeInput(),
      threadId: "persisted-thread"
    });
    expect(first.threadId).toBe("persisted-thread");

    client.connectionGeneration += 1;
    const second = await analyzer.analyze({
      ...analyzeInput(),
      threadId: "persisted-thread",
      currentGraph: graph
    });
    expect(second.threadId).toBe("persisted-thread");
    expect(
      client.requests.filter((request) => request.method === "thread/resume")
    ).toHaveLength(2);
    expect(
      client.requests.filter((request) => request.method === "thread/start")
    ).toHaveLength(0);
    expect(
      client.requests.filter(
        (request) => request.method === "mcpServerStatus/list"
      )
    ).toHaveLength(2);
    await analyzer.close();
  });

  it("quarantines a thread after invalid output so its failure cannot contaminate retry", async () => {
    const client = new FakeAnalyzerClient();
    client.turnResultText = "not-json";
    const analyzer = new CodexMeetingAnalyzer({ client, turnTimeoutMs: 2_000 });

    await expect(analyzer.analyze(analyzeInput())).rejects.toThrow(
      "returned malformed structured JSON"
    );
    client.turnResultText = JSON.stringify(graph);
    await expect(
      analyzer.analyze({ ...analyzeInput(), threadId: "thread-1" })
    ).resolves.toMatchObject({ threadId: "thread-2", graph });

    expect(
      client.requests.filter((request) => request.method === "thread/start")
    ).toHaveLength(2);
    expect(
      client.requests.filter((request) => request.method === "thread/resume")
    ).toHaveLength(0);
    await analyzer.close();
  });

  it("interrupts and quarantines a timed-out turn while ignoring late events", async () => {
    const client = new FakeAnalyzerClient();
    client.turnResultText = JSON.stringify(graph);
    client.holdTurn = true;
    const analyzer = new CodexMeetingAnalyzer({ client, turnTimeoutMs: 10 });

    await expect(analyzer.analyze(analyzeInput())).rejects.toThrow(
      "Timed out waiting for authoritative turn/completed"
    );
    await waitUntil(() =>
      client.requests.some((request) => request.method === "turn/interrupt")
    );
    expect(
      client.requests.find((request) => request.method === "turn/interrupt")
    ).toMatchObject({
      params: { threadId: "thread-1", turnId: "turn-1" }
    });

    client.completeTurn(client.turnResultText, {
      threadId: "thread-1",
      turnId: "turn-1"
    });
    client.holdTurn = false;
    await expect(
      analyzer.analyze({ ...analyzeInput(), threadId: "thread-1" })
    ).resolves.toMatchObject({ threadId: "thread-2", graph });
    expect(
      client.requests.filter((request) => request.method === "thread/start")
    ).toHaveLength(2);
    await analyzer.close();
  });

  it("fails an active wait immediately on child failure and recovers on a fresh thread", async () => {
    const client = new FakeAnalyzerClient();
    client.turnResultText = JSON.stringify(graph);
    client.holdTurn = true;
    const analyzer = new CodexMeetingAnalyzer({ client, turnTimeoutMs: 2_000 });

    const failedAnalysis = analyzer.analyze(analyzeInput());
    await waitUntil(() =>
      client.requests.some((request) => request.method === "turn/start")
    );
    client.failConnection();
    await expect(failedAnalysis).rejects.toThrow(
      "connection failed during an active turn"
    );

    client.connectionGeneration += 1;
    client.holdTurn = false;
    await expect(
      analyzer.analyze({ ...analyzeInput(), threadId: "thread-1" })
    ).resolves.toMatchObject({ threadId: "thread-2", graph });
    expect(
      client.requests.filter((request) => request.method === "thread/start")
    ).toHaveLength(2);
    await analyzer.close();
  });

  it("detects a child failure that races the turn/start response", async () => {
    const client = new FakeAnalyzerClient();
    client.holdTurn = true;
    client.failAfterTurnStartResponse = true;
    const analyzer = new CodexMeetingAnalyzer({ client, turnTimeoutMs: 2_000 });

    await expect(analyzer.analyze(analyzeInput())).rejects.toThrow(
      "connection failed during analysis"
    );
    await waitUntil(() =>
      client.requests.some((request) => request.method === "turn/interrupt")
    );
    expect(
      client.requests.filter((request) => request.method === "turn/start")
    ).toHaveLength(1);
    await analyzer.close();
  });

  it("prefers the deduplicated final_answer item over commentary", async () => {
    const client = new FakeAnalyzerClient();
    client.holdTurn = true;
    const analyzer = new CodexMeetingAnalyzer({ client, turnTimeoutMs: 2_000 });

    const analysis = analyzer.analyze(analyzeInput());
    await waitUntil(() =>
      client.requests.some((request) => request.method === "turn/start")
    );
    client.emitAgentMessage("not structured output", {
      id: "commentary",
      phase: "commentary"
    });
    client.emitAgentMessage(JSON.stringify(graph), {
      id: "answer",
      phase: "final_answer"
    });
    client.completeTurn("ignored", {
      emitMessage: false,
      items: [
        {
          type: "agentMessage",
          id: "answer",
          text: JSON.stringify(graph),
          phase: "final_answer"
        },
        {
          type: "agentMessage",
          id: "commentary",
          text: "still not structured output",
          phase: "commentary"
        }
      ]
    });

    await expect(analysis).resolves.toMatchObject({ graph });
    await analyzer.close();
  });

  it("reports configured model preflight failures through analyzer readiness", async () => {
    const client = new FakeAnalyzerClient();
    client.preflightResult = {
      ready: false,
      detail: "Configured model is unavailable."
    };
    const analyzer = new CodexMeetingAnalyzer({
      client,
      model: "gpt-scout",
      effort: "low"
    });

    await expect(analyzer.checkReadiness()).resolves.toEqual({
      ready: false,
      detail: "Configured model is unavailable."
    });
    expect(client.preflightOptions).toEqual([
      { model: "gpt-scout", effort: "low" }
    ]);
    await analyzer.close();
    await expect(analyzer.checkReadiness()).resolves.toMatchObject({
      ready: false
    });
  });
});
