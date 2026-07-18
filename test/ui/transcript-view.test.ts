import { describe, expect, it } from "vitest";
import {
  groupTranscriptTurns,
  prepareTranscriptUpdate,
  transcriptScrollTop
} from "../../public/js/transcript-view.js";

const utterance = (
  id: string,
  sequence: number,
  participantId: string,
  participantName: string,
  text: string
) => ({
  id,
  sequence,
  participantId,
  participantName,
  text,
  startedAt: sequence * 1_000,
  endedAt: sequence * 1_000 + 500,
  finalized: true
});

const cumulative = [
  utterance("utt-1", 1, "person-a", "Alex", "We export the report."),
  utterance("utt-2", 2, "person-a", "Alex", "Then Finance reviews it."),
  utterance("utt-3", 3, "person-b", "Maya", "That takes two days."),
  utterance("utt-4", 4, "person-a", "Alex", "We want to automate it.")
];

describe("groupTranscriptTurns", () => {
  it("keeps every cumulative finalized fragment and evidence ID in sequence", () => {
    const turns = groupTranscriptTurns(cumulative);
    expect(turns.flatMap((turn) => turn.fragments.map((item) => item.id))).toEqual(
      ["utt-1", "utt-2", "utt-3", "utt-4"]
    );
    expect(
      turns.flatMap((turn) => turn.fragments.map((item) => item.text))
    ).toEqual([
      "We export the report.",
      "Then Finance reviews it.",
      "That takes two days.",
      "We want to automate it."
    ]);
  });

  it("groups only contiguous fragments from the same participant", () => {
    const turns = groupTranscriptTurns(cumulative);
    expect(turns).toHaveLength(3);
    expect(turns[0]?.participantName).toBe("Alex");
    expect(turns[0]?.fragments.map((item) => item.id)).toEqual([
      "utt-1",
      "utt-2"
    ]);
    expect(turns[2]?.participantName).toBe("Alex");
    expect(turns[2]?.fragments.map((item) => item.id)).toEqual(["utt-4"]);
  });
});

describe("prepareTranscriptUpdate", () => {
  it("does not rebuild or move the transcript for a status-only snapshot", () => {
    const initial = prepareTranscriptUpdate(cumulative, "", {
      scrollTop: 180,
      scrollHeight: 900,
      clientHeight: 300
    });
    const statusOnly = prepareTranscriptUpdate(
      cumulative,
      initial.signature,
      {
        scrollTop: 180,
        scrollHeight: 900,
        clientHeight: 300
      }
    );

    expect(statusOnly.changed).toBe(false);
    expect(statusOnly.preservedScrollTop).toBe(180);
  });

  it("auto-follows new content only when already near the bottom", () => {
    const before = cumulative.slice(0, 3);
    const initial = prepareTranscriptUpdate(before, "");
    const update = prepareTranscriptUpdate(cumulative, initial.signature, {
      scrollTop: 630,
      scrollHeight: 1_000,
      clientHeight: 320
    });

    expect(update.follow).toBe(true);
    expect(transcriptScrollTop(update, 1_160)).toBe(1_160);
  });

  it("preserves an exact scrolled-up reader position when content arrives", () => {
    const before = cumulative.slice(0, 3);
    const initial = prepareTranscriptUpdate(before, "");
    const update = prepareTranscriptUpdate(cumulative, initial.signature, {
      scrollTop: 220,
      scrollHeight: 1_000,
      clientHeight: 320
    });

    expect(update.follow).toBe(false);
    expect(transcriptScrollTop(update, 1_160)).toBe(220);
  });
});
