import type {
  BusinessGraph,
  Participant,
  Utterance
} from "../shared/types.js";

export interface AnalyzeMeetingInput {
  sessionId: string;
  threadId?: string;
  currentGraph: BusinessGraph;
  participants: Participant[];
  newUtterances: Utterance[];
}

export interface AnalyzeMeetingResult {
  threadId: string;
  graph: BusinessGraph;
}

export interface MeetingAnalyzer {
  analyze(input: AnalyzeMeetingInput): Promise<AnalyzeMeetingResult>;
  close(): Promise<void>;
}

export interface RecallBotConfig {
  meetingUrl: string;
  botName: string;
  publicBaseUrl: string;
  sessionId: string;
  sessionToken: string;
}

export interface RecallBotResult {
  botId: string;
}

export type NormalizedMeetingEvent =
  | { type: "participant.joined"; participant: Participant }
  | { type: "transcript.final"; utterance: Utterance }
  | {
      type: "bot.status";
      status: string;
      detail?: string;
    };

export interface RecallAdapter {
  createBot(config: RecallBotConfig): Promise<RecallBotResult>;
  verifyWebhook(rawBody: string, headers: Record<string, string>): void;
  normalizeEvent(payload: unknown): NormalizedMeetingEvent[];
}
