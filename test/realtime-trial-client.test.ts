import { describe, expect, it, vi } from "vitest";
import {
  buildTrialSessionConfig,
  OpenAIRealtimeTrialClient
} from "../src/server/realtime/index.js";

describe("OpenAIRealtimeTrialClient", () => {
  it("builds a two-minute voice interviewer with transcription and a strict insight tool", () => {
    const session = buildTrialSessionConfig("gpt-realtime-test", "marin");

    expect(session).toMatchObject({
      type: "realtime",
      model: "gpt-realtime-test",
      output_modalities: ["audio"],
      audio: {
        input: {
          transcription: { model: "gpt-4o-mini-transcribe", language: "en" },
          turn_detection: { type: "semantic_vad", create_response: true }
        },
        output: { voice: "marin" }
      }
    });
    expect(String(session.instructions)).toContain("at most two minutes");
    expect(session.tools).toEqual([
      expect.objectContaining({
        type: "function",
        name: "capture_business_insight",
        parameters: expect.objectContaining({
          additionalProperties: false,
          required: ["category", "label", "detail"]
        })
      })
    ]);
  });

  it("keeps the API key server-side and posts SDP plus session configuration", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toEqual({
        Authorization: "Bearer server-secret",
        "OpenAI-Safety-Identifier": "scout-trial-safe-id"
      });
      const body = init?.body;
      expect(body).toBeInstanceOf(FormData);
      const form = body as FormData;
      expect(form.get("sdp")).toBe("v=0\r\ntest-offer");
      const session = JSON.parse(String(form.get("session")));
      expect(session.model).toBe("gpt-realtime-test");
      return new Response("v=0\r\ntest-answer", {
        status: 201,
        headers: { Location: "/v1/realtime/calls/call_123" }
      });
    });
    const client = new OpenAIRealtimeTrialClient({
      apiKey: "server-secret",
      model: "gpt-realtime-test",
      voice: "marin",
      fetchImpl: fetchImpl as typeof fetch
    });

    await expect(
      client.createCall({
        sdp: "v=0\r\ntest-offer",
        safetyIdentifier: "scout-trial-safe-id"
      })
    ).resolves.toEqual({ sdp: "v=0\r\ntest-answer", callId: "call_123" });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.openai.com/v1/realtime/calls",
      expect.objectContaining({ method: "POST" })
    );
  });
});
