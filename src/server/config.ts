export interface AppConfig {
  port: number;
  host: string;
  publicBaseUrl?: string;
  analysisDelayMs: number;
  analysisRerunDelayMs: number;
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
    outputMode: "screenshare" | "camera";
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

const stripTrailingSlash = (value: string): string => value.replace(/\/+$/, "");

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
      ? stripTrailingSlash(publicBaseUrl)
      : undefined,
    analysisDelayMs: parseInteger(
      environment.ANALYSIS_DELAY_MS,
      1_500,
      "ANALYSIS_DELAY_MS"
    ),
    analysisRerunDelayMs: parseInteger(
      environment.ANALYSIS_RERUN_DELAY_MS,
      500,
      "ANALYSIS_RERUN_DELAY_MS"
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
          apiBaseUrl: stripTrailingSlash(
            environment.RECALL_API_BASE_URL?.trim() ||
              `https://${recallRegion}.recall.ai/api/v1`
          ),
          workspaceVerificationSecret: workspaceVerificationSecret!,
          statusWebhookSecret:
            environment.RECALL_SVIX_WEBHOOK_SECRET?.trim() ||
            workspaceVerificationSecret!,
          outputMode: outputMode as "screenshare" | "camera"
        }
      : undefined
  };
};
