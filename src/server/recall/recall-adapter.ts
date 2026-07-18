import { createHash } from "node:crypto";
import { Webhook } from "svix";
import type {
  NormalizedMeetingEvent,
  RecallAdapter,
  RecallBotConfig,
  RecallBotResult
} from "../contracts.js";

export type RecallOutputMode = "screenshare" | "camera";

export interface RecallClientOptions {
  apiBaseUrl: string;
  apiKey: string;
  webhookSecret: string;
  outputMode?: RecallOutputMode;
  languageCode?: string;
  fetch?: typeof globalThis.fetch;
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
      events: Array<"transcript.data" | "participant_events.join">;
    }>;
  };
  output_media:
    | { screenshare: RecallWebpageOutput }
    | { camera: RecallWebpageOutput };
}

const trimTrailingSlashes = (value: string): string => value.replace(/\/+$/, "");

const publicUrl = (baseUrl: string, pathname: string): string =>
  `${trimTrailingSlashes(baseUrl)}${pathname}`;

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
  const webhookUrl = publicUrl(
    config.publicBaseUrl,
    `/webhooks/recall/${encodeURIComponent(config.sessionToken)}`
  );
  const whiteboardUrl = publicUrl(
    config.publicBaseUrl,
    `/whiteboard/${encodeURIComponent(config.sessionId)}`
  );
  const webpage: RecallWebpageOutput = {
    kind: "webpage",
    config: { url: whiteboardUrl }
  };

  return {
    meeting_url: config.meetingUrl,
    bot_name: config.botName.trim() || "Live Architect",
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
          events: ["transcript.data", "participant_events.join"]
        }
      ]
    },
    output_media:
      outputMode === "camera"
        ? { camera: webpage }
        : { screenshare: webpage }
  };
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const participantId = (participant: Record<string, unknown>): string => {
  const id = participant.id;
  if (typeof id === "string" || typeof id === "number") {
    return String(id);
  }
  return asString(participant.name) ?? "unknown";
};

const normalizeWords = (
  wordsValue: unknown
): Array<{
  text: string;
  start: number;
  end?: number;
}> => {
  if (!Array.isArray(wordsValue)) {
    return [];
  }

  return wordsValue.flatMap((value) => {
    const word = asRecord(value);
    const text = asString(word?.text);
    const start = asNumber(asRecord(word?.start_timestamp)?.relative);
    const end = asNumber(asRecord(word?.end_timestamp)?.relative);
    if (!word || !text || start === undefined) {
      return [];
    }
    return [{ text, start, end }];
  });
};

const joinWords = (words: Array<{ text: string }>): string =>
  words
    .map((word) => word.text.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+([,.;!?])/g, "$1")
    .trim();

const normalizeTranscript = (
  payload: Record<string, unknown>
): NormalizedMeetingEvent[] => {
  if (payload.event !== "transcript.data") {
    return [];
  }

  const envelope = asRecord(payload.data);
  const transcriptData = asRecord(envelope?.data);
  const participant = asRecord(transcriptData?.participant);
  const words = normalizeWords(transcriptData?.words);
  const text = joinWords(words);
  if (!participant || words.length === 0 || !text) {
    return [];
  }

  const speakerId = participantId(participant);
  const speakerName = asString(participant.name) ?? "Unknown speaker";
  const startedAt = words[0]?.start ?? 0;
  const endedAt =
    [...words].reverse().find((word) => word.end !== undefined)?.end ??
    words.at(-1)?.start ??
    startedAt;
  const transcriptId =
    asString(asRecord(envelope?.transcript)?.id) ??
    asString(asRecord(envelope?.bot)?.id) ??
    "transcript";
  const contentHash = createHash("sha256").update(text).digest("hex").slice(0, 10);
  const startMillis = Math.round(startedAt * 1_000);
  const endMillis = Math.round(endedAt * 1_000);

  return [
    {
      type: "transcript.final",
      utterance: {
        id: `${transcriptId}:${speakerId}:${startMillis}:${endMillis}:${contentHash}`,
        sequence: startMillis,
        participantId: speakerId,
        participantName: speakerName,
        text,
        startedAt,
        endedAt,
        finalized: true
      }
    }
  ];
};

const normalizeParticipant = (
  payload: Record<string, unknown>
): NormalizedMeetingEvent[] => {
  if (payload.event !== "participant_events.join") {
    return [];
  }

  const participantData = asRecord(asRecord(payload.data)?.data);
  const participant = asRecord(participantData?.participant);
  if (!participant) {
    return [];
  }

  const absolute = asString(asRecord(participantData?.timestamp)?.absolute);
  const joinedAt = absolute === undefined ? undefined : Date.parse(absolute);

  return [
    {
      type: "participant.joined",
      participant: {
        id: participantId(participant),
        name: asString(participant.name) ?? "Unknown participant",
        ...(asString(participant.platform)
          ? { platform: asString(participant.platform) }
          : {}),
        ...(joinedAt !== undefined && Number.isFinite(joinedAt) ? { joinedAt } : {})
      }
    }
  ];
};

const mapBotStatus = (providerStatus: string): string => {
  switch (providerStatus) {
    case "ready":
    case "joining_call":
      return "creating";
    case "in_waiting_room":
      return "waiting_for_admission";
    case "in_call_not_recording":
    case "in_call_recording":
      return "listening";
    case "call_ended":
    case "done":
      return "ended";
    case "fatal":
      return "error";
    default:
      return providerStatus;
  }
};

const normalizeBotStatus = (
  payload: Record<string, unknown>
): NormalizedMeetingEvent[] => {
  const eventName = asString(payload.event);
  if (!eventName?.startsWith("bot.")) {
    return [];
  }

  const envelope = asRecord(payload.data);
  const legacyStatus = asRecord(envelope?.status);
  const currentStatus = asRecord(envelope?.data);
  const providerStatus =
    asString(legacyStatus?.code) ??
    asString(currentStatus?.code) ??
    (eventName === "bot.status_change" ? undefined : eventName.slice(4));
  if (!providerStatus) {
    return [];
  }

  const message =
    asString(legacyStatus?.message) ?? asString(currentStatus?.message);
  const subCode =
    asString(legacyStatus?.sub_code) ?? asString(currentStatus?.sub_code);
  const detail = message ?? subCode;

  return [
    {
      type: "bot.status",
      status: mapBotStatus(providerStatus),
      ...(detail ? { detail } : {})
    }
  ];
};

export class RecallClient implements RecallAdapter {
  private readonly apiBaseUrl: string;
  private readonly apiKey: string;
  private readonly outputMode: RecallOutputMode;
  private readonly languageCode: string;
  private readonly fetchImplementation: typeof globalThis.fetch;
  private readonly webhook: Webhook;

  constructor(options: RecallClientOptions) {
    if (!options.apiBaseUrl.trim()) {
      throw new Error("Recall API base URL is required");
    }
    if (!options.apiKey.trim()) {
      throw new Error("Recall API key is required");
    }
    if (!options.webhookSecret.trim()) {
      throw new Error("Recall webhook verification secret is required");
    }

    this.apiBaseUrl = trimTrailingSlashes(options.apiBaseUrl);
    this.apiKey = options.apiKey;
    this.outputMode = options.outputMode ?? "screenshare";
    this.languageCode = options.languageCode ?? "en";
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
    this.webhook = new Webhook(options.webhookSecret);
  }

  async createBot(config: RecallBotConfig): Promise<RecallBotResult> {
    const response = await this.fetchImplementation(`${this.apiBaseUrl}/bot/`, {
      method: "POST",
      headers: {
        Authorization: this.apiKey,
        accept: "application/json",
        "content-type": "application/json"
      },
      body: JSON.stringify(
        buildRecallCreateBotRequest(config, {
          outputMode: this.outputMode,
          languageCode: this.languageCode
        })
      )
    });

    if (!response.ok) {
      throw new Error(`Recall create bot failed with HTTP ${response.status}`);
    }

    const body = (await response.json()) as Partial<RecallCreateBotResponse>;
    if (typeof body.id !== "string" || !body.id) {
      throw new Error("Recall create bot response did not include a bot ID");
    }
    return { botId: body.id };
  }

  verifyWebhook(rawBody: string, headers: Record<string, string>): void {
    this.webhook.verify(rawBody, headers);
  }

  normalizeEvent(payload: unknown): NormalizedMeetingEvent[] {
    const record = asRecord(payload);
    if (!record) {
      return [];
    }

    if (record.event === "transcript.partial_data") {
      return [];
    }

    return [
      ...normalizeTranscript(record),
      ...normalizeParticipant(record),
      ...normalizeBotStatus(record)
    ];
  }
}
