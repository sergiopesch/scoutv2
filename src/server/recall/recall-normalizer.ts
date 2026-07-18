import { createHash } from "node:crypto";
import type {
  NormalizedBotStatus,
  NormalizedMeetingEvent
} from "../contracts.js";

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const nonEmptyString = (value: unknown, maximum = 1_000): string | undefined => {
  const stringValue = asString(value)?.trim();
  return stringValue && stringValue.length <= maximum ? stringValue : undefined;
};

const nonEmptyIdentifier = (value: unknown): string | undefined =>
  typeof value === "number" && Number.isFinite(value)
    ? String(value)
    : nonEmptyString(value, 200);

const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

export const MAX_MEETING_TIMESTAMP_SECONDS = 7 * 24 * 60 * 60;
const MAX_ABSOLUTE_TIMESTAMP_PAST_SKEW_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_ABSOLUTE_TIMESTAMP_FUTURE_SKEW_MS = 5 * 60 * 1_000;
const MAX_TRANSCRIPT_WORDS = 5_000;
const MAX_WORD_TEXT_LENGTH = 1_000;
const MAX_UTTERANCE_BYTES = 48_000;

const parseAbsoluteTimestamp = (value: unknown): number | undefined => {
  const timestamp = nonEmptyString(value);
  if (!timestamp) return undefined;
  const parsed = Date.parse(timestamp);
  const now = Date.now();
  return Number.isFinite(parsed) &&
    parsed >= now - MAX_ABSOLUTE_TIMESTAMP_PAST_SKEW_MS &&
    parsed <= now + MAX_ABSOLUTE_TIMESTAMP_FUTURE_SKEW_MS
    ? parsed
    : undefined;
};

const participantId = (
  participant: Record<string, unknown>
): string | undefined => {
  const id = participant.id;
  if (typeof id === "string" || typeof id === "number") {
    const normalized = String(id).trim();
    return normalized && normalized.length <= 200 ? normalized : undefined;
  }
  return undefined;
};

const participantPlatformIdentity = (
  participant: Record<string, unknown>
): string | undefined => {
  const extraData = asRecord(participant.extra_data);
  const candidates: Array<[string, string | undefined]> = [
    ["zoom", nonEmptyIdentifier(asRecord(extraData?.zoom)?.conf_user_id)],
    [
      "microsoft_teams",
      nonEmptyIdentifier(asRecord(extraData?.microsoft_teams)?.user_id)
    ],
    ["teams", nonEmptyIdentifier(asRecord(extraData?.teams)?.user_id)],
    ["slack", nonEmptyIdentifier(asRecord(extraData?.slack)?.user_id)],
    ["webex", nonEmptyIdentifier(asRecord(extraData?.webex)?.webex_id)]
  ];
  const match = candidates.find(([, identity]) => identity !== undefined);
  if (match?.[1]) return `${match[0]}:${match[1]}`;

  return undefined;
};

const normalizeWords = (
  wordsValue: unknown
): Array<{
  text: string;
  start: number;
  end?: number;
}> => {
  if (!Array.isArray(wordsValue)) return [];

  return wordsValue.slice(0, MAX_TRANSCRIPT_WORDS).flatMap((value) => {
    const word = asRecord(value);
    const text = nonEmptyString(word?.text, MAX_WORD_TEXT_LENGTH);
    const start = asNumber(asRecord(word?.start_timestamp)?.relative);
    const end = asNumber(asRecord(word?.end_timestamp)?.relative);
    if (
      !word ||
      !text ||
      start === undefined ||
      start < 0 ||
      start > MAX_MEETING_TIMESTAMP_SECONDS
    ) {
      return [];
    }
    const boundedEnd =
      end !== undefined &&
      end >= start &&
      end <= MAX_MEETING_TIMESTAMP_SECONDS
        ? end
        : undefined;
    return [
      { text, start, ...(boundedEnd !== undefined ? { end: boundedEnd } : {}) }
    ];
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
  const isFinal = payload.event === "transcript.data";
  const isPartial = payload.event === "transcript.partial_data";
  if (!isFinal && !isPartial) return [];

  const envelope = asRecord(payload.data);
  const transcriptData = asRecord(envelope?.data);
  const participant = asRecord(transcriptData?.participant);
  const words = normalizeWords(transcriptData?.words);
  const text = joinWords(words);
  if (
    !participant ||
    words.length === 0 ||
    !text ||
    Buffer.byteLength(text, "utf8") > MAX_UTTERANCE_BYTES
  ) {
    return [];
  }

  const speakerId = participantId(participant);
  const speakerName = nonEmptyString(participant.name);
  // The MVP contract requires attributed utterances. Do not fabricate an
  // "unknown" identity that could later be mistaken for customer evidence.
  if (!speakerId || !speakerName) return [];

  const startedAt = words[0]?.start ?? 0;
  const endedAt = Math.max(
    startedAt,
    ...words.map((word) => Math.max(word.start, word.end ?? word.start))
  );
  const transcriptId =
    nonEmptyString(asRecord(envelope?.transcript)?.id) ??
    nonEmptyString(asRecord(envelope?.bot)?.id) ??
    "transcript";
  const contentHash = createHash("sha256")
    .update(text)
    .digest("hex")
    .slice(0, 10);
  const startMillis = Math.round(startedAt * 1_000);
  const endMillis = Math.round(endedAt * 1_000);

  return [
    {
      type: isFinal ? "transcript.final" : "transcript.partial",
      utterance: {
        id: isFinal
          ? `${transcriptId}:${speakerId}:${startMillis}:${endMillis}:${contentHash}`
          : `${transcriptId}:${speakerId}:${startMillis}:partial`,
        sequence: startMillis,
        participantId: speakerId,
        participantName: speakerName,
        text,
        startedAt,
        endedAt,
        finalized: isFinal
      }
    }
  ];
};

const normalizeParticipant = (
  payload: Record<string, unknown>
): NormalizedMeetingEvent[] => {
  const actionByEvent = {
    "participant_events.join": "joined",
    "participant_events.update": "updated",
    "participant_events.leave": "left"
  } as const;
  const eventName = asString(payload.event);
  const action = eventName
    ? actionByEvent[eventName as keyof typeof actionByEvent]
    : undefined;
  if (!action) return [];

  const participantData = asRecord(asRecord(payload.data)?.data);
  const participant = asRecord(participantData?.participant);
  if (!participant) return [];
  const id = participantId(participant);
  if (!id) return [];

  const occurredAt = parseAbsoluteTimestamp(
    asRecord(participantData?.timestamp)?.absolute
  );
  if (occurredAt === undefined) return [];
  const name = nonEmptyString(participant.name, 200) ?? "Unknown participant";
  const platform = nonEmptyString(participant.platform, 50);
  const platformIdentity = participantPlatformIdentity(participant);

  return [
    {
      type: "participant.changed",
      action,
      participant: {
        id,
        name,
        present: action !== "left",
        ...(platform ? { platform } : {}),
        ...(platformIdentity ? { platformIdentity } : {}),
        ...(action === "joined" && occurredAt !== undefined
          ? { joinedAt: occurredAt }
          : {}),
        ...(action === "left" && occurredAt !== undefined
          ? { leftAt: occurredAt }
          : {})
      },
      ...(occurredAt !== undefined ? { occurredAt } : {})
    }
  ];
};

interface MappedStatus {
  status: NormalizedBotStatus;
  defaultDetail?: string;
}

const mapBotStatus = (providerStatus: string): MappedStatus | undefined => {
  switch (providerStatus) {
    case "joining_call":
      return { status: "creating" };
    case "in_waiting_room":
      return { status: "waiting_for_admission" };
    case "in_call_not_recording":
      return {
        status: "creating",
        defaultDetail: "Bot is in the call but is not recording"
      };
    case "recording_permission_allowed":
      return {
        status: "creating",
        defaultDetail:
          "Recording permission granted; waiting for recording to start"
      };
    case "in_call_recording":
      return { status: "listening" };
    case "call_ended":
    case "done":
      return { status: "ended" };
    default:
      // `ready` is internal, while analysis/media statuses are unrelated to
      // Scout's live transcript lifecycle. Future codes are acknowledged but
      // intentionally ignored until their semantics are understood.
      return undefined;
  }
};

const botIdFromEnvelope = (
  envelope: Record<string, unknown> | undefined
): string | undefined =>
  nonEmptyString(envelope?.bot_id) ??
  nonEmptyString(asRecord(envelope?.bot)?.id) ??
  nonEmptyString(asRecord(asRecord(envelope?.recording)?.bot)?.id);

const statusTimestamp = (
  envelope: Record<string, unknown> | undefined,
  status: Record<string, unknown> | undefined
): number | undefined =>
  parseAbsoluteTimestamp(status?.updated_at) ??
  parseAbsoluteTimestamp(status?.created_at) ??
  parseAbsoluteTimestamp(envelope?.created_at);

const statusDetail = (
  status: Record<string, unknown> | undefined
): string | undefined =>
  nonEmptyString(status?.message) ?? nonEmptyString(status?.sub_code);

const integrationError = (input: {
  code: string;
  detail: string;
  botId?: string;
  occurredAt?: number;
  fatal: boolean;
}): NormalizedMeetingEvent => ({
  type: "integration.error",
  source: "recall",
  code: input.code,
  detail: input.detail.slice(0, 2_000),
  ...(input.botId ? { botId: input.botId } : {}),
  ...(input.occurredAt !== undefined ? { occurredAt: input.occurredAt } : {}),
  fatal: input.fatal
});

const normalizeBotLog = (
  payload: Record<string, unknown>
): NormalizedMeetingEvent[] => {
  if (payload.event !== "bot.log" && payload.event !== "bot.output_log") {
    return [];
  }
  const envelope = asRecord(payload.data);
  const log = asRecord(envelope?.log);
  const level = nonEmptyString(log?.level)?.toLowerCase();
  const message = nonEmptyString(log?.message);
  if ((level !== "error" && level !== "fatal") || !message) return [];

  return [
    integrationError({
      code:
        payload.event === "bot.output_log" ? "bot_output_error" : "bot_error",
      detail: message,
      botId: botIdFromEnvelope(envelope),
      occurredAt: parseAbsoluteTimestamp(log?.created_at),
      fatal: level === "fatal" || payload.event === "bot.output_log"
    })
  ];
};

const normalizeArtifactFailure = (
  payload: Record<string, unknown>
): NormalizedMeetingEvent[] => {
  if (
    payload.event !== "transcript.failed" &&
    payload.event !== "recording.failed"
  ) {
    return [];
  }
  const envelope = asRecord(payload.data);
  const failure = asRecord(envelope?.data) ?? asRecord(envelope?.status);
  const code =
    nonEmptyString(failure?.sub_code) ??
    nonEmptyString(failure?.code) ??
    String(payload.event).replace(".", "_");
  const detail =
    nonEmptyString(failure?.message) ??
    nonEmptyString(failure?.detail) ??
    `Recall reported ${String(payload.event)}`;

  return [
    integrationError({
      code,
      detail,
      botId: botIdFromEnvelope(envelope),
      occurredAt: statusTimestamp(envelope, failure),
      fatal: true
    })
  ];
};

const normalizeBotStatus = (
  payload: Record<string, unknown>
): NormalizedMeetingEvent[] => {
  const eventName = nonEmptyString(payload.event);
  if (!eventName?.startsWith("bot.")) return [];
  if (eventName === "bot.log" || eventName === "bot.output_log") {
    return normalizeBotLog(payload);
  }

  const envelope = asRecord(payload.data);
  const legacyStatus = asRecord(envelope?.status);
  const currentStatus = asRecord(envelope?.data);
  const status = legacyStatus ?? currentStatus;
  const providerStatus =
    nonEmptyString(status?.code) ??
    (eventName === "bot.status_change" ? undefined : eventName.slice(4));
  if (!providerStatus) return [];

  const botId = botIdFromEnvelope(envelope);
  const occurredAt = statusTimestamp(envelope, status);
  const detail = statusDetail(status);

  if (providerStatus === "fatal") {
    return [
      integrationError({
        code: nonEmptyString(status?.sub_code) ?? "bot_fatal",
        detail: detail ?? "Recall bot encountered a fatal error",
        botId,
        occurredAt,
        fatal: true
      })
    ];
  }
  if (providerStatus === "recording_permission_denied") {
    return [
      integrationError({
        code:
          nonEmptyString(status?.sub_code) ?? "recording_permission_denied",
        detail: detail ?? "The meeting host denied recording permission",
        botId,
        occurredAt,
        fatal: false
      })
    ];
  }

  const mapped = mapBotStatus(providerStatus);
  if (!mapped) return [];
  if (occurredAt === undefined && mapped.status !== "ended") return [];
  return [
    {
      type: "bot.status",
      ...(botId ? { botId } : {}),
      status: mapped.status,
      ...(detail ?? mapped.defaultDetail
        ? { detail: detail ?? mapped.defaultDetail }
        : {}),
      ...(occurredAt !== undefined ? { occurredAt } : {})
    }
  ];
};

export const normalizeRecallPayload = (
  payload: unknown
): NormalizedMeetingEvent[] => {
  const record = asRecord(payload);
  if (!record) return [];
  return [
    ...normalizeTranscript(record),
    ...normalizeParticipant(record),
    ...normalizeBotStatus(record),
    ...normalizeArtifactFailure(record)
  ];
};

export const recallSourceBotId = (payload: unknown): string | undefined =>
  botIdFromEnvelope(asRecord(asRecord(payload)?.data));
