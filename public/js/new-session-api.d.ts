export type MeetingUrlValidation =
  | { valid: true; meetingUrl: string }
  | { valid: false; message: string };

export interface CreatedSession {
  sessionId?: string;
  operatorUrl: string;
  whiteboardUrl: string;
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

export function validateMeetingUrl(value: unknown): MeetingUrlValidation;

export function createSession(
  meetingUrl: string,
  fetchImpl?: FetchSession
): Promise<CreatedSession>;
