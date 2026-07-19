import { describe, expect, it } from "vitest";
import {
  markQuestionAsked,
  mergeSuggestedQuestion,
  questionQueueStorageKey,
  readQuestionQueue,
  writeQuestionQueue
} from "../../public/js/question-dock.js";

class MemoryStorage {
  readonly values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

describe("suggested question dock", () => {
  it("quietly accumulates and deduplicates questions across revisions", () => {
    const first = mergeSuggestedQuestion([], "Where is the order re-keyed?");
    const second = mergeSuggestedQuestion(first, "Who approves an exception?");
    const repeated = mergeSuggestedQuestion(second, "  Where is the order re-keyed?  ");

    expect(repeated.map((question) => question.text)).toEqual([
      "Where is the order re-keyed?",
      "Who approves an exception?"
    ]);
    expect(new Set(repeated.map((question) => question.id)).size).toBe(2);
  });

  it("preserves asked state when a question is suggested again", () => {
    const queue = mergeSuggestedQuestion([], "Who owns the failure path?");
    const asked = markQuestionAsked(queue, queue[0]!.id, true);
    const repeated = mergeSuggestedQuestion(asked, "Who owns the failure path?");

    expect(repeated[0]).toMatchObject({ asked: true });
  });

  it("stores checklist progress per Scout surface and fails closed on bad data", () => {
    const storage = new MemoryStorage();
    const key = questionQueueStorageKey("meeting-123");
    const queue = mergeSuggestedQuestion([], "What happens when inventory is short?");

    expect(writeQuestionQueue(storage, key, queue)).toBe(true);
    expect(readQuestionQueue(storage, key)).toEqual(queue);
    storage.setItem(key, "not-json");
    expect(readQuestionQueue(storage, key)).toEqual([]);
  });
});
