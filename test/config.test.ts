import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/server/config.js";

describe("loadConfig", () => {
  it("keeps Recall disabled when no API key is available", () => {
    const config = loadConfig({});

    expect(config.recall).toBeUndefined();
    expect(config.codex.reasoningEffort).toBe("low");
    expect(config.codex.structuredDiagnosis).toBe(false);
    expect(config.analysisDelayMs).toBe(8_000);
    expect(config.analysisRerunDelayMs).toBe(2_000);
    expect(config.analysisMaxBatchUtterances).toBe(40);
    expect(config.analysisMaxBatchBytes).toBe(48_000);
    expect(config.maxAutomaticAnalysisTurnsPerSession).toBe(20);
    expect(config.maxActiveSessions).toBe(3);
    expect(config.maxSseConnections).toBe(128);
    expect(config.maxSseConnectionsPerSession).toBe(32);
    expect(config.sessionRetentionMs).toBe(4 * 60 * 60 * 1_000);
    expect(config.shutdownGraceMs).toBe(60_000);
    expect(config.allowDevIngest).toBe(false);
  });

  it("keeps structured diagnosis opt-in", () => {
    expect(
      loadConfig({ SCOUT_STRUCTURED_DIAGNOSIS: "1" }).codex
        .structuredDiagnosis
    ).toBe(true);
    expect(
      loadConfig({ SCOUT_STRUCTURED_DIAGNOSIS: "true" }).codex
        .structuredDiagnosis
    ).toBe(false);
  });

  it("normalizes public and Recall base URLs", () => {
    const config = loadConfig({
      PUBLIC_API_BASE_URL: "https://scout.example.dev/",
      RECALL_API_KEY: "test-key",
      RECALL_REGION: "eu-central-1",
      RECALL_WORKSPACE_VERIFICATION_SECRET: "whsec_test"
    });

    expect(config.publicBaseUrl).toBe("https://scout.example.dev");
    expect(config.recall?.apiBaseUrl).toBe(
      "https://eu-central-1.recall.ai/api/v1"
    );
    expect(config.recall?.statusWebhookSecret).toBe("whsec_test");
    expect(config.recall?.statusWebhookVerificationMode).toBe("workspace");
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

  it("enforces a nonzero safe floor for analysis delays and limits", () => {
    expect(() => loadConfig({ ANALYSIS_DELAY_MS: "0" })).toThrow(/at least 100/);
    expect(() => loadConfig({ ANALYSIS_RERUN_DELAY_MS: "99" })).toThrow(
      /at least 100/
    );
    expect(() => loadConfig({ MAX_ACTIVE_SESSIONS: "0" })).toThrow(/at least 1/);
  });

  it("requires the workspace verification secret with a Recall key", () => {
    expect(() => loadConfig({ RECALL_API_KEY: "test-key" })).toThrow(
      /WORKSPACE_VERIFICATION_SECRET/
    );
  });

  it("rejects non-HTTPS public callback URLs", () => {
    expect(() =>
      loadConfig({ PUBLIC_API_BASE_URL: "http://127.0.0.1:3000" })
    ).toThrow(/must use HTTPS/);
    expect(() =>
      loadConfig({ PUBLIC_API_BASE_URL: "https://localhost:3000" })
    ).toThrow(/publicly reachable hostname/);
  });

  it("uses explicit legacy Svix verification only when its secret is set", () => {
    const config = loadConfig({
      RECALL_API_KEY: "test-key",
      RECALL_WORKSPACE_VERIFICATION_SECRET: "workspace-secret",
      RECALL_SVIX_WEBHOOK_SECRET: "legacy-secret"
    });

    expect(config.recall?.statusWebhookSecret).toBe("legacy-secret");
    expect(config.recall?.statusWebhookVerificationMode).toBe("svix");
  });
});
