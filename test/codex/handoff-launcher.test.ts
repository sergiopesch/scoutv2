import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type {
  CodexModelCapability,
  CodexPreflightOptions,
  CodexPreflightResult
} from "../../src/server/codex/app-server-client.js";
import {
  CodexHandoffLaunchError,
  CodexHandoffLauncher,
  type AppServerHandoffClient
} from "../../src/server/codex/handoff-launcher.js";
import { SessionStore } from "../../src/server/session-store.js";

const endedSession = () => {
  const store = new SessionStore();
  const session = store.create(
    "https://meet.example.invalid/orders",
    "session-launch-1234"
  );
  store.upsertParticipant(session.id, { id: "operator", name: "Scout" });
  store.upsertParticipant(session.id, { id: "customer", name: "Morgan" });
  store.selectOperator(session.id, "operator");
  store.appendUtterance(session.id, {
    id: "utt-1",
    sequence: 1,
    participantId: "customer",
    participantName: "Morgan",
    text: "Orders are re-keyed before allocation.",
    startedAt: 1,
    endedAt: 2,
    finalized: true
  });
  store.acceptGraph(session.id, {
    topic: {
      id: "orders",
      label: "Order fulfilment",
      evidenceUtteranceIds: ["utt-1"]
    },
    nodes: [],
    edges: [],
    pains: [],
    contradictions: []
  });
  store.setStatus(session.id, "ended");
  store.editPostCall(
    session.id,
    1,
    store.getRequired(session.id).graph,
    "Prioritize allocation latency."
  );
  return store.getRequired(session.id);
};

const model: CodexModelCapability = {
  id: "gpt-5.6-sol",
  model: "gpt-5.6-sol",
  displayName: "GPT-5.6 Sol",
  hidden: false,
  isDefault: true,
  defaultReasoningEffort: "high",
  supportedReasoningEfforts: ["medium", "high", "xhigh"]
};

class FakeHandoffClient implements AppServerHandoffClient {
  readonly requests: Array<{
    method: string;
    params: Record<string, unknown>;
  }> = [];
  readonly preflightOptions: CodexPreflightOptions[] = [];
  initializeCount = 0;
  closeCount = 0;
  nextThread = 1;
  nextTurn = 1;
  leadThreadId?: string;
  unrelatedFork = false;
  preflightResults: CodexPreflightResult[] = [
    { ready: true, connectionGeneration: 1, model }
  ];

  async initialize(): Promise<void> {
    this.initializeCount += 1;
  }

  async preflight(
    options: CodexPreflightOptions = {}
  ): Promise<CodexPreflightResult> {
    this.preflightOptions.push(options);
    return (
      this.preflightResults.shift() ?? {
        ready: true,
        connectionGeneration: 1,
        model
      }
    );
  }

  async request<T>(
    method: string,
    params: Record<string, unknown>
  ): Promise<T> {
    this.requests.push({ method, params });
    if (method === "thread/start") {
      const id = `lead-${this.nextThread++}`;
      this.leadThreadId = id;
      return {
        thread: { id, sessionId: "session-tree-1", forkedFromId: null },
        model: "gpt-5.6-sol"
      } as T;
    }
    if (method === "thread/fork") {
      const id = `work-${this.nextThread++}`;
      return {
        thread: {
          id,
          sessionId: `session-tree-${id}`,
          forkedFromId: this.unrelatedFork ? "other-lead" : this.leadThreadId
        },
        model: "gpt-5.6-sol"
      } as T;
    }
    if (method === "turn/start") {
      return { turn: { id: `turn-${this.nextTurn++}` } } as T;
    }
    if (method === "thread/name/set" || method === "thread/goal/set") {
      return {} as T;
    }
    throw new Error(`Unexpected request ${method}`);
  }

  async close(): Promise<void> {
    this.closeCount += 1;
  }
}

describe("CodexHandoffLauncher", () => {
  it("creates and starts a durable lead plus linked work threads without faking project or pin APIs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "scout-launch-test-"));
    const client = new FakeHandoffClient();
    const launcher = new CodexHandoffLauncher({ client });

    const result = await launcher.launch(root, endedSession());

    expect(result.project).toMatchObject({
      kind: "local-workspace-session-tree",
      nativeProjectCreated: false,
      sessionId: "session-tree-1"
    });
    expect(result.pinning).toEqual({
      requested: true,
      applied: false,
      reason: "Codex app-server does not expose a project or thread pin operation."
    });
    expect(result.tasks).toHaveLength(1);
    expect(result.lead.status).toBe("started");
    expect(result.tasks.every((task) => task.status === "started")).toBe(true);
    expect(new URL(result.launchUrl).pathname).toBe(`/${result.lead.threadId}`);
    expect(result.files).toContain("codex-launch.json");

    const methods = client.requests.map((request) => request.method);
    expect(methods.filter((method) => method === "thread/start")).toHaveLength(1);
    expect(methods.filter((method) => method === "thread/fork")).toHaveLength(1);
    expect(methods.filter((method) => method === "thread/name/set")).toHaveLength(2);
    expect(methods.filter((method) => method === "thread/goal/set")).toHaveLength(2);
    expect(methods.filter((method) => method === "turn/start")).toHaveLength(2);
    expect(methods.some((method) => /project|pin/i.test(method))).toBe(false);

    const threadStarts = client.requests.filter(
      (request) =>
        request.method === "thread/start" || request.method === "thread/fork"
    );
    expect(
      threadStarts.every(
        ({ params }) =>
          params.cwd === result.directory &&
          params.ephemeral === false &&
          params.approvalPolicy === "never" &&
          params.sandbox === "workspace-write"
      )
    ).toBe(true);
    const turns = client.requests.filter(
      (request) => request.method === "turn/start"
    );
    expect(
      turns.every(({ params }) => {
        const input = params.input as Array<{ text?: string }>;
        return input[0]?.text?.includes("Do not spawn subagents") === true;
      })
    ).toBe(true);
    expect(turns[0]?.params).toMatchObject({
      model: "gpt-5.6-sol",
      approvalPolicy: "never"
    });

    const receipt = JSON.parse(
      await readFile(path.join(result.directory, "codex-launch.json"), "utf8")
    );
    expect(receipt).toMatchObject({
      schemaVersion: "1.0",
      project: { sessionId: "session-tree-1" },
      lead: { threadId: result.lead.threadId }
    });
    expect(receipt.tasks).toHaveLength(1);
    expect(
      receipt.tasks.every((task: { status?: string }) => task.status === "started")
    ).toBe(true);
    expect(await readFile(path.join(result.directory, "README.md"), "utf8"))
      .toContain("durable parent artifact");
    await launcher.close();
    expect(client.closeCount).toBe(1);
  });

  it("falls back to the configured default model after a requested model preflight fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "scout-launch-model-"));
    const client = new FakeHandoffClient();
    client.preflightResults = [
      {
        ready: false,
        detail: "requested model unavailable",
        connectionGeneration: 1
      },
      { ready: true, connectionGeneration: 1, model }
    ];
    const launcher = new CodexHandoffLauncher({ client });

    await launcher.launch(root, endedSession());

    expect(client.preflightOptions).toEqual([
      { model: "gpt-5.6-sol", effort: "xhigh" },
      {}
    ]);
  });

  it("coalesces repeated launches of the same reviewed revision", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "scout-launch-idempotent-"));
    const client = new FakeHandoffClient();
    const launcher = new CodexHandoffLauncher({ client });
    const snapshot = endedSession();

    const [first, second] = await Promise.all([
      launcher.launch(root, snapshot),
      launcher.launch(root, snapshot)
    ]);
    const third = await launcher.launch(root, snapshot);

    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(
      client.requests.filter((request) => request.method === "thread/start")
    ).toHaveLength(1);
  });

  it("does not create an app-server client until the first real launch", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "scout-launch-lazy-"));
    const client = new FakeHandoffClient();
    let factoryCalls = 0;
    const launcher = new CodexHandoffLauncher({
      clientFactory: () => {
        factoryCalls += 1;
        return client;
      }
    });

    expect(factoryCalls).toBe(0);
    await launcher.close();
    expect(factoryCalls).toBe(0);

    await launcher.launch(root, endedSession());
    expect(factoryCalls).toBe(1);
    await launcher.close();
    expect(client.closeCount).toBe(1);
  });

  it("rejects ambiguous eager and lazy client configuration", () => {
    const client = new FakeHandoffClient();
    expect(
      () =>
        new CodexHandoffLauncher({
          client,
          clientFactory: () => client
        })
    ).toThrow("a client or a client factory, not both");
  });

  it("fails closed when a fork is not linked to the lead session tree", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "scout-launch-invalid-"));
    const client = new FakeHandoffClient();
    client.unrelatedFork = true;
    const launcher = new CodexHandoffLauncher({ client });

    const failure = launcher.launch(root, endedSession());

    await expect(failure).rejects.toBeInstanceOf(CodexHandoffLaunchError);
    await expect(failure).rejects.toMatchObject({
      createdThreadIds: ["lead-1"]
    });
    expect(
      client.requests.some((request) => request.method === "turn/start")
    ).toBe(false);
  });
});
