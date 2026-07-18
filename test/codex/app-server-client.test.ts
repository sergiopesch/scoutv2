import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  AppServerRequestTimeoutError,
  AppServerRpcError,
  buildCapabilityIsolatedAppServerArgs,
  CodexAppServerClient,
  parseConfiguredMcpServerNames,
  type AppServerProcess
} from "../../src/server/codex/app-server-client.js";

class FakeAppServerProcess
  extends EventEmitter
  implements AppServerProcess
{
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly requests: Array<Record<string, unknown>> = [];
  readonly killSignals: Array<NodeJS.Signals | undefined> = [];
  private inputBuffer = "";

  constructor() {
    super();
    this.stdin.setEncoding("utf8");
    this.stdin.on("data", (chunk: string) => {
      this.inputBuffer += chunk;
      const lines = this.inputBuffer.split("\n");
      this.inputBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line) this.requests.push(JSON.parse(line));
      }
    });
    this.stdin.on("finish", () => this.emit("exit", 0, null));
  }

  respond(message: unknown): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  exitUnexpectedly(code = 1): void {
    this.emit("exit", code, null);
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.killSignals.push(signal);
    this.emit("exit", null, signal ?? "SIGTERM");
    return true;
  }

  override once(
    event: "exit" | "error",
    listener:
      | ((code: number | null, signal: NodeJS.Signals | null) => void)
      | ((error: Error) => void)
  ): this {
    return super.once(event, listener);
  }
}

class StubbornAppServerProcess extends FakeAppServerProcess {
  constructor() {
    super();
    this.stdin.removeAllListeners("finish");
  }

  override kill(signal?: NodeJS.Signals): boolean {
    this.killSignals.push(signal);
    if (signal === "SIGKILL") this.emit("exit", null, signal);
    return true;
  }
}

const nextTick = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

const waitUntil = async (predicate: () => boolean): Promise<void> => {
  for (let attempts = 0; attempts < 100; attempts += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Condition was not reached.");
};

const lastRequest = (
  process: FakeAppServerProcess,
  method: string
): Record<string, unknown> | undefined =>
  [...process.requests]
    .reverse()
    .find((request) => request.method === method);

const initialize = async (
  client: CodexAppServerClient,
  process: FakeAppServerProcess
): Promise<void> => {
  const pending = client.initialize();
  await waitUntil(() =>
    process.requests.some((request) => request.method === "initialize")
  );
  const initializeRequest = lastRequest(process, "initialize");
  process.respond({ id: initializeRequest?.id, result: { userAgent: "test" } });
  await pending;
  await nextTick();
};

describe("CodexAppServerClient", () => {
  it("builds validated per-server MCP disable overrides deterministically", () => {
    const names = parseConfiguredMcpServerNames(
      JSON.stringify([
        { name: "zeta_server", enabled: true },
        { name: "alpha-server", enabled: false },
        { name: "zeta_server", enabled: true }
      ])
    );
    expect(names).toEqual(["alpha-server", "zeta_server"]);

    const args = buildCapabilityIsolatedAppServerArgs(
      ["app-server", "--stdio", "-c", "features.plugins=true"],
      names
    );
    expect(args.slice(0, 4)).toEqual([
      "app-server",
      "--stdio",
      "-c",
      "features.plugins=true"
    ]);
    expect(args.lastIndexOf("features.plugins=false")).toBeGreaterThan(
      args.indexOf("features.plugins=true")
    );
    expect(args).toContain('web_search="disabled"');
    expect(args).toContain("apps._default.enabled=false");
    expect(args.slice(-4)).toEqual([
      "-c",
      "mcp_servers.alpha-server.enabled=false",
      "-c",
      "mcp_servers.zeta_server.enabled=false"
    ]);
    expect(() =>
      parseConfiguredMcpServerNames(JSON.stringify([{ name: "unsafe.name" }]))
    ).toThrow("invalid server name");
  });

  it("keeps the processFactory path isolated and independent of an external Codex CLI", async () => {
    const process = new FakeAppServerProcess();
    let invocation:
      | { command: string; args: string[] }
      | undefined;
    const client = new CodexAppServerClient({
      command: "/not-a-real-codex-binary",
      processFactory: (command, args) => {
        invocation = { command, args };
        return process;
      },
      requestTimeoutMs: 2_000
    });

    expect(invocation?.command).toBe("/not-a-real-codex-binary");
    expect(invocation?.args).toEqual(
      expect.arrayContaining([
        "app-server",
        "--stdio",
        "features.plugins=false",
        "features.apps=false",
        "features.enable_mcp_apps=false",
        "features.multi_agent=false",
        'web_search="disabled"',
        "apps._default.enabled=false"
      ])
    );
    await client.close();
  });

  it("frames one initialize, sends initialized, correlates out-of-order responses, and forwards notifications", async () => {
    const process = new FakeAppServerProcess();
    const client = new CodexAppServerClient({
      processFactory: () => process,
      requestTimeoutMs: 2_000
    });

    const firstInitialize = client.initialize();
    const secondInitialize = client.initialize();
    await nextTick();
    expect(
      process.requests.filter((request) => request.method === "initialize")
    ).toHaveLength(1);
    process.respond({ id: 1, result: { userAgent: "test" } });
    await Promise.all([firstInitialize, secondInitialize]);
    await nextTick();
    expect(process.requests[0]).toMatchObject({
      method: "initialize",
      params: { capabilities: { experimentalApi: true } }
    });
    expect(process.requests[1]).toEqual({ method: "initialized" });

    const notifications: string[] = [];
    client.onNotification((notification) =>
      notifications.push(notification.method)
    );
    const first = client.request<{ value: string }>("thread/start", {
      cwd: "/tmp"
    });
    const second = client.request<{ value: string }>("model/list", {});
    await nextTick();
    process.respond({ id: 3, result: { value: "second" } });
    process.respond({
      method: "thread/status/changed",
      params: { threadId: "thread-1" }
    });
    process.respond({ id: 2, result: { value: "first" } });

    await expect(first).resolves.toEqual({ value: "first" });
    await expect(second).resolves.toEqual({ value: "second" });
    expect(notifications).toEqual(["thread/status/changed"]);
    await client.close();
  });

  it("retries only explicit -32001 overloads with bounded exponential jitter", async () => {
    const process = new FakeAppServerProcess();
    const delays: number[] = [];
    const client = new CodexAppServerClient({
      processFactory: () => process,
      requestTimeoutMs: 2_000,
      overloadMaxRetries: 2,
      overloadRetryBaseDelayMs: 20,
      overloadRetryMaxDelayMs: 100,
      overloadRetryJitterRatio: 0.5,
      random: () => 1,
      sleep: async (delay) => {
        delays.push(delay);
      }
    });
    await initialize(client, process);

    const request = client.request<{ ok: true }>("turn/start", {
      threadId: "thread-1"
    });
    await waitUntil(
      () =>
        process.requests.filter((entry) => entry.method === "turn/start")
          .length === 1
    );
    let turnRequests = process.requests.filter(
      (entry) => entry.method === "turn/start"
    );
    process.respond({
      id: turnRequests[0]?.id,
      error: { code: -32001, message: "Server overloaded; retry later." }
    });
    await waitUntil(
      () =>
        process.requests.filter((entry) => entry.method === "turn/start")
          .length === 2
    );
    turnRequests = process.requests.filter(
      (entry) => entry.method === "turn/start"
    );
    process.respond({
      id: turnRequests[1]?.id,
      error: { code: -32001, message: "Server overloaded; retry later." }
    });
    await waitUntil(
      () =>
        process.requests.filter((entry) => entry.method === "turn/start")
          .length === 3
    );
    turnRequests = process.requests.filter(
      (entry) => entry.method === "turn/start"
    );
    process.respond({ id: turnRequests[2]?.id, result: { ok: true } });

    await expect(request).resolves.toEqual({ ok: true });
    expect(delays).toEqual([30, 60]);
    expect(turnRequests.map((entry) => entry.params)).toEqual([
      { threadId: "thread-1" },
      { threadId: "thread-1" },
      { threadId: "thread-1" }
    ]);
    await client.close();
  });

  it("stops retrying overloads at the configured bound", async () => {
    const process = new FakeAppServerProcess();
    const client = new CodexAppServerClient({
      processFactory: () => process,
      requestTimeoutMs: 2_000,
      overloadMaxRetries: 1,
      overloadRetryBaseDelayMs: 0,
      sleep: async () => {}
    });
    await initialize(client, process);

    const request = client.request("turn/start", { threadId: "thread-1" });
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      await waitUntil(
        () =>
          process.requests.filter((entry) => entry.method === "turn/start")
            .length === attempt
      );
      const turnRequest = process.requests.filter(
        (entry) => entry.method === "turn/start"
      )[attempt - 1];
      process.respond({
        id: turnRequest?.id,
        error: { code: -32001, message: "server overloaded" }
      });
    }

    await expect(request).rejects.toEqual(
      new AppServerRpcError(-32001, "server overloaded")
    );
    expect(
      process.requests.filter((entry) => entry.method === "turn/start")
    ).toHaveLength(2);
    await client.close();
  });

  it("does not retry ambiguous request timeouts and ignores their late response", async () => {
    const process = new FakeAppServerProcess();
    const client = new CodexAppServerClient({
      processFactory: () => process,
      requestTimeoutMs: 10,
      overloadMaxRetries: 4,
      sleep: async () => {}
    });
    await initialize(client, process);

    const request = client.request("turn/start", { threadId: "thread-1" });
    await waitUntil(() =>
      process.requests.some((entry) => entry.method === "turn/start")
    );
    const timedOut = lastRequest(process, "turn/start");
    await expect(request).rejects.toBeInstanceOf(AppServerRequestTimeoutError);
    expect(
      process.requests.filter((entry) => entry.method === "turn/start")
    ).toHaveLength(1);

    process.respond({ id: timedOut?.id, result: { late: true } });
    const next = client.request<{ ok: true }>("model/list", {});
    await waitUntil(() =>
      process.requests.some((entry) => entry.method === "model/list")
    );
    const nextRequest = lastRequest(process, "model/list");
    process.respond({ id: nextRequest?.id, result: { ok: true } });
    await expect(next).resolves.toEqual({ ok: true });
    await client.close();
  });

  it("fails closed on malformed protocol data without echoing its contents", async () => {
    const process = new FakeAppServerProcess();
    const client = new CodexAppServerClient({
      processFactory: () => process,
      requestTimeoutMs: 2_000
    });
    await initialize(client, process);

    const pending = client.request("model/list", {});
    await waitUntil(() =>
      process.requests.some((entry) => entry.method === "model/list")
    );
    process.stdout.write("private participant transcript is not JSON\n");

    await expect(pending).rejects.toThrow("Invalid JSON from Codex app-server");
    await expect(pending).rejects.not.toThrow("private participant transcript");
    await client.close();
  });

  it("terminates a child before an unterminated protocol frame can grow without bound", async () => {
    const process = new FakeAppServerProcess();
    const client = new CodexAppServerClient({
      processFactory: () => process,
      requestTimeoutMs: 2_000,
      maxFrameBytes: 1_024
    });
    await initialize(client, process);

    const pending = client.request("model/list", {});
    await waitUntil(() =>
      process.requests.some((entry) => entry.method === "model/list")
    );
    process.stdout.write("x".repeat(1_025));

    await expect(pending).rejects.toThrow(/protocol frame exceeded 1024 bytes/);
    await client.close();
  });

  it("escalates shutdown through SIGTERM and SIGKILL and waits for exit", async () => {
    const process = new StubbornAppServerProcess();
    const client = new CodexAppServerClient({
      processFactory: () => process,
      requestTimeoutMs: 2_000,
      processExitGraceMs: 10
    });
    await initialize(client, process);

    await client.close();

    expect(process.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("restarts and reinitializes after an unexpected child exit", async () => {
    const processes = [
      new FakeAppServerProcess(),
      new FakeAppServerProcess()
    ];
    let processIndex = 0;
    const client = new CodexAppServerClient({
      processFactory: () => processes[processIndex++]!,
      requestTimeoutMs: 2_000
    });
    await initialize(client, processes[0]!);
    const firstGeneration = client.getConnectionGeneration();

    const interruptedRequest = client.request("model/list", {});
    await waitUntil(() =>
      processes[0]!.requests.some((entry) => entry.method === "model/list")
    );
    processes[0]!.exitUnexpectedly();
    await expect(interruptedRequest).rejects.toThrow(
      "exited unexpectedly"
    );
    await nextTick();
    await initialize(client, processes[1]!);
    expect(client.getConnectionGeneration()).toBeGreaterThan(firstGeneration);
    expect(processIndex).toBe(2);

    const request = client.request<{ thread: { id: string } }>(
      "thread/resume",
      { threadId: "thread-1" }
    );
    await waitUntil(() =>
      processes[1]!.requests.some(
        (entry) => entry.method === "thread/resume"
      )
    );
    const resume = lastRequest(processes[1]!, "thread/resume");
    processes[1]!.respond({
      id: resume?.id,
      result: { thread: { id: "thread-1" } }
    });
    await expect(request).resolves.toEqual({ thread: { id: "thread-1" } });
    await client.close();
  });

  it("preflights authentication, model availability, and reasoning capability", async () => {
    const process = new FakeAppServerProcess();
    const client = new CodexAppServerClient({
      processFactory: () => process,
      requestTimeoutMs: 2_000
    });

    const preflight = client.preflight({ model: "gpt-scout", effort: "low" });
    await waitUntil(() =>
      process.requests.some((entry) => entry.method === "initialize")
    );
    const initializeRequest = lastRequest(process, "initialize");
    process.respond({ id: initializeRequest?.id, result: { userAgent: "test" } });
    await waitUntil(() =>
      process.requests.some((entry) => entry.method === "account/read")
    );
    const accountRequest = lastRequest(process, "account/read");
    process.respond({
      id: accountRequest?.id,
      result: {
        account: { type: "chatgpt", email: "scout@example.test" },
        requiresOpenaiAuth: true
      }
    });
    await waitUntil(() =>
      process.requests.some((entry) => entry.method === "model/list")
    );
    const modelRequest = lastRequest(process, "model/list");
    process.respond({
      id: modelRequest?.id,
      result: {
        data: [
          {
            id: "catalog-scout",
            model: "gpt-scout",
            displayName: "Scout",
            hidden: false,
            isDefault: true,
            defaultReasoningEffort: "medium",
            supportedReasoningEfforts: [
              { reasoningEffort: "low", description: "Fast" },
              { reasoningEffort: "medium", description: "Balanced" }
            ]
          }
        ],
        nextCursor: null
      }
    });

    await expect(preflight).resolves.toMatchObject({
      ready: true,
      model: {
        model: "gpt-scout",
        supportedReasoningEfforts: ["low", "medium"]
      }
    });
    await client.close();
  });

  it("reports an unauthenticated app-server as not ready", async () => {
    const process = new FakeAppServerProcess();
    const client = new CodexAppServerClient({
      processFactory: () => process,
      requestTimeoutMs: 2_000
    });

    const preflight = client.preflight({ model: "missing-model" });
    await waitUntil(() =>
      process.requests.some((entry) => entry.method === "initialize")
    );
    const initializeRequest = lastRequest(process, "initialize");
    process.respond({ id: initializeRequest?.id, result: { userAgent: "test" } });
    await waitUntil(() =>
      process.requests.some((entry) => entry.method === "account/read")
    );
    const accountRequest = lastRequest(process, "account/read");
    process.respond({
      id: accountRequest?.id,
      result: { account: null, requiresOpenaiAuth: true }
    });

    await expect(preflight).resolves.toMatchObject({
      ready: false,
      detail: "Codex app-server is not authenticated."
    });
    expect(
      process.requests.filter((entry) => entry.method === "model/list")
    ).toHaveLength(0);
    await client.close();
  });

  it("reports an unsupported reasoning effort as not ready", async () => {
    const process = new FakeAppServerProcess();
    const client = new CodexAppServerClient({
      processFactory: () => process,
      requestTimeoutMs: 2_000
    });

    const preflight = client.preflight({
      model: "gpt-scout",
      effort: "ultra"
    });
    await waitUntil(() =>
      process.requests.some((entry) => entry.method === "initialize")
    );
    const initializeRequest = lastRequest(process, "initialize");
    process.respond({ id: initializeRequest?.id, result: { userAgent: "test" } });
    await waitUntil(() =>
      process.requests.some((entry) => entry.method === "account/read")
    );
    const accountRequest = lastRequest(process, "account/read");
    process.respond({
      id: accountRequest?.id,
      result: { account: { type: "apiKey" }, requiresOpenaiAuth: true }
    });
    await waitUntil(() =>
      process.requests.some((entry) => entry.method === "model/list")
    );
    const modelRequest = lastRequest(process, "model/list");
    process.respond({
      id: modelRequest?.id,
      result: {
        data: [
          {
            id: "gpt-scout",
            model: "gpt-scout",
            hidden: false,
            isDefault: true,
            supportedReasoningEfforts: [
              { reasoningEffort: "low", description: "Fast" }
            ]
          }
        ],
        nextCursor: null
      }
    });

    await expect(preflight).resolves.toMatchObject({
      ready: false,
      detail: "Codex model gpt-scout does not support reasoning effort ultra."
    });
    await client.close();
  });
});
