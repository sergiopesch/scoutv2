import { describe, expect, it, vi } from "vitest";
import { reconcileKeyedChildren } from "../../public/js/keyed-list.js";

class FakeChild {
  dataset: Record<string, string | undefined> = {};
  value = "";
  owner?: FakeContainer;

  remove() {
    if (!this.owner) return;
    const index = this.owner.children.indexOf(this);
    if (index >= 0) this.owner.children.splice(index, 1);
    this.owner = undefined;
  }
}

class FakeContainer {
  children: FakeChild[] = [];

  insertBefore(child: FakeChild, before: FakeChild | null) {
    const previousIndex = this.children.indexOf(child);
    if (previousIndex >= 0) this.children.splice(previousIndex, 1);
    const nextIndex = before ? this.children.indexOf(before) : -1;
    this.children.splice(nextIndex >= 0 ? nextIndex : this.children.length, 0, child);
    child.owner = this;
  }
}

describe("reconcileKeyedChildren", () => {
  it("keeps existing controls alive across status-only and reordered snapshots", () => {
    const container = new FakeContainer();
    const create = vi.fn(() => new FakeChild());
    const update = (child: FakeChild, item: { id: string; value: string }) => {
      child.value = item.value;
    };
    const operations = {
      keyOf: (item: { id: string; value: string }) => item.id,
      create,
      update
    };

    reconcileKeyedChildren(container, [
      { id: "alex", value: "Client" },
      { id: "maya", value: "Client" }
    ], operations);
    const alexControl = container.children[0];
    const mayaControl = container.children[1];

    reconcileKeyedChildren(container, [
      { id: "maya", value: "Operator · Saved" },
      { id: "alex", value: "Client" }
    ], operations);

    expect(container.children).toEqual([mayaControl, alexControl]);
    expect(container.children[0]?.value).toBe("Operator · Saved");
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("removes only keys that disappeared and creates only new keys", () => {
    const container = new FakeContainer();
    const create = vi.fn(() => new FakeChild());
    const operations = {
      keyOf: (item: { id: string }) => item.id,
      create,
      update: () => undefined
    };
    reconcileKeyedChildren(container, [{ id: "one" }, { id: "two" }], operations);
    const retained = container.children[1];
    reconcileKeyedChildren(container, [{ id: "two" }, { id: "three" }], operations);

    expect(container.children[0]).toBe(retained);
    expect(container.children.map((child) => child.dataset.key)).toEqual(["two", "three"]);
    expect(create).toHaveBeenCalledTimes(3);
  });
});
