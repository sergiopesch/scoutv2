export type MeetingUrlValidation =
  | { valid: true; meetingUrl: string }
  | { valid: false; message: string };

export interface CreatedSession {
  sessionId: string;
  operatorUrl: string;
  whiteboardUrl: string;
  mode: "live" | "rehearsal";
}

export interface ReadinessDependency {
  ready: boolean;
  detail?: string;
}

export interface ScoutReadiness {
  ok: boolean;
  mode: "live" | "rehearsal" | "unavailable";
  codex: ReadinessDependency;
  recall: ReadinessDependency;
}

export interface FetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type FetchSession = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
  }
) => Promise<FetchResponse>;

export type FetchReadiness = (
  input: string,
  init: { headers: Record<string, string> }
) => Promise<FetchResponse>;

export function validateMeetingUrl(value: unknown): MeetingUrlValidation;

export function createSession(
  meetingUrl: string,
  fetchImpl?: FetchSession
): Promise<CreatedSession>;

export function loadReadiness(
  fetchImpl?: FetchReadiness
): Promise<ScoutReadiness>;
