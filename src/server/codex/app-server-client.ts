import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

type JsonObject = Record<string, unknown>;

export interface RpcNotification {
  method: string;
  params?: unknown;
}

interface RpcResponse {
  id: number | string;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface AppServerProcess {
  stdin: Writable;
  stdout: Readable;
  stderr?: Readable;
  kill(signal?: NodeJS.Signals): boolean;
  once(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void
  ): this;
  once(event: "error", listener: (error: Error) => void): this;
}

export interface AppServerClientOptions {
  command?: string;
  args?: string[];
  requestTimeoutMs?: number;
  processFactory?: () => AppServerProcess;
}

export class AppServerRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown
  ) {
    super(`Codex app-server error ${code}: ${message}`);
    this.name = "AppServerRpcError";
  }
}

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

type ClientState =
  | "new"
  | "initializing"
  | "ready"
  | "failed"
  | "closing"
  | "closed";

const isRpcResponse = (value: unknown): value is RpcResponse => {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    (typeof candidate.id === "number" || typeof candidate.id === "string") &&
    ("result" in candidate || "error" in candidate)
  );
};

const isNotification = (value: unknown): value is RpcNotification => {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.method === "string" && !("id" in candidate);
};

export class CodexAppServerClient {
  private readonly child: AppServerProcess;
  private readonly requestTimeoutMs: number;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly events = new EventEmitter();
  private readonly lineReader;
  private nextRequestId = 1;
  private state: ClientState = "new";
  private initializePromise?: Promise<void>;
  private closePromise?: Promise<void>;
  private stderrTail = "";

  constructor(options: AppServerClientOptions = {}) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.child =
      options.processFactory?.() ??
      (spawn(
        options.command ?? "codex",
        options.args ?? ["app-server", "--stdio"],
        {
          stdio: ["pipe", "pipe", "pipe"]
        }
      ) as AppServerProcess);

    this.lineReader = createInterface({ input: this.child.stdout });
    this.lineReader.on("line", (line) => this.handleLine(line));
    this.child.stderr?.setEncoding("utf8");
    this.child.stderr?.on("data", (chunk: string | Buffer) => {
      this.stderrTail = `${this.stderrTail}${chunk.toString()}`.slice(-4_000);
    });
    this.child.once("error", (error) => this.fail(error));
    this.child.once("exit", (code, signal) => {
      if (this.state !== "closing" && this.state !== "closed") {
        const detail = this.stderrTail.trim();
        this.fail(
          new Error(
            `Codex app-server exited unexpectedly (code=${String(code)}, signal=${String(signal)})${detail ? `: ${detail}` : ""}`
          )
        );
      }
      this.state = "closed";
      this.events.emit("exit");
    });
  }

  initialize(): Promise<void> {
    if (this.state === "ready") return Promise.resolve();
    if (this.initializePromise) return this.initializePromise;
    if (this.state !== "new") {
      return Promise.reject(
        new Error(`Cannot initialize app-server client while ${this.state}.`)
      );
    }

    this.state = "initializing";
    this.initializePromise = this.sendRequest(
      "initialize",
      {
        clientInfo: {
          name: "scoutv2-live-architect",
          title: "Scout v2 Live Architect",
          version: "0.1.0"
        },
        capabilities: {
          experimentalApi: false,
          requestAttestation: false
        }
      },
      true
    ).then(() => {
      this.writeMessage({ method: "initialized" });
      this.state = "ready";
    });
    return this.initializePromise;
  }

  async request<T>(method: string, params: JsonObject): Promise<T> {
    if (this.state !== "ready") {
      throw new Error("Codex app-server client must be initialized first.");
    }
    return (await this.sendRequest(method, params, false)) as T;
  }

  onNotification(
    listener: (notification: RpcNotification) => void
  ): () => void {
    this.events.on("notification", listener);
    return () => this.events.off("notification", listener);
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    if (this.state === "closed") return Promise.resolve();

    this.state = "closing";
    this.closePromise = new Promise<void>((resolve) => {
      const forceTimer = setTimeout(() => {
        this.child.kill("SIGTERM");
        resolve();
      }, 1_000);
      forceTimer.unref();

      this.events.once("exit", () => {
        clearTimeout(forceTimer);
        resolve();
      });
      this.lineReader.close();
      this.child.stdin.end();
    }).finally(() => {
      this.state = "closed";
      this.rejectPending(new Error("Codex app-server client closed."));
    });

    return this.closePromise;
  }

  private sendRequest(
    method: string,
    params: JsonObject,
    allowBeforeReady: boolean
  ): Promise<unknown> {
    if (!allowBeforeReady && this.state !== "ready") {
      return Promise.reject(
        new Error("Codex app-server client must be initialized first.")
      );
    }
    if (this.state === "closing" || this.state === "closed") {
      return Promise.reject(new Error("Codex app-server client is closed."));
    }

    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `Codex app-server request timed out: ${method} (id=${String(id)}).`
          )
        );
      }, this.requestTimeoutMs);
      timeout.unref();
      this.pending.set(id, { resolve, reject, timeout });
      this.writeMessage({ method, params, id });
    });
  }

  private writeMessage(message: JsonObject): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;

    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.fail(new Error(`Invalid JSON from Codex app-server: ${line}`));
      return;
    }

    if (isRpcResponse(message)) {
      const numericId =
        typeof message.id === "number" ? message.id : Number(message.id);
      const pending = this.pending.get(numericId);
      if (!pending) return;
      this.pending.delete(numericId);
      clearTimeout(pending.timeout);
      if (message.error) {
        pending.reject(
          new AppServerRpcError(
            message.error.code,
            message.error.message,
            message.error.data
          )
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (isNotification(message)) {
      this.events.emit("notification", message);
    }
  }

  private fail(error: Error): void {
    if (this.state !== "closing" && this.state !== "closed") {
      this.state = "failed";
    }
    this.rejectPending(error);
    this.events.emit("failure", error);
  }

  private rejectPending(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
    this.pending.clear();
  }
}
