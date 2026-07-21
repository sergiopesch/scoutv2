export interface RealtimeTrialCallInput {
  sdp: string;
  safetyIdentifier: string;
  signal?: AbortSignal;
}

export interface RealtimeTrialCall {
  sdp: string;
  callId?: string;
}

export interface RealtimeTrialAdapter {
  createCall(input: RealtimeTrialCallInput): Promise<RealtimeTrialCall>;
}

export interface OpenAIRealtimeTrialClientOptions {
  apiKey: string;
  model?: string;
  voice?: string;
  fetchImpl?: typeof fetch;
}

export const SCOUT_TRIAL_INSTRUCTIONS = `You are Scout, an AI business discovery interviewer. You have at most two minutes.

Your job is to understand one real business workflow well enough to map its process, owners, systems, pain points, and desired outcome.

Interview rules:
- Start by saying: "Hi, I'm Scout. In two minutes, let's map one workflow that matters to your business. What process should we look at?"
- Ask exactly one concise question at a time. Keep each question under 18 words.
- Listen more than you speak. Do not give advice, sell, or explain the product during the interview.
- Prioritize: the trigger and outcome; the steps and decisions; who owns them; the systems involved; where delays, rework, or handoffs fail; and what better would look like.
- Ask no more than four substantive questions. Use follow-ups only to resolve a concrete gap.
- Never invent a company, role, system, step, metric, or problem.
- After every substantive user answer, call capture_business_insight once for every distinct supported insight before asking the next question.
- If time is nearly over, give a two-sentence recap and ask no new question.
- If the user asks to stop, acknowledge briefly and finish.

Tool discipline:
- Labels must be 2–6 words and understandable on a diagram.
- Details must be one plain sentence grounded in what the user said.
- Use process for work steps or decisions, organisation for teams or owners, system for software/data/tools, pain for friction or risk, and outcome for desired results.
- Use the user's wording where practical, without claiming an exact quote.`;

export const buildTrialSessionConfig = (
  model: string,
  voice: string
): Record<string, unknown> => ({
  type: "realtime",
  model,
  output_modalities: ["audio"],
  instructions: SCOUT_TRIAL_INSTRUCTIONS,
  max_output_tokens: 700,
  audio: {
    input: {
      transcription: {
        model: "gpt-4o-mini-transcribe",
        language: "en"
      },
      turn_detection: {
        type: "semantic_vad",
        eagerness: "high",
        create_response: true,
        interrupt_response: true
      }
    },
    output: {
      voice
    }
  },
  tools: [
    {
      type: "function",
      name: "capture_business_insight",
      description:
        "Record one diagram-worthy fact supported by the visitor's latest answer.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          category: {
            type: "string",
            enum: ["process", "organisation", "system", "pain", "outcome"]
          },
          label: {
            type: "string",
            description: "A concise 2–6 word diagram label."
          },
          detail: {
            type: "string",
            description: "One sentence grounded in the visitor's answer."
          }
        },
        required: ["category", "label", "detail"]
      }
    }
  ],
  tool_choice: "auto"
});

export class OpenAIRealtimeTrialClient implements RealtimeTrialAdapter {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly voice: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAIRealtimeTrialClientOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model ?? "gpt-realtime-2.1";
    this.voice = options.voice ?? "marin";
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async createCall(
    input: RealtimeTrialCallInput
  ): Promise<RealtimeTrialCall> {
    const form = new FormData();
    form.set("sdp", input.sdp);
    form.set(
      "session",
      JSON.stringify(buildTrialSessionConfig(this.model, this.voice))
    );

    const response = await this.fetchImpl(
      "https://api.openai.com/v1/realtime/calls",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "OpenAI-Safety-Identifier": input.safetyIdentifier
        },
        body: form,
        signal: input.signal
      }
    );
    if (!response.ok) {
      throw new Error(`OpenAI Realtime call creation failed (${response.status}).`);
    }

    const location = response.headers.get("Location");
    const callId = location?.split("/").filter(Boolean).at(-1);
    return {
      sdp: await response.text(),
      ...(callId ? { callId } : {})
    };
  }
}
