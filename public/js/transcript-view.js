const FOLLOW_THRESHOLD_PX = 72;

const cleanText = (value, fallback = "") =>
  typeof value === "string" && value.trim() ? value.trim() : fallback;

const visibleInSequence = (utterances = []) =>
  utterances
    .filter((utterance) => utterance?.text)
    .slice()
    .sort((left, right) => left.sequence - right.sequence);

export function transcriptSignature(utterances = []) {
  return JSON.stringify(
    visibleInSequence(utterances).map((utterance) => [
      utterance.id,
      utterance.sequence,
      utterance.participantId,
      utterance.participantName,
      utterance.text,
      utterance.startedAt,
      utterance.endedAt,
      utterance.finalized
    ])
  );
}

export function groupTranscriptTurns(utterances = []) {
  const turns = [];

  for (const utterance of visibleInSequence(utterances)) {
    const speakerKey =
      cleanText(utterance.participantId) ||
      cleanText(utterance.participantName, "unknown-speaker");
    const previous = turns.at(-1);
    const fragment = {
      id: cleanText(utterance.id, "missing-evidence-id"),
      sequence: utterance.sequence,
      text: cleanText(utterance.text, "[No transcript text]"),
      startedAt: utterance.startedAt,
      endedAt: utterance.endedAt,
      finalized: utterance.finalized === true
    };

    if (previous?.speakerKey === speakerKey) {
      previous.fragments.push(fragment);
      previous.endedAt = utterance.endedAt;
      continue;
    }

    turns.push({
      speakerKey,
      participantId: cleanText(utterance.participantId),
      participantName: cleanText(
        utterance.participantName,
        "Unknown speaker"
      ),
      startedAt: utterance.startedAt,
      endedAt: utterance.endedAt,
      fragments: [fragment]
    });
  }

  return turns;
}

export function prepareTranscriptUpdate(
  utterances,
  previousSignature,
  { scrollTop = 0, scrollHeight = 0, clientHeight = 0 } = {}
) {
  const signature = transcriptSignature(utterances);
  if (signature === previousSignature) {
    return {
      changed: false,
      signature,
      turns: [],
      follow: false,
      preservedScrollTop: scrollTop
    };
  }

  const distanceFromBottom = Math.max(
    0,
    scrollHeight - clientHeight - scrollTop
  );
  return {
    changed: true,
    signature,
    turns: groupTranscriptTurns(utterances),
    follow: distanceFromBottom <= FOLLOW_THRESHOLD_PX,
    preservedScrollTop: scrollTop
  };
}

export function transcriptScrollTop(update, nextScrollHeight) {
  return update.follow ? nextScrollHeight : update.preservedScrollTop;
}
