import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/server/config.js";

describe("loadConfig", () => {
  it("keeps Recall disabled when no API key is available", () => {
    const config = loadConfig({});

    expect(config.recall).toBeUndefined();
    expect(config.codex.reasoningEffort).toBe("low");
    expect(config.analysisDelayMs).toBe(500);
    expect(config.analysisRerunDelayMs).toBe(250);
    expect(config.allowDevIngest).toBe(false);
  });

  it("normalizes public and Recall base URLs", () => {
    const config = loadConfig({
      PUBLIC_API_BASE_URL: "https://scout.example/",
      RECALL_API_KEY: "test-key",
      RECALL_REGION: "eu-central-1",
      RECALL_WORKSPACE_VERIFICATION_SECRET: "whsec_test"
    });

    expect(config.publicBaseUrl).toBe("https://scout.example");
    expect(config.recall?.apiBaseUrl).toBe(
      "https://eu-central-1.recall.ai/api/v1"
    );
    expect(config.recall?.statusWebhookSecret).toBe("whsec_test");
  });

  it("rejects unsupported reasoning effort", () => {
    expect(() =>
      loadConfig({ CODEX_REASONING_EFFORT: "ultra" })
    ).toThrow(/low, medium, or high/);
  });

  it("accepts explicit leading-batch and rerun delays", () => {
    const config = loadConfig({
      ANALYSIS_DELAY_MS: "900",
      ANALYSIS_RERUN_DELAY_MS: "250"
    });

    expect(config.analysisDelayMs).toBe(900);
    expect(config.analysisRerunDelayMs).toBe(250);
  });

  it("requires the workspace verification secret with a Recall key", () => {
    expect(() => loadConfig({ RECALL_API_KEY: "test-key" })).toThrow(
      /WORKSPACE_VERIFICATION_SECRET/
    );
  });
});
