export interface QuestionQueueItem {
  id: string;
  text: string;
  asked: boolean;
}

export function mergeSuggestedQuestion(
  queue: QuestionQueueItem[],
  suggestedQuestion: unknown,
  limit?: number
): QuestionQueueItem[];
export function markQuestionAsked(
  queue: QuestionQueueItem[],
  questionId: string,
  asked: boolean
): QuestionQueueItem[];
export function questionQueueStorageKey(sessionId?: string): string;
export function readQuestionQueue(
  storage: Pick<Storage, "getItem"> | undefined,
  key: string
): QuestionQueueItem[];
export function writeQuestionQueue(
  storage: Pick<Storage, "setItem"> | undefined,
  key: string,
  queue: QuestionQueueItem[]
): boolean;
