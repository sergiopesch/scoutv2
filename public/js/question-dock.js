const cleanText = (value) => String(value ?? "").trim().replace(/\s+/g, " ");

const questionId = (text) => {
  let hash = 2166136261;
  for (const character of text) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return `question-${(hash >>> 0).toString(36)}`;
};

const validQuestion = (value) => {
  if (!value || typeof value !== "object") return undefined;
  const text = cleanText(value.text);
  if (!text) return undefined;
  return {
    id: questionId(text.toLocaleLowerCase()),
    text,
    asked: value.asked === true
  };
};

export function mergeSuggestedQuestion(queue, suggestedQuestion, limit = 6) {
  const current = Array.isArray(queue)
    ? queue.map(validQuestion).filter(Boolean)
    : [];
  const text = cleanText(suggestedQuestion);
  if (!text) return current.slice(0, limit);
  const id = questionId(text.toLocaleLowerCase());
  const existing = current.find((question) => question.id === id);
  return [
    { id, text, asked: existing?.asked === true },
    ...current.filter((question) => question.id !== id)
  ].slice(0, Math.max(1, limit));
}

export function markQuestionAsked(queue, questionIdValue, asked) {
  return (Array.isArray(queue) ? queue : []).map((question) =>
    question.id === questionIdValue
      ? { ...question, asked: asked === true }
      : question
  );
}

export function questionQueueStorageKey(sessionId) {
  return `scout:question-queue:${String(sessionId || "unknown")}`;
}

export function readQuestionQueue(storage, key) {
  if (!storage) return [];
  try {
    const parsed = JSON.parse(storage.getItem(key) ?? "[]");
    return Array.isArray(parsed)
      ? parsed.map(validQuestion).filter(Boolean).slice(0, 6)
      : [];
  } catch {
    return [];
  }
}

export function writeQuestionQueue(storage, key, queue) {
  if (!storage) return false;
  try {
    storage.setItem(key, JSON.stringify(queue));
    return true;
  } catch {
    return false;
  }
}
