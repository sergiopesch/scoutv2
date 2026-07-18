import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  AppServerRpcError,
  CodexAppServerClient,
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

  kill(signal?: NodeJS.Signals): boolean {
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

const nextTick = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

const initialize = async (
  client: CodexAppServerClient,
  process: FakeAppServerProcess
): Promise<void> => {
  const pending = client.initialize();
  await nextTick();
  const initializeRequest = process.requests[0];
  expect(initializeRequest?.method).toBe("initialize");
  process.respond({ id: initializeRequest?.id, result: { userAgent: "test" } });
  await pending;
  await nextTick();
};

describe("CodexAppServerClient", () => {
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

  it("surfaces an app-server JSON-RPC error without retrying the request", async () => {
    const process = new FakeAppServerProcess();
    const client = new CodexAppServerClient({
      processFactory: () => process,
      requestTimeoutMs: 2_000
    });
    await initialize(client, process);

    const request = client.request("turn/start", { threadId: "thread-1" });
    await nextTick();
    const turnRequest = process.requests.at(-1);
    process.respond({
      id: turnRequest?.id,
      error: { code: -32001, message: "server overloaded" }
    });

    await expect(request).rejects.toEqual(
      new AppServerRpcError(-32001, "server overloaded")
    );
    expect(
      process.requests.filter((entry) => entry.method === "turn/start")
    ).toHaveLength(1);
    await client.close();
  });
});
