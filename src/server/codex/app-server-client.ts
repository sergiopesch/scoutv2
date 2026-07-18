import { execFileSync, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
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
  processFactory?: (command: string, args: string[]) => AppServerProcess;
  overloadMaxRetries?: number;
  overloadRetryBaseDelayMs?: number;
  overloadRetryMaxDelayMs?: number;
  overloadRetryJitterRatio?: number;
  random?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
  maxFrameBytes?: number;
  processExitGraceMs?: number;
}

export interface CodexModelCapability {
  id: string;
  model: string;
  displayName?: string;
  hidden: boolean;
  isDefault: boolean;
  defaultReasoningEffort?: string;
  supportedReasoningEfforts: string[];
}

export interface CodexPreflightOptions {
  model?: string;
  effort?: string;
}

export interface CodexPreflightResult {
  ready: boolean;
  detail?: string;
  connectionGeneration: number;
  model?: CodexModelCapability;
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

export class AppServerRequestTimeoutError extends Error {
  constructor(
    readonly method: string,
    readonly requestId: number
  ) {
    super(
      `Codex app-server request timed out: ${method} (id=${String(requestId)}).`
    );
    this.name = "AppServerRequestTimeoutError";
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

type ModelListResponse = {
  data?: unknown;
  nextCursor?: unknown;
};

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

const asObject = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const asReasoningEffort = (value: unknown): string | undefined => {
  if (typeof value === "string") return value;
  const effort = asObject(value)?.reasoningEffort;
  return typeof effort === "string" ? effort : undefined;
};

const parseModelCapability = (
  value: unknown
): CodexModelCapability | undefined => {
  const model = asObject(value);
  if (!model || typeof model.id !== "string" || typeof model.model !== "string") {
    return undefined;
  }
  const supportedReasoningEfforts = Array.isArray(
    model.supportedReasoningEfforts
  )
    ? model.supportedReasoningEfforts
        .map(asReasoningEffort)
        .filter((effort): effort is string => effort !== undefined)
    : [];
  return {
    id: model.id,
    model: model.model,
    ...(typeof model.displayName === "string"
      ? { displayName: model.displayName }
      : {}),
    hidden: model.hidden === true,
    isDefault: model.isDefault === true,
    ...(typeof model.defaultReasoningEffort === "string"
      ? { defaultReasoningEffort: model.defaultReasoningEffort }
      : {}),
    supportedReasoningEfforts
  };
};

const MAX_CONFIGURED_MCP_SERVERS = 100;
const MCP_SERVER_NAME = /^[A-Za-z0-9_-]{1,128}$/;
const MCP_DISCOVERY_CONFIG_OVERRIDES = [
  "features.plugins=false",
  "features.apps=false",
  "apps._default.enabled=false"
] as const;
const APP_SERVER_ISOLATION_CONFIG_OVERRIDES = [
  "features.plugins=false",
  "features.apps=false",
  "features.enable_mcp_apps=false",
  "features.tool_search=false",
  "features.browser_use=false",
  "features.computer_use=false",
  "features.js_repl=false",
  "features.multi_agent=false",
  "features.multi_agent_v2=false",
  "features.web_search_request=false",
  "features.web_search_cached=false",
  "features.image_generation=false",
  "features.memory_tool=false",
  'web_search="disabled"',
  "apps._default.enabled=false"
] as const;

const validateConfiguredMcpServerNames = (
  names: readonly string[]
): string[] => {
  if (names.length > MAX_CONFIGURED_MCP_SERVERS) {
    throw new Error(
      "Codex MCP inventory exceeded the configured-server safety limit."
    );
  }
  const uniqueNames = new Set<string>();
  for (const name of names) {
    if (!MCP_SERVER_NAME.test(name)) {
      throw new Error("Codex MCP inventory contained an invalid server name.");
    }
    uniqueNames.add(name);
  }
  return [...uniqueNames].sort();
};

export const parseConfiguredMcpServerNames = (output: string): string[] => {
  let decoded: unknown;
  try {
    decoded = JSON.parse(output);
  } catch {
    throw new Error("Codex MCP inventory returned invalid JSON.");
  }
  if (!Array.isArray(decoded)) {
    throw new Error("Codex MCP inventory returned an invalid response.");
  }
  const names = decoded.map((entry) => {
    const record = asObject(entry);
    if (!record || typeof record.name !== "string") {
      throw new Error("Codex MCP inventory returned an invalid response.");
    }
    return record.name;
  });
  return validateConfiguredMcpServerNames(names);
};

export const buildCapabilityIsolatedAppServerArgs = (
  baseArgs: readonly string[],
  configuredMcpServerNames: readonly string[]
): string[] => [
  ...baseArgs,
  ...APP_SERVER_ISOLATION_CONFIG_OVERRIDES.flatMap((override) => [
    "-c",
    override
  ]),
  ...validateConfiguredMcpServerNames(configuredMcpServerNames).flatMap(
    (name) => ["-c", `mcp_servers.${name}.enabled=false`]
  )
];

const discoverConfiguredMcpServerNames = (command: string): string[] => {
  let output: string;
  try {
    output = execFileSync(
      command,
      [
        ...MCP_DISCOVERY_CONFIG_OVERRIDES.flatMap((override) => [
          "-c",
          override
        ]),
        "mcp",
        "list",
        "--json"
      ],
      {
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 10_000,
        windowsHide: true
      }
    );
  } catch {
    throw new Error("Could not enumerate configured Codex MCP servers.");
  }
  return parseConfiguredMcpServerNames(output);
};

const defaultSleep = (delayMs: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, delayMs));

export class CodexAppServerClient {
  private readonly requestTimeoutMs: number;
  private readonly processFactory: () => AppServerProcess;
  private readonly overloadMaxRetries: number;
  private readonly overloadRetryBaseDelayMs: number;
  private readonly overloadRetryMaxDelayMs: number;
  private readonly overloadRetryJitterRatio: number;
  private readonly random: () => number;
  private readonly sleep: (delayMs: number) => Promise<void>;
  private readonly maxFrameBytes: number;
  private readonly processExitGraceMs: number;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly events = new EventEmitter();
  private readonly terminationPromises = new Map<
    AppServerProcess,
    Promise<void>
  >();
  private child?: AppServerProcess;
  private stdoutBuffer = Buffer.alloc(0);
  private nextRequestId = 1;
  private state: ClientState = "new";
  private initializePromise?: Promise<void>;
  private closePromise?: Promise<void>;
  private stderrBytes = 0;
  private connectionGeneration = 0;
  private lastFailure?: Error;

  constructor(options: AppServerClientOptions = {}) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.overloadMaxRetries = Math.max(
      0,
      Math.floor(options.overloadMaxRetries ?? 2)
    );
    this.overloadRetryBaseDelayMs = Math.max(
      0,
      options.overloadRetryBaseDelayMs ?? 100
    );
    this.overloadRetryMaxDelayMs = Math.max(
      this.overloadRetryBaseDelayMs,
      options.overloadRetryMaxDelayMs ?? 2_000
    );
    this.overloadRetryJitterRatio = Math.min(
      1,
      Math.max(0, options.overloadRetryJitterRatio ?? 0.25)
    );
    this.random = options.random ?? Math.random;
    this.sleep = options.sleep ?? defaultSleep;
    this.maxFrameBytes = Math.max(
      1_024,
      options.maxFrameBytes ?? 8 * 1_024 * 1_024
    );
    this.processExitGraceMs = Math.max(
      10,
      options.processExitGraceMs ?? 1_000
    );
    const command = options.command ?? "codex";
    const baseArgs = options.args ?? ["app-server", "--stdio"];
    if (options.processFactory) {
      const processFactory = options.processFactory;
      this.processFactory = () =>
        processFactory(
          command,
          buildCapabilityIsolatedAppServerArgs(baseArgs, [])
        );
    } else {
      this.processFactory = () => {
        const configuredMcpServerNames =
          discoverConfiguredMcpServerNames(command);
        return spawn(
          command,
          buildCapabilityIsolatedAppServerArgs(
            baseArgs,
            configuredMcpServerNames
          ),
          {
            stdio: ["pipe", "pipe", "pipe"]
          }
        ) as AppServerProcess;
      };
    }
    this.startProcess();
  }

  initialize(): Promise<void> {
    if (this.state === "ready") return Promise.resolve();
    if (this.initializePromise) return this.initializePromise;
    if (this.state === "closing" || this.state === "closed") {
      return Promise.reject(new Error("Codex app-server client is closed."));
    }
    const initialization = this.initializeConnection();
    const tracked = initialization.finally(() => {
      if (this.initializePromise === tracked) this.initializePromise = undefined;
    });
    this.initializePromise = tracked;
    return tracked;
  }

  private async initializeConnection(): Promise<void> {
    if (this.state === "failed" || !this.child) {
      await this.disposeCurrentProcess();
      if (this.state === "closing" || this.state === "closed") {
        throw new Error("Codex app-server client is closed.");
      }
      this.startProcess();
    }
    if (this.state === "failed" || !this.child) {
      throw (
        this.lastFailure ?? new Error("Codex app-server process is unavailable.")
      );
    }
    if (this.state !== "new") {
      throw new Error(`Cannot initialize app-server client while ${this.state}.`);
    }

    const generation = this.connectionGeneration;
    this.state = "initializing";
    try {
      await this.sendWithOverloadRetry(
        "initialize",
        {
          clientInfo: {
            name: "scoutv2-live-architect",
            title: "Scout v2 Live Architect",
            version: "0.1.0"
          },
          capabilities: {
            experimentalApi: true,
            requestAttestation: false
          }
        },
        true
      );
      if (
        this.state !== "initializing" ||
        generation !== this.connectionGeneration
      ) {
        throw new Error("Codex app-server connection changed during initialize.");
      }
      this.writeMessage({ method: "initialized" });
      this.state = "ready";
      this.lastFailure = undefined;
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      if (generation === this.connectionGeneration) this.fail(normalized, true);
      throw normalized;
    }
  }

  async request<T>(method: string, params: JsonObject): Promise<T> {
    if (this.state !== "ready") {
      throw new Error("Codex app-server client must be initialized first.");
    }
    return (await this.sendWithOverloadRetry(method, params, false)) as T;
  }

  getConnectionGeneration(): number {
    return this.connectionGeneration;
  }

  async listModels(): Promise<CodexModelCapability[]> {
    await this.initialize();
    const models: CodexModelCapability[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const response = await this.request<ModelListResponse>("model/list", {
        includeHidden: true,
        limit: 100,
        ...(cursor ? { cursor } : {})
      });
      if (!Array.isArray(response.data)) {
        throw new Error("Codex model/list returned an invalid response.");
      }
      for (const entry of response.data) {
        const model = parseModelCapability(entry);
        if (model) models.push(model);
      }
      if (typeof response.nextCursor !== "string" || !response.nextCursor) {
        return models;
      }
      cursor = response.nextCursor;
    }
    throw new Error("Codex model/list exceeded the pagination safety limit.");
  }

  async preflight(
    options: CodexPreflightOptions = {}
  ): Promise<CodexPreflightResult> {
    try {
      await this.initialize();
      const auth = await this.request<{
        account?: unknown;
        requiresOpenaiAuth?: unknown;
      }>("account/read", { refreshToken: false });
      if (auth.requiresOpenaiAuth === true && !auth.account) {
        return {
          ready: false,
          detail: "Codex app-server is not authenticated.",
          connectionGeneration: this.connectionGeneration
        };
      }

      const models = await this.listModels();
      const selected = options.model
        ? models.find(
            (candidate) =>
              candidate.model === options.model || candidate.id === options.model
          )
        : models.find((candidate) => candidate.isDefault) ?? models[0];
      if (!selected) {
        return {
          ready: false,
          detail: options.model
            ? `Configured Codex model ${options.model} is unavailable.`
            : "Codex app-server reported no available models.",
          connectionGeneration: this.connectionGeneration
        };
      }
      if (
        options.effort &&
        selected.supportedReasoningEfforts.length > 0 &&
        !selected.supportedReasoningEfforts.includes(options.effort)
      ) {
        return {
          ready: false,
          detail: `Codex model ${selected.model} does not support reasoning effort ${options.effort}.`,
          connectionGeneration: this.connectionGeneration,
          model: selected
        };
      }
      return {
        ready: true,
        connectionGeneration: this.connectionGeneration,
        model: selected
      };
    } catch (error) {
      return {
        ready: false,
        detail:
          error instanceof Error
            ? error.message
            : "Codex app-server preflight failed.",
        connectionGeneration: this.connectionGeneration
      };
    }
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

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    if (this.state === "closed") return Promise.resolve();

    this.state = "closing";
    this.initializePromise = undefined;
    this.rejectPending(new Error("Codex app-server client closed."));
    const child = this.child;
    if (!child) {
      this.state = "closed";
      return Promise.resolve();
    }

    this.closePromise = this.terminateProcess(child).then(() => {
      this.state = "closed";
      if (this.child === child) this.child = undefined;
      this.stdoutBuffer = Buffer.alloc(0);
      this.rejectPending(new Error("Codex app-server client closed."));
    });

    return this.closePromise;
  }

  private startProcess(): void {
    this.state = "new";
    this.stderrBytes = 0;
    this.stdoutBuffer = Buffer.alloc(0);
    this.lastFailure = undefined;
    const generation = this.connectionGeneration + 1;
    this.connectionGeneration = generation;

    let child: AppServerProcess;
    try {
      child = this.processFactory();
    } catch (error) {
      const normalized =
        error instanceof Error ? error : new Error(String(error));
      this.state = "failed";
      this.lastFailure = normalized;
      return;
    }

    this.child = child;
    const handleStreamError = (error: Error): void => {
      if (generation === this.connectionGeneration && child === this.child) {
        this.fail(error, true);
      }
    };
    child.stdin.on("error", handleStreamError);
    child.stdout.on("error", handleStreamError);
    child.stdout.on("data", (chunk: string | Buffer) => {
      if (generation === this.connectionGeneration && child === this.child) {
        this.handleStdoutChunk(chunk);
      }
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string | Buffer) => {
      if (generation !== this.connectionGeneration || child !== this.child) {
        return;
      }
      this.stderrBytes += Buffer.byteLength(chunk);
    });
    child.once("error", (error) => {
      if (generation === this.connectionGeneration && child === this.child) {
        this.fail(error, false);
      }
    });
    child.once("exit", (code, signal) => {
      if (generation !== this.connectionGeneration || child !== this.child) {
        return;
      }
      this.stdoutBuffer = Buffer.alloc(0);
      this.child = undefined;
      if (this.state === "closing" || this.state === "closed") {
        this.state = "closed";
      } else if (this.state !== "failed") {
        this.fail(
          new Error(
            `Codex app-server exited unexpectedly (code=${String(code)}, signal=${String(signal)}, stderrBytes=${String(this.stderrBytes)}).`
          ),
          false
        );
      }
      this.events.emit("exit");
    });
  }

  private async disposeCurrentProcess(): Promise<void> {
    const child = this.child;
    if (!child) return;
    await this.terminateProcess(child);
    if (this.child === child) this.child = undefined;
    this.stdoutBuffer = Buffer.alloc(0);
  }

  private terminateProcess(child: AppServerProcess): Promise<void> {
    const existing = this.terminationPromises.get(child);
    if (existing) return existing;

    const exited = new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
    });
    const waitForExit = async (): Promise<boolean> => {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), this.processExitGraceMs);
        timer.unref();
      });
      const result = await Promise.race([exited.then(() => true), timeout]);
      if (timer) clearTimeout(timer);
      return result;
    };

    const termination = (async () => {
      if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end();
      if (await waitForExit()) return;
      child.kill("SIGTERM");
      if (await waitForExit()) return;
      child.kill("SIGKILL");
      if (await waitForExit()) return;
      throw new Error(
        "Codex app-server did not exit after stdin close, SIGTERM, and SIGKILL."
      );
    })().finally(() => {
      this.terminationPromises.delete(child);
    });
    this.terminationPromises.set(child, termination);
    return termination;
  }

  private async sendWithOverloadRetry(
    method: string,
    params: JsonObject,
    allowBeforeReady: boolean
  ): Promise<unknown> {
    for (let retry = 0; ; retry += 1) {
      try {
        return await this.sendRequest(method, params, allowBeforeReady);
      } catch (error) {
        if (
          !(error instanceof AppServerRpcError) ||
          error.code !== -32001 ||
          retry >= this.overloadMaxRetries
        ) {
          throw error;
        }
        const exponentialDelay = Math.min(
          this.overloadRetryMaxDelayMs,
          this.overloadRetryBaseDelayMs * 2 ** retry
        );
        const jitter =
          1 +
          (this.random() * 2 - 1) * this.overloadRetryJitterRatio;
        await this.sleep(Math.max(0, Math.round(exponentialDelay * jitter)));
      }
    }
  }

  private sendRequest(
    method: string,
    params: JsonObject,
    allowBeforeReady: boolean
  ): Promise<unknown> {
    if (
      !allowBeforeReady &&
      this.state !== "ready"
    ) {
      return Promise.reject(
        new Error("Codex app-server client must be initialized first.")
      );
    }
    if (allowBeforeReady && this.state !== "initializing") {
      return Promise.reject(
        new Error("Codex app-server client is not initializing.")
      );
    }
    if (this.state === "closing" || this.state === "closed") {
      return Promise.reject(new Error("Codex app-server client is closed."));
    }
    if (!this.child) {
      return Promise.reject(
        this.lastFailure ?? new Error("Codex app-server process is unavailable.")
      );
    }

    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new AppServerRequestTimeoutError(method, id));
      }, this.requestTimeoutMs);
      timeout.unref();
      this.pending.set(id, { resolve, reject, timeout });
      try {
        this.writeMessage({ method, params, id });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timeout);
        const normalized =
          error instanceof Error ? error : new Error(String(error));
        reject(normalized);
        this.fail(normalized, true);
      }
    });
  }

  private writeMessage(message: JsonObject): void {
    if (!this.child) {
      throw new Error("Codex app-server process is unavailable.");
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;

    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.fail(
        new Error(
          `Invalid JSON from Codex app-server (lineLength=${String(line.length)}).`
        ),
        true
      );
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

  private handleStdoutChunk(chunk: string | Buffer): void {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let segmentStart = 0;
    for (let index = 0; index < bytes.length; index += 1) {
      if (bytes[index] !== 0x0a) continue;
      const segment = bytes.subarray(segmentStart, index);
      if (!this.appendStdoutSegment(segment)) return;
      let line = this.stdoutBuffer;
      if (line.at(-1) === 0x0d) line = line.subarray(0, line.length - 1);
      this.stdoutBuffer = Buffer.alloc(0);
      this.handleLine(line.toString("utf8"));
      if (this.state === "failed") return;
      segmentStart = index + 1;
    }
    if (segmentStart < bytes.length) {
      this.appendStdoutSegment(bytes.subarray(segmentStart));
    }
  }

  private appendStdoutSegment(segment: Buffer): boolean {
    if (this.stdoutBuffer.length + segment.length > this.maxFrameBytes) {
      this.fail(
        new Error(
          `Codex app-server protocol frame exceeded ${String(this.maxFrameBytes)} bytes.`
        ),
        true
      );
      return false;
    }
    if (segment.length > 0) {
      this.stdoutBuffer =
        this.stdoutBuffer.length === 0
          ? Buffer.from(segment)
          : Buffer.concat([this.stdoutBuffer, segment]);
    }
    return true;
  }

  private fail(error: Error, terminateProcess: boolean): void {
    if (this.state === "closing" || this.state === "closed") return;
    const wasFailed = this.state === "failed";
    this.state = "failed";
    this.lastFailure = error;
    this.initializePromise = undefined;
    this.rejectPending(error);
    if (!wasFailed) this.events.emit("failure", error);
    if (terminateProcess) {
      const child = this.child;
      if (child) {
        void this.terminateProcess(child).catch((terminationError: unknown) => {
          this.lastFailure =
            terminationError instanceof Error
              ? terminationError
              : new Error(String(terminationError));
        });
      }
    }
  }

  private rejectPending(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
    this.pending.clear();
  }
}
