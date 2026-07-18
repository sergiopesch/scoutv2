import {
  validateRecallApiBaseUrl,
  validateRecallPublicBaseUrl
} from "./recall/recall-validation.js";

export interface AppConfig {
  port: number;
  host: string;
  publicBaseUrl?: string;
  analysisDelayMs: number;
  analysisRerunDelayMs: number;
  analysisMaxBatchUtterances: number;
  analysisMaxBatchBytes: number;
  maxAutomaticAnalysisTurnsPerSession: number;
  maxActiveSessions: number;
  maxSseConnections: number;
  maxSseConnectionsPerSession: number;
  sessionRetentionMs: number;
  shutdownGraceMs: number;
  allowDevIngest: boolean;
  codex: {
    binary: string;
    model: string;
    reasoningEffort: "low" | "medium" | "high";
  };
  recall?: {
    region: RecallRegion;
    apiKey: string;
    apiBaseUrl: string;
    workspaceVerificationSecret: string;
    statusWebhookSecret: string;
    statusWebhookVerificationMode: "workspace" | "svix";
    outputMode: "screenshare" | "camera";
    requestTimeoutMs: number;
    maxRetries: number;
  };
}

export const recallRegions = [
  "us-west-2",
  "us-east-1",
  "eu-central-1",
  "ap-northeast-1"
] as const;

export type RecallRegion = (typeof recallRegions)[number];

const parseInteger = (
  value: string | undefined,
  fallback: number,
  name: string
): number => {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return parsed;
};

const parseMinimumInteger = (
  value: string | undefined,
  fallback: number,
  name: string,
  minimum: number
): number => {
  const parsed = parseInteger(value, fallback, name);
  if (parsed < minimum) {
    throw new Error(`${name} must be an integer of at least ${minimum}.`);
  }
  return parsed;
};

export const loadConfig = (
  environment: NodeJS.ProcessEnv = process.env
): AppConfig => {
  const effort = environment.CODEX_REASONING_EFFORT ?? "low";
  if (!["low", "medium", "high"].includes(effort)) {
    throw new Error("CODEX_REASONING_EFFORT must be low, medium, or high.");
  }

  const publicBaseUrl = (
    environment.PUBLIC_API_BASE_URL ?? environment.PUBLIC_BASE_URL
  )?.trim();
  const recallApiKey = environment.RECALL_API_KEY?.trim();
  const recallRegion = environment.RECALL_REGION?.trim() || "us-west-2";
  if (!recallRegions.includes(recallRegion as RecallRegion)) {
    throw new Error(
      `RECALL_REGION must be one of: ${recallRegions.join(", ")}.`
    );
  }
  const workspaceVerificationSecret = (
    environment.RECALL_WORKSPACE_VERIFICATION_SECRET ??
    environment.RECALL_WEBHOOK_SECRET
  )?.trim();
  const legacySvixSecret = environment.RECALL_SVIX_WEBHOOK_SECRET?.trim();
  const outputMode = environment.RECALL_OUTPUT_MODE?.trim() || "screenshare";
  if (!["screenshare", "camera"].includes(outputMode)) {
    throw new Error("RECALL_OUTPUT_MODE must be screenshare or camera.");
  }

  if (recallApiKey && !workspaceVerificationSecret) {
    throw new Error(
      "RECALL_WORKSPACE_VERIFICATION_SECRET is required when RECALL_API_KEY is set."
    );
  }

  return {
    port: parseInteger(environment.PORT, 3000, "PORT"),
    host: environment.HOST?.trim() || "127.0.0.1",
    publicBaseUrl: publicBaseUrl
      ? validateRecallPublicBaseUrl(publicBaseUrl)
      : undefined,
    analysisDelayMs: parseMinimumInteger(
      environment.ANALYSIS_DELAY_MS,
      8_000,
      "ANALYSIS_DELAY_MS",
      100
    ),
    analysisRerunDelayMs: parseMinimumInteger(
      environment.ANALYSIS_RERUN_DELAY_MS,
      2_000,
      "ANALYSIS_RERUN_DELAY_MS",
      100
    ),
    analysisMaxBatchUtterances: parseMinimumInteger(
      environment.ANALYSIS_MAX_BATCH_UTTERANCES,
      40,
      "ANALYSIS_MAX_BATCH_UTTERANCES",
      1
    ),
    analysisMaxBatchBytes: parseMinimumInteger(
      environment.ANALYSIS_MAX_BATCH_BYTES,
      48_000,
      "ANALYSIS_MAX_BATCH_BYTES",
      1_024
    ),
    maxAutomaticAnalysisTurnsPerSession: parseMinimumInteger(
      environment.MAX_AUTOMATIC_ANALYSIS_TURNS_PER_SESSION,
      20,
      "MAX_AUTOMATIC_ANALYSIS_TURNS_PER_SESSION",
      1
    ),
    maxActiveSessions: parseMinimumInteger(
      environment.MAX_ACTIVE_SESSIONS,
      3,
      "MAX_ACTIVE_SESSIONS",
      1
    ),
    maxSseConnections: parseMinimumInteger(
      environment.MAX_SSE_CONNECTIONS,
      128,
      "MAX_SSE_CONNECTIONS",
      1
    ),
    maxSseConnectionsPerSession: parseMinimumInteger(
      environment.MAX_SSE_CONNECTIONS_PER_SESSION,
      32,
      "MAX_SSE_CONNECTIONS_PER_SESSION",
      1
    ),
    sessionRetentionMs: parseMinimumInteger(
      environment.SESSION_RETENTION_MS,
      4 * 60 * 60 * 1_000,
      "SESSION_RETENTION_MS",
      60_000
    ),
    shutdownGraceMs: parseMinimumInteger(
      environment.SHUTDOWN_GRACE_MS,
      60_000,
      "SHUTDOWN_GRACE_MS",
      100
    ),
    allowDevIngest: environment.SCOUT_ALLOW_DEV_INGEST === "true",
    codex: {
      binary: environment.CODEX_BINARY?.trim() || "codex",
      model: environment.CODEX_MODEL?.trim() || "gpt-5.6-sol",
      reasoningEffort: effort as AppConfig["codex"]["reasoningEffort"]
    },
    recall: recallApiKey
      ? {
          region: recallRegion as RecallRegion,
          apiKey: recallApiKey,
          apiBaseUrl: validateRecallApiBaseUrl(
            environment.RECALL_API_BASE_URL?.trim() ||
              `https://${recallRegion}.recall.ai/api/v1`
          ),
          workspaceVerificationSecret: workspaceVerificationSecret!,
          statusWebhookSecret: legacySvixSecret || workspaceVerificationSecret!,
          statusWebhookVerificationMode: legacySvixSecret ? "svix" : "workspace",
          outputMode: outputMode as "screenshare" | "camera",
          requestTimeoutMs: parseMinimumInteger(
            environment.RECALL_REQUEST_TIMEOUT_MS,
            10_000,
            "RECALL_REQUEST_TIMEOUT_MS",
            100
          ),
          maxRetries: parseInteger(
            environment.RECALL_MAX_RETRIES,
            3,
            "RECALL_MAX_RETRIES"
          )
        }
      : undefined
  };
};
