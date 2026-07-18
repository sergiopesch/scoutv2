export interface AppConfig {
  port: number;
  host: string;
  publicBaseUrl?: string;
  analysisDelayMs: number;
  codex: {
    binary: string;
    model: string;
    reasoningEffort: "low" | "medium" | "high";
  };
  recall?: {
    apiKey: string;
    apiBaseUrl: string;
    webhookSecret?: string;
  };
}

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

  const publicBaseUrl = environment.PUBLIC_BASE_URL?.trim();
  const recallApiKey = environment.RECALL_API_KEY?.trim();

  return {
    port: parseInteger(environment.PORT, 3000, "PORT"),
    host: environment.HOST?.trim() || "127.0.0.1",
    publicBaseUrl: publicBaseUrl
      ? stripTrailingSlash(publicBaseUrl)
      : undefined,
    analysisDelayMs: parseInteger(
      environment.ANALYSIS_DELAY_MS,
      12_000,
      "ANALYSIS_DELAY_MS"
    ),
    codex: {
      binary: environment.CODEX_BINARY?.trim() || "codex",
      model: environment.CODEX_MODEL?.trim() || "gpt-5.6",
      reasoningEffort: effort as AppConfig["codex"]["reasoningEffort"]
    },
    recall: recallApiKey
      ? {
          apiKey: recallApiKey,
          apiBaseUrl: stripTrailingSlash(
            environment.RECALL_API_BASE_URL?.trim() ||
              "https://us-west-2.recall.ai"
          ),
          webhookSecret: environment.RECALL_WEBHOOK_SECRET?.trim() || undefined
        }
      : undefined
  };
};
