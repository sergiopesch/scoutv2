import { Webhook } from "svix";
import type {
  DependencyReadiness,
  NormalizedMeetingEvent,
  RecallAdapter,
  RecallBotConfig,
  RecallBotResult
} from "../contracts.js";
import {
  normalizeRecallPayload,
  recallSourceBotId
} from "./recall-normalizer.js";
import {
  recallPublicUrl,
  validateRecallApiBaseUrl,
  validateRecallMeetingUrl,
  validateRecallPublicBaseUrl,
  validateRecallVerificationSecret
} from "./recall-validation.js";

export type RecallOutputMode = "screenshare" | "camera";
export type RecallWebhookVerificationMode =
  | "workspace"
  | "legacy-svix-dashboard";

export interface RecallRetryOptions {
  maxAttempts?: number;
  requestTimeoutMs?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
}

export interface RecallClientOptions {
  apiBaseUrl: string;
  apiKey: string;
  /**
   * Backwards-compatible name for the workspace verification secret. New
   * integrations should use `workspaceVerificationSecret` so a legacy Svix
   * dashboard secret cannot accidentally be used for a real-time endpoint.
   */
  webhookSecret?: string;
  workspaceVerificationSecret?: string;
  legacySvixWebhookSecret?: string;
  webhookVerificationMode?: RecallWebhookVerificationMode;
  outputMode?: RecallOutputMode;
  languageCode?: string;
  fetch?: typeof globalThis.fetch;
  retry?: RecallRetryOptions;
}

interface RecallCreateBotResponse {
  id: string;
}

interface RecallWebpageOutput {
  kind: "webpage";
  config: {
    url: string;
  };
}

export interface RecallCreateBotRequest {
  meeting_url: string;
  bot_name: string;
  metadata: {
    scout_correlation_id: string;
  };
  recording_config: {
    transcript: {
      provider: {
        recallai_streaming: {
          mode: "prioritize_low_latency";
          language_code: string;
        };
      };
      diarization: {
        use_separate_streams_when_available: true;
      };
    };
    realtime_endpoints: Array<{
      type: "webhook";
      url: string;
      events: Array<
        | "transcript.partial_data"
        | "transcript.data"
        | "participant_events.join"
        | "participant_events.update"
        | "participant_events.leave"
      >;
    }>;
  };
  output_media:
    | { screenshare: RecallWebpageOutput }
    | { camera: RecallWebpageOutput };
}

const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_BASE_DELAY_MS = 1_000;
const DEFAULT_MAX_DELAY_MS = 60_000;
const DEFAULT_JITTER_MS = 500;
const MAX_CACHED_CREATE_BOT_REQUESTS = 1_000;
const MAX_CACHED_PARTICIPANTS = 5_000;
const MAX_RESPONSE_BODY_BYTES = 1_048_576;
const RETRYABLE_STATUS_CODES = new Set([409, 429, 502, 503, 504, 507]);
const AMBIGUOUS_CREATE_STATUS_CODES = new Set([502, 503, 504]);

const normalizeCorrelationId = (value: string): string => {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(normalized)) {
    throw new Error("Recall bot correlation ID is invalid");
  }
  return normalized;
};

const normalizeBotId = (value: unknown): string | undefined => {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized && normalized.length <= 200 && !/\s/.test(normalized)
    ? normalized
    : undefined;
};

/**
 * Recall currently accepts the same webpage output shape under either
 * `screenshare` or `camera`. Keep that provider-specific assumption here so
 * switching the demo fallback does not leak into session or UI code.
 */
export const buildRecallCreateBotRequest = (
  config: RecallBotConfig,
  options: Pick<RecallClientOptions, "outputMode" | "languageCode">
): RecallCreateBotRequest => {
  const outputMode = options.outputMode ?? "screenshare";
  const publicBaseUrl = validateRecallPublicBaseUrl(config.publicBaseUrl);
  const webhookUrl = recallPublicUrl(
    publicBaseUrl,
    `/webhooks/recall/${encodeURIComponent(config.sessionToken)}`
  );
  const whiteboardUrl = recallPublicUrl(
    publicBaseUrl,
    `/whiteboard/${encodeURIComponent(config.whiteboardId)}`
  );
  const webpage: RecallWebpageOutput = {
    kind: "webpage",
    config: { url: whiteboardUrl }
  };

  return {
    meeting_url: validateRecallMeetingUrl(config.meetingUrl),
    bot_name: config.botName.trim() || "Live Architect",
    metadata: {
      scout_correlation_id: normalizeCorrelationId(config.correlationId)
    },
    recording_config: {
      transcript: {
        provider: {
          recallai_streaming: {
            mode: "prioritize_low_latency",
            language_code: options.languageCode ?? "en"
          }
        },
        diarization: {
          use_separate_streams_when_available: true
        }
      },
      realtime_endpoints: [
        {
          type: "webhook",
          url: webhookUrl,
          events: [
            "transcript.partial_data",
            "transcript.data",
            "participant_events.join",
            "participant_events.update",
            "participant_events.leave"
          ]
        }
      ]
    },
    output_media:
      outputMode === "camera"
        ? { camera: webpage }
        : { screenshare: webpage }
  };
};

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const parseRetryAfterMs = (
  value: string | null,
  now = Date.now()
): number | undefined => {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
};

const responseDetail = async (
  response: Response
): Promise<string | undefined> => {
  try {
    const text = (await response.text()).trim();
    return text ? text.slice(0, 1_000) : undefined;
  } catch {
    return undefined;
  }
};

const discardResponse = async (response: Response): Promise<void> => {
  try {
    await response.body?.cancel();
  } catch {
    // The API action already succeeded; connection cleanup must not turn it
    // into an application failure or cause a duplicate retry.
  }
};

class RecallResponseBodyLimitError extends Error {}

class RecallRequestAmbiguousError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RecallRequestAmbiguousError";
  }
}

export class RecallBotCreationAmbiguousError extends Error {
  constructor(
    readonly correlationId: string,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "RecallBotCreationAmbiguousError";
  }
}

const bufferResponse = async (response: Response): Promise<Response> => {
  if (!response.body) {
    return new Response(null, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    });
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    bytes += chunk.value.byteLength;
    if (bytes > MAX_RESPONSE_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new RecallResponseBodyLimitError();
    }
    chunks.push(chunk.value);
  }
  const body = bytes > 0 ? Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))) : null;
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  });
};

export class RecallClient implements RecallAdapter {
  private readonly apiBaseUrl: string;
  private readonly apiKey: string;
  private readonly outputMode: RecallOutputMode;
  private readonly languageCode: string;
  private readonly fetchImplementation: typeof globalThis.fetch;
  private readonly webhook: Webhook;
  private readonly maxAttempts: number;
  private readonly requestTimeoutMs: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly jitterMs: number;
  private readonly sleepImplementation: (milliseconds: number) => Promise<void>;
  private readonly random: () => number;
  private readonly createBotRequests = new Map<
    string,
    Promise<RecallBotResult>
  >();
  private readonly botNames = new Map<string, string>();
  private readonly botParticipantIds = new Map<string, string>();
  private readonly participantNames = new Map<string, string>();

  constructor(options: RecallClientOptions) {
    if (!options.apiKey.trim()) throw new Error("Recall API key is required");

    const verificationMode = options.webhookVerificationMode ?? "workspace";
    const workspaceSecret =
      options.workspaceVerificationSecret ?? options.webhookSecret;
    const verificationSecret =
      verificationMode === "legacy-svix-dashboard"
        ? options.legacySvixWebhookSecret
        : workspaceSecret;
    if (!verificationSecret) {
      throw new Error(
        verificationMode === "legacy-svix-dashboard"
          ? "A legacy Svix dashboard webhook secret is required in legacy mode"
          : "Recall workspace verification secret is required"
      );
    }

    this.apiBaseUrl = validateRecallApiBaseUrl(options.apiBaseUrl);
    this.apiKey = options.apiKey.trim();
    this.outputMode = options.outputMode ?? "screenshare";
    this.languageCode = options.languageCode ?? "en";
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
    this.webhook = new Webhook(
      validateRecallVerificationSecret(
        verificationSecret,
        verificationMode === "legacy-svix-dashboard"
          ? "Legacy Svix dashboard webhook secret"
          : "Recall workspace verification secret"
      )
    );

    this.maxAttempts = options.retry?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.requestTimeoutMs =
      options.retry?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.baseDelayMs = options.retry?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    this.maxDelayMs = options.retry?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
    this.jitterMs = options.retry?.jitterMs ?? DEFAULT_JITTER_MS;
    this.sleepImplementation = options.retry?.sleep ?? sleep;
    this.random = options.retry?.random ?? Math.random;

    if (!Number.isInteger(this.maxAttempts) || this.maxAttempts < 1) {
      throw new Error("Recall retry maxAttempts must be at least 1");
    }
    for (const [name, value] of [
      ["requestTimeoutMs", this.requestTimeoutMs],
      ["baseDelayMs", this.baseDelayMs],
      ["maxDelayMs", this.maxDelayMs],
      ["jitterMs", this.jitterMs]
    ] as const) {
      if (!Number.isFinite(value) || value < 0) {
        throw new Error(`Recall retry ${name} must be non-negative`);
      }
    }
  }

  createBot(config: RecallBotConfig): Promise<RecallBotResult> {
    const existing = this.createBotRequests.get(config.sessionId);
    if (existing) return existing;

    const request = this.createBotOnce(config);
    this.createBotRequests.set(config.sessionId, request);
    void request.then(
      ({ botId }) => {
        this.botNames.set(botId, config.botName.trim() || "Live Architect");
        this.trimCache(this.botNames, MAX_CACHED_CREATE_BOT_REQUESTS);
        this.trimCache(
          this.createBotRequests,
          MAX_CACHED_CREATE_BOT_REQUESTS
        );
      },
      () => {
        if (this.createBotRequests.get(config.sessionId) === request) {
          this.createBotRequests.delete(config.sessionId);
        }
      }
    );
    return request;
  }

  async pauseRecording(botId: string): Promise<void> {
    await this.setRecordingPaused(botId, true);
  }

  async resumeRecording(botId: string): Promise<void> {
    await this.setRecordingPaused(botId, false);
  }

  async leaveBot(botId: string): Promise<void> {
    const response = await this.request(
      `${this.apiBaseUrl}/bot/${encodeURIComponent(botId)}/leave_call/`,
      {
        method: "POST",
        headers: this.headers(false)
      },
      "leave bot"
    );
    await discardResponse(response);
  }

  async findBotsByCorrelationId(correlationId: string): Promise<string[]> {
    const value = normalizeCorrelationId(correlationId);
    const response = await this.request(
      `${this.apiBaseUrl}/bot/?metadata__scout_correlation_id=${encodeURIComponent(value)}&page_size=100`,
      { method: "GET", headers: this.headers(false) },
      "reconcile bot creation",
      1
    );
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      throw new Error("Recall bot reconciliation response was not valid JSON", {
        cause: error
      });
    }
    const record =
      body && typeof body === "object" && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : undefined;
    const results = Array.isArray(body)
      ? body
      : Array.isArray(record?.results)
        ? record.results
        : undefined;
    if (!results) {
      throw new Error(
        "Recall bot reconciliation response did not include results"
      );
    }
    if (record?.next !== undefined && record.next !== null) {
      throw new Error(
        "Recall bot reconciliation response was paginated; refusing an incomplete match"
      );
    }
    return [
      ...new Set(
        results.flatMap((candidate) => {
          if (
            !candidate ||
            typeof candidate !== "object" ||
            Array.isArray(candidate)
          ) {
            return [];
          }
          const bot = candidate as Record<string, unknown>;
          const metadata =
            bot.metadata &&
            typeof bot.metadata === "object" &&
            !Array.isArray(bot.metadata)
              ? (bot.metadata as Record<string, unknown>)
              : undefined;
          const botId = normalizeBotId(bot.id);
          return botId && metadata?.scout_correlation_id === value
            ? [botId]
            : [];
        })
      )
    ];
  }

  async checkReadiness(): Promise<DependencyReadiness> {
    try {
      const response = await this.request(
        `${this.apiBaseUrl}/bot/?page_size=1`,
        { method: "GET", headers: this.headers(false) },
        "readiness check",
        1
      );
      await discardResponse(response);
      return { ready: true };
    } catch (error) {
      return {
        ready: false,
        detail: error instanceof Error ? error.message : String(error)
      };
    }
  }

  verifyWebhook(rawBody: string, headers: Record<string, string>): void {
    this.webhook.verify(rawBody, headers);
  }

  normalizeEvent(payload: unknown): NormalizedMeetingEvent[] {
    const sourceBotId = recallSourceBotId(payload);
    const expectedBotName = sourceBotId
      ? this.botNames.get(sourceBotId)
      : undefined;
    return normalizeRecallPayload(payload)
      .map((event): NormalizedMeetingEvent => {
        if (
          event.type === "participant.joined" ||
          event.type === "participant.changed"
        ) {
          const participantKey = sourceBotId
            ? `${sourceBotId}:${event.participant.id}`
            : undefined;
          const knownName = participantKey
            ? this.participantNames.get(participantKey)
            : undefined;
          const participantName =
            event.participant.name === "Unknown participant" && knownName
              ? knownName
              : event.participant.name;
          if (participantKey && participantName !== "Unknown participant") {
            this.participantNames.set(participantKey, participantName);
            this.trimCache(this.participantNames, MAX_CACHED_PARTICIPANTS);
          }
          event = {
            ...event,
            participant: { ...event.participant, name: participantName }
          };
        }
        if (
          sourceBotId !== undefined &&
          expectedBotName !== undefined &&
          (event.type === "participant.joined" ||
            event.type === "participant.changed")
        ) {
          let botParticipantId = this.botParticipantIds.get(sourceBotId);
          if (
            botParticipantId === undefined &&
            event.participant.name === expectedBotName
          ) {
            botParticipantId = event.participant.id;
            this.botParticipantIds.set(sourceBotId, botParticipantId);
            this.trimCache(
              this.botParticipantIds,
              MAX_CACHED_CREATE_BOT_REQUESTS
            );
          }
          return {
            ...event,
            participant: {
              ...event.participant,
              // Recall does not expose a bot marker on participant events.
              // Lock the first matching participant identity inside this
              // source bot's envelope so later display-name collisions cannot
              // reclassify another participant.
              isBot: botParticipantId === event.participant.id
            }
          };
        }
        return event;
      });
  }

  private async createBotOnce(config: RecallBotConfig): Promise<RecallBotResult> {
    const correlationId = normalizeCorrelationId(config.correlationId);
    let ambiguousError: Error | undefined;
    try {
      const response = await this.request(
        `${this.apiBaseUrl}/bot/`,
        {
          method: "POST",
          headers: this.headers(true),
          body: JSON.stringify(
            buildRecallCreateBotRequest(config, {
              outputMode: this.outputMode,
              languageCode: this.languageCode
            })
          )
        },
        "create bot",
        this.maxAttempts,
        AMBIGUOUS_CREATE_STATUS_CODES
      );

      let body: unknown;
      try {
        body = await response.json();
      } catch (error) {
        throw new RecallRequestAmbiguousError(
          "Recall create bot response was not valid JSON",
          { cause: error }
        );
      }
      const botId =
        body && typeof body === "object" && !Array.isArray(body)
          ? normalizeBotId((body as Partial<RecallCreateBotResponse>).id)
          : undefined;
      if (!botId) {
        throw new RecallRequestAmbiguousError(
          "Recall create bot response did not include a bot ID"
        );
      }
      return { botId };
    } catch (error) {
      if (!(error instanceof RecallRequestAmbiguousError)) throw error;
      ambiguousError = error;
    }

    try {
      const matches = await this.findBotsByCorrelationId(correlationId);
      if (matches.length === 1 && matches[0]) return { botId: matches[0] };
      if (matches.length > 1) {
        ambiguousError = new Error(
          `Recall bot reconciliation found ${matches.length} bots for one correlation ID`,
          { cause: ambiguousError }
        );
      }
    } catch (reconciliationError) {
      ambiguousError = new AggregateError(
        [ambiguousError, reconciliationError],
        "Recall bot creation and reconciliation both failed"
      );
    }

    const cause =
      ambiguousError ?? new Error("Recall bot creation outcome was not known");
    throw new RecallBotCreationAmbiguousError(
      correlationId,
      `Recall bot creation outcome is ambiguous: ${cause.message}`,
      { cause }
    );
  }

  private headers(json: boolean): Record<string, string> {
    return {
      Authorization: this.apiKey,
      accept: "application/json",
      ...(json ? { "content-type": "application/json" } : {})
    };
  }

  private async setRecordingPaused(
    botId: string,
    paused: boolean
  ): Promise<void> {
    const action = paused ? "pause_recording" : "resume_recording";
    const response = await this.request(
      `${this.apiBaseUrl}/bot/${encodeURIComponent(botId)}/${action}/`,
      { method: "POST", headers: this.headers(false) },
      paused ? "pause recording" : "resume recording"
    );
    await discardResponse(response);
  }

  private trimCache<Value>(cache: Map<string, Value>, maximum: number): void {
    while (cache.size > maximum) {
      const oldest = cache.keys().next().value as string | undefined;
      if (!oldest) return;
      cache.delete(oldest);
    }
  }

  private async request(
    url: string,
    init: RequestInit,
    operation: string,
    maxAttempts = this.maxAttempts,
    ambiguousStatusCodes?: ReadonlySet<number>
  ): Promise<Response> {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const controller = new AbortController();
      let timedOut = false;
      let rejectTimeout!: (error: Error) => void;
      const timeoutFailure = new Promise<never>((_resolve, reject) => {
        rejectTimeout = reject;
      });
      const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
        rejectTimeout(
          new Error(
            `Recall ${operation} timed out after ${this.requestTimeoutMs}ms`
          )
        );
      }, this.requestTimeoutMs);
      timeout.unref();
      let response: Response;
      try {
        const rawResponse = await Promise.race([
          this.fetchImplementation(url, {
            ...init,
            signal: controller.signal
          }),
          timeoutFailure
        ]);
        response = await Promise.race([
          bufferResponse(rawResponse),
          timeoutFailure
        ]);
      } catch (error) {
        if (timedOut) {
          throw new RecallRequestAmbiguousError(
            `Recall ${operation} timed out after ${this.requestTimeoutMs}ms`,
            { cause: error }
          );
        }
        if (error instanceof RecallResponseBodyLimitError) {
          throw new RecallRequestAmbiguousError(
            `Recall ${operation} response exceeded ${MAX_RESPONSE_BODY_BYTES} bytes`,
            { cause: error }
          );
        }
        // A network failure is ambiguous for POST requests and retrying could
        // create a duplicate bot. Retry only explicit provider responses.
        throw new RecallRequestAmbiguousError(
          `Recall ${operation} request failed`,
          { cause: error }
        );
      } finally {
        clearTimeout(timeout);
      }

      if (response.ok) return response;
      if (ambiguousStatusCodes?.has(response.status)) {
        const detail = await responseDetail(response);
        throw new RecallRequestAmbiguousError(
          `Recall ${operation} returned ambiguous HTTP ${response.status}${
            detail ? `: ${detail}` : ""
          }`
        );
      }
      if (
        !RETRYABLE_STATUS_CODES.has(response.status) ||
        attempt === maxAttempts
      ) {
        const detail = await responseDetail(response);
        throw new Error(
          `Recall ${operation} failed with HTTP ${response.status}${
            detail ? `: ${detail}` : ""
          }`
        );
      }

      const retryAfterMs = parseRetryAfterMs(
        response.headers.get("retry-after")
      );
      await discardResponse(response);
      if (retryAfterMs !== undefined && retryAfterMs > this.maxDelayMs) {
        throw new Error(
          `Recall ${operation} requested a ${retryAfterMs}ms retry delay, which exceeds the configured maximum`
        );
      }
      const exponentialDelay = this.baseDelayMs * 2 ** (attempt - 1);
      const providerMinimum =
        retryAfterMs ??
        (response.status === 507 ? 30_000 : exponentialDelay);
      const boundedDelay = Math.min(
        this.maxDelayMs,
        Math.max(providerMinimum, exponentialDelay)
      );
      const jitter = Math.floor(this.random() * this.jitterMs);
      await this.sleepImplementation(boundedDelay + jitter);
    }

    throw new Error(`Recall ${operation} exhausted retry attempts`);
  }
}
