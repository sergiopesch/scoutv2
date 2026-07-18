import type {
  BusinessGraph,
  Participant,
  ParticipantRole,
  Utterance
} from "../shared/types.js";

export interface AnalysisUtterance extends Utterance {
  participantRole: ParticipantRole | "unknown";
}

export interface AnalyzeMeetingInput {
  sessionId: string;
  threadId?: string;
  currentGraph: BusinessGraph;
  participants: Participant[];
  newUtterances: AnalysisUtterance[];
}

export interface AnalyzeMeetingResult {
  threadId: string;
  graph: BusinessGraph;
}

export interface DependencyReadiness {
  ready: boolean;
  detail?: string;
}

export interface MeetingAnalyzer {
  analyze(input: AnalyzeMeetingInput): Promise<AnalyzeMeetingResult>;
  resetSession?(sessionId: string): Promise<void>;
  checkReadiness?(): Promise<DependencyReadiness>;
  close(): Promise<void>;
}

export interface RecallBotConfig {
  meetingUrl: string;
  botName: string;
  publicBaseUrl: string;
  sessionId: string;
  correlationId: string;
  sessionToken: string;
  whiteboardId: string;
}

export interface RecallBotResult {
  botId: string;
}

export type NormalizedBotStatus =
  | "creating"
  | "waiting_for_admission"
  | "listening"
  | "ended"
  | "error";

export type NormalizedMeetingEvent =
  | { type: "participant.joined"; participant: Participant; occurredAt?: number }
  | {
      type: "participant.changed";
      action: "joined" | "updated" | "left";
      participant: Participant;
      occurredAt?: number;
    }
  | { type: "transcript.partial"; utterance: Utterance }
  | { type: "transcript.final"; utterance: Utterance }
  | {
      type: "bot.status";
      botId?: string;
      status: NormalizedBotStatus;
      detail?: string;
      occurredAt?: number;
    }
  | {
      type: "integration.error";
      source: "recall";
      code: string;
      detail: string;
      botId?: string;
      occurredAt?: number;
      fatal: boolean;
    };

export interface RecallAdapter {
  createBot(config: RecallBotConfig): Promise<RecallBotResult>;
  findBotsByCorrelationId?(correlationId: string): Promise<string[]>;
  pauseRecording(botId: string): Promise<void>;
  resumeRecording(botId: string): Promise<void>;
  leaveBot?(botId: string): Promise<void>;
  checkReadiness?(): Promise<DependencyReadiness>;
  verifyWebhook(rawBody: string, headers: Record<string, string>): void;
  normalizeEvent(payload: unknown): NormalizedMeetingEvent[];
}
