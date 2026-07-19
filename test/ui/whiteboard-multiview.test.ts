import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const readWhiteboard = () => readFile(
  new URL("../../public/whiteboard.html", import.meta.url),
  "utf8"
);
const readWhiteboardController = () => readFile(
  new URL("../../public/js/whiteboard.js", import.meta.url),
  "utf8"
);

describe("multi-view whiteboard shell", () => {
  it("ships one accessible tab and retained panel for every canonical view", async () => {
    const html = await readWhiteboard();
    expect(html).toContain('role="tablist"');
    for (const [key, label] of [
      ["process", "Process"],
      ["organization", "Organisation"],
      ["architecture", "Architecture"]
    ]) {
      expect(html).toContain(`id="tab-${key}"`);
      expect(html).toContain(`aria-controls="panel-${key}"`);
      expect(html).toContain(`data-view-panel="${key}"`);
      expect(html).toContain(`data-graph-frame="${key}"`);
      expect(html).toContain(`>${label}</span>`);
    }
  });

  it("provides state, zoom, follow-live, summary and accessible outline controls", async () => {
    const html = await readWhiteboard();
    expect(html).toContain('data-scope="current"');
    expect(html).toContain('data-scope="desired"');
    expect(html).toContain('id="zoom-in"');
    expect(html).toContain('id="zoom-fit"');
    expect(html).toContain('id="zoom-out"');
    expect(html).toContain('id="follow-live"');
    expect(html).toContain('id="render-retry"');
    expect(html).toContain('id="view-summary" aria-live="polite"');
    expect(html).toContain('id="view-outline" aria-label="Accessible diagram outline"');
  });

  it("uses honest empty states instead of inferring unsupported structure", async () => {
    const html = await readWhiteboard();
    expect(html).toContain("No reporting structure yet");
    expect(html).toContain("only draw positions, units and reporting lines that are explicitly supported");
  });

  it("preserves focused diagram entities across atomic SVG replacement without selector interpolation", async () => {
    const source = await readWhiteboardController();
    expect(source).toContain('frame.contains(document.activeElement)');
    expect(source).toContain('.find((element) => element.dataset.entityId === focusedEntity)');
    expect(source).toContain('focus({ preventScroll: true })');
    expect(source).not.toContain('querySelector(`[data-entity-id="${focusedEntity}"]`)');
  });

  it("configures dark Mermaid edge-label text on the light label background", async () => {
    const source = await readWhiteboardController();
    expect(source).toContain('textColor: "#101115"');
    expect(source).toContain('edgeLabelBackground: "#FAFAF7"');
  });

  it("rejects layout candidates that declare omitted semantic edges", async () => {
    const source = await readWhiteboardController();
    expect(source).toContain("candidate.omittedSemanticEdgeIds.length > 0");
    expect(source).toContain('throw new Error(`omits semantic edges:');
    expect(source).toContain("geometry.edges.length < candidate.renderedSemanticEdgeIds.length");
    expect(source).toContain('type: "unmeasured-semantic-edges"');
  });
});
