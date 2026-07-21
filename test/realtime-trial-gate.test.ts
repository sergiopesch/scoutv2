import { describe, expect, it } from "vitest";
import { TrialGate } from "../src/server/realtime/index.js";

describe("TrialGate", () => {
  it("caps concurrent public interviews and frees a released lease", () => {
    let sequence = 0;
    const gate = new TrialGate({
      maxActive: 1,
      now: () => 1_000,
      idFactory: () => `trial-${++sequence}`
    });

    const first = gate.acquire("browser-a");
    expect(first).toEqual({
      accepted: true,
      admission: { id: "trial-1", expiresAt: 151_000 }
    });
    expect(gate.acquire("browser-b")).toMatchObject({
      accepted: false,
      reason: "capacity"
    });

    if (first.accepted) gate.release(first.admission.id);
    expect(gate.acquire("browser-b")).toMatchObject({ accepted: true });
  });

  it("rate limits repeated starts and expires inactive leases", () => {
    let now = 10_000;
    let sequence = 0;
    const gate = new TrialGate({
      maxActive: 2,
      maxStartsPerWindow: 2,
      windowMs: 1_000,
      leaseMs: 200,
      now: () => now,
      idFactory: () => `trial-${++sequence}`
    });

    const first = gate.acquire("browser-a");
    if (first.accepted) gate.release(first.admission.id);
    const second = gate.acquire("browser-a");
    if (second.accepted) gate.release(second.admission.id);
    expect(gate.acquire("browser-a")).toMatchObject({
      accepted: false,
      reason: "rate",
      retryAfterSeconds: 1
    });

    now += 1_001;
    expect(gate.acquire("browser-a")).toMatchObject({ accepted: true });
    now += 201;
    expect(gate.activeCount()).toBe(0);
  });
});
