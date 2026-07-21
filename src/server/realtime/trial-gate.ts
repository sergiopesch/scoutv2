import { randomBytes } from "node:crypto";

export interface TrialAdmission {
  id: string;
  expiresAt: number;
}

export type TrialAdmissionResult =
  | { accepted: true; admission: TrialAdmission }
  | { accepted: false; retryAfterSeconds: number; reason: "capacity" | "rate" };

interface ActiveTrial {
  clientId: string;
  expiresAt: number;
}

export interface TrialGateOptions {
  maxActive?: number;
  maxStartsPerWindow?: number;
  windowMs?: number;
  leaseMs?: number;
  now?: () => number;
  idFactory?: () => string;
}

export class TrialGate {
  private readonly active = new Map<string, ActiveTrial>();
  private readonly startsByClient = new Map<string, number[]>();
  private readonly maxActive: number;
  private readonly maxStartsPerWindow: number;
  private readonly windowMs: number;
  private readonly leaseMs: number;
  private readonly now: () => number;
  private readonly idFactory: () => string;

  constructor(options: TrialGateOptions = {}) {
    this.maxActive = options.maxActive ?? 3;
    this.maxStartsPerWindow = options.maxStartsPerWindow ?? 4;
    this.windowMs = options.windowMs ?? 15 * 60_000;
    this.leaseMs = options.leaseMs ?? 150_000;
    this.now = options.now ?? Date.now;
    this.idFactory =
      options.idFactory ?? (() => randomBytes(18).toString("base64url"));
  }

  acquire(clientId: string): TrialAdmissionResult {
    const now = this.now();
    this.sweep(now);

    if (this.active.size >= this.maxActive) {
      const nextExpiry = Math.min(
        ...[...this.active.values()].map((trial) => trial.expiresAt)
      );
      return {
        accepted: false,
        reason: "capacity",
        retryAfterSeconds: Math.max(1, Math.ceil((nextExpiry - now) / 1_000))
      };
    }

    const recentStarts = (this.startsByClient.get(clientId) ?? []).filter(
      (startedAt) => startedAt > now - this.windowMs
    );
    if (recentStarts.length >= this.maxStartsPerWindow) {
      const retryAt = recentStarts[0]! + this.windowMs;
      this.startsByClient.set(clientId, recentStarts);
      return {
        accepted: false,
        reason: "rate",
        retryAfterSeconds: Math.max(1, Math.ceil((retryAt - now) / 1_000))
      };
    }

    const admission = {
      id: this.idFactory(),
      expiresAt: now + this.leaseMs
    };
    recentStarts.push(now);
    this.startsByClient.set(clientId, recentStarts);
    this.active.set(admission.id, {
      clientId,
      expiresAt: admission.expiresAt
    });
    return { accepted: true, admission };
  }

  release(id: string): boolean {
    return this.active.delete(id);
  }

  activeCount(): number {
    this.sweep(this.now());
    return this.active.size;
  }

  clear(): void {
    this.active.clear();
    this.startsByClient.clear();
  }

  private sweep(now: number): void {
    for (const [id, trial] of this.active) {
      if (trial.expiresAt <= now) this.active.delete(id);
    }
    for (const [clientId, starts] of this.startsByClient) {
      const recent = starts.filter(
        (startedAt) => startedAt > now - this.windowMs
      );
      if (recent.length === 0) this.startsByClient.delete(clientId);
      else this.startsByClient.set(clientId, recent);
    }
  }
}
