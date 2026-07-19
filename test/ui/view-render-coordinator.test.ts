import { describe, expect, it, vi } from "vitest";
import { createViewRenderCoordinator } from "../../public/js/view-render-coordinator.js";

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("createViewRenderCoordinator", () => {
  it("renders the active view first and defers changed inactive views", async () => {
    const idle: Array<() => void> = [];
    const render = vi.fn(async ({ viewKind, semanticHash }) => `${viewKind}:${semanticHash}`);
    const commit = vi.fn((_request: unknown) => {});
    const coordinator = createViewRenderCoordinator({
      project: (graph: Record<string, string>, viewKind) => graph[viewKind],
      hash: String,
      render,
      commit,
      scheduleIdle(callback) {
        idle.push(callback);
        return callback;
      },
      cancelIdle(handle) {
        const index = idle.indexOf(handle as () => void);
        if (index >= 0) idle.splice(index, 1);
      }
    });

    coordinator.offer({
      revision: 4,
      graph: { process: "p1", organization: "o1", architecture: "a1" }
    });
    await flush();

    expect(render).toHaveBeenCalledTimes(1);
    expect(render.mock.calls[0]?.[0]).toMatchObject({ viewKind: "process", revision: 4 });
    expect(commit).toHaveBeenCalledTimes(1);
    expect(idle).toHaveLength(1);

    idle.shift()?.();
    await flush();
    expect(render.mock.calls[1]?.[0]).toMatchObject({ viewKind: "organization" });
  });

  it("skips semantic no-op renders while advancing artifact freshness", async () => {
    const render = vi.fn(async ({ semanticHash }) => semanticHash);
    const coordinator = createViewRenderCoordinator({
      viewKinds: ["process"],
      project: (graph: { value: string }) => graph.value,
      hash: String,
      render,
      commit: vi.fn()
    });

    coordinator.offer({ revision: 1, graph: { value: "same" } });
    await flush();
    coordinator.offer({ revision: 2, graph: { value: "same" } });
    await flush();

    expect(render).toHaveBeenCalledOnce();
    expect(coordinator.state("process")).toMatchObject({
      committedRevision: 2,
      latestRequestedRevision: 2,
      status: "clean"
    });
  });

  it("never commits a stale artifact when a newer semantic revision arrives", async () => {
    const resolvers: Array<(value: string) => void> = [];
    const render = vi.fn(() => new Promise<string>((resolve) => resolvers.push(resolve)));
    const commit = vi.fn();
    const coordinator = createViewRenderCoordinator({
      viewKinds: ["process"],
      project: (graph: { value: string }) => graph.value,
      hash: String,
      render,
      commit
    });

    coordinator.offer({ revision: 1, graph: { value: "old" } });
    coordinator.offer({ revision: 2, graph: { value: "new" } });
    resolvers.shift()?.("old artifact");
    await flush();
    expect(commit).not.toHaveBeenCalled();

    resolvers.shift()?.("new artifact");
    await flush();
    expect(commit).toHaveBeenCalledOnce();
    expect(commit.mock.calls[0]?.[0]).toMatchObject({
      revision: 2,
      semanticHash: "new",
      artifact: "new artifact"
    });
  });

  it("requeues a same-hash revision that supersedes an in-flight render", async () => {
    const resolvers: Array<(value: string) => void> = [];
    const render = vi.fn((_request: unknown) => new Promise<string>((resolve) => resolvers.push(resolve)));
    const commit = vi.fn((_request: unknown) => {});
    const coordinator = createViewRenderCoordinator({
      viewKinds: ["process"],
      project: (graph: { value: string }) => graph.value,
      hash: String,
      render,
      commit
    });

    coordinator.offer({ revision: 1, graph: { value: "same" } });
    coordinator.offer({ revision: 2, graph: { value: "same" } });
    resolvers.shift()?.("revision 1 artifact");
    await flush();

    expect(commit).not.toHaveBeenCalled();
    expect(render).toHaveBeenCalledTimes(2);
    expect(render.mock.calls[1]?.[0]).toMatchObject({
      revision: 2,
      semanticHash: "same"
    });

    resolvers.shift()?.("revision 2 artifact");
    await flush();
    expect(commit).toHaveBeenCalledOnce();
    expect(commit.mock.calls[0]?.[0]).toMatchObject({
      revision: 2,
      semanticHash: "same",
      artifact: "revision 2 artifact"
    });
    expect(coordinator.state("process")).toMatchObject({
      committedRevision: 2,
      status: "clean"
    });
  });

  it("discards an in-flight artifact across a role-revision reset epoch", async () => {
    const resolvers: Array<(value: string) => void> = [];
    const render = vi.fn(() => new Promise<string>((resolve) => resolvers.push(resolve)));
    const commit = vi.fn();
    const coordinator = createViewRenderCoordinator({
      viewKinds: ["process"],
      project: (graph: { value: string }) => graph.value,
      hash: String,
      render,
      commit
    });

    coordinator.offer({ revision: 9, roleRevision: 2, graph: { value: "old epoch" } });
    coordinator.offer({ revision: 0, roleRevision: 3, graph: { value: "reset epoch" } });
    resolvers.shift()?.("stale artifact");
    await flush();
    expect(commit).not.toHaveBeenCalled();

    resolvers.shift()?.("reset artifact");
    await flush();
    expect(commit).toHaveBeenCalledOnce();
    expect(commit.mock.calls[0]?.[0]).toMatchObject({
      revision: 0,
      roleRevision: 3,
      artifact: "reset artifact"
    });
  });

  it("retains a committed artifact when its next render fails and can retry", async () => {
    const render = vi.fn()
      .mockResolvedValueOnce("valid")
      .mockRejectedValueOnce(new Error("layout collision"))
      .mockResolvedValueOnce("recovered");
    const commit = vi.fn();
    const coordinator = createViewRenderCoordinator({
      viewKinds: ["process"],
      project: (graph: { value: string }) => graph.value,
      hash: String,
      render,
      commit
    });

    coordinator.offer({ revision: 1, graph: { value: "one" } });
    await flush();
    coordinator.offer({ revision: 2, graph: { value: "two" } });
    await flush();

    expect(commit).toHaveBeenCalledTimes(1);
    expect(coordinator.state("process")).toMatchObject({
      status: "failed",
      committedRevision: 1,
      hasArtifact: true
    });

    expect(coordinator.retry()).toBe(true);
    await flush();
    expect(commit).toHaveBeenCalledTimes(2);
    expect(coordinator.state("process")).toMatchObject({
      status: "clean",
      committedRevision: 2
    });
  });

  it("prioritizes a newly activated dirty view", async () => {
    const idle: Array<() => void> = [];
    const render = vi.fn(async ({ viewKind }) => viewKind);
    const coordinator = createViewRenderCoordinator({
      project: (_graph, viewKind) => viewKind,
      hash: String,
      render,
      commit: vi.fn(),
      scheduleIdle(callback) {
        idle.push(callback);
        return callback;
      },
      cancelIdle(handle) {
        const index = idle.indexOf(handle as () => void);
        if (index >= 0) idle.splice(index, 1);
      }
    });

    coordinator.offer({ revision: 1, graph: {} });
    await flush();
    coordinator.activate("architecture");
    await flush();

    expect(render.mock.calls.map(([request]) => request.viewKind)).toEqual([
      "process",
      "architecture"
    ]);
  });
});
