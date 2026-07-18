import { describe, expect, it, vi } from "vitest";
import { createRevisionRenderer } from "../../public/js/revision-renderer.js";

describe("createRevisionRenderer", () => {
  it("does not commit any part of a failed revision and retries that revision", async () => {
    const render = vi.fn()
      .mockRejectedValueOnce(new Error("Mermaid failed"))
      .mockResolvedValueOnce({ svg: "revision one" });
    const commit = vi.fn();
    const onError = vi.fn();
    const renderer = createRevisionRenderer({
      render,
      commit,
      onError,
      maxAutomaticRetries: 0
    });
    const revision = { revision: 1, topic: "New topic" };

    await expect(renderer.offer(revision)).resolves.toBe(false);
    expect(commit).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 1);

    await expect(renderer.offer(revision)).resolves.toBe(true);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith(revision, { svg: "revision one" });
    expect(renderer.committedRevision).toBe(1);
  });

  it("commits only the newest result when asynchronous renders finish out of order", async () => {
    const resolvers = new Map<number, (value: string) => void>();
    const render = (item: { revision: number }) => new Promise<string>((resolve) => {
      resolvers.set(item.revision, resolve);
    });
    const commit = vi.fn();
    const renderer = createRevisionRenderer({ render, commit, maxAutomaticRetries: 0 });

    const first = renderer.offer({ revision: 1 });
    const second = renderer.offer({ revision: 2 });
    resolvers.get(1)?.("old");
    await first;
    resolvers.get(2)?.("new");
    await second;

    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith({ revision: 2 }, "new");
    await expect(renderer.offer({ revision: 1 })).resolves.toBe(false);
  });

  it("accepts a reset revision when its session update is newer", async () => {
    const commit = vi.fn();
    const renderer = createRevisionRenderer({
      render: (item: { revision: number; updatedAt: number; graph: string }) => item.graph,
      commit,
      keyOf: (item) => `${item.revision}:${item.graph}`,
      orderOf: (item) => item.updatedAt,
      maxAutomaticRetries: 0
    });

    await renderer.offer({ revision: 5, updatedAt: 100, graph: "accepted" });
    await expect(renderer.offer({ revision: 0, updatedAt: 200, graph: "reset" }))
      .resolves.toBe(true);
    expect(commit).toHaveBeenLastCalledWith(
      { revision: 0, updatedAt: 200, graph: "reset" },
      "reset"
    );
    expect(renderer.committedRevision).toBe(0);
  });
});
