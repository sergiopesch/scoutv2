import { createRequire } from "node:module";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const mermaidRoot = path.dirname(require.resolve("mermaid/package.json"));
// This is the prebuilt browser chunk served by /vendor/mermaid, rather than
// the standalone KaTeX dependency that an npm override can replace.
const chunks = path.join(mermaidRoot, "dist/chunks/mermaid.esm.min");
const bundledMathFile = (await readdir(chunks)).find((name) => /^katex-.*\.mjs$/.test(name));
if (!bundledMathFile) throw new Error("Mermaid browser math chunk was not found");
const { default: bundledMath } = await import(/* @vite-ignore */ pathToFileURL(path.join(chunks, bundledMathFile)).href);

describe("served Mermaid browser math", () => {
  it("does not inherit trust permission from a polluted options prototype", () => {
    const options = Object.assign(Object.create({ trust: true }), { throwOnError: false });
    const output = bundledMath.renderToString("\\href{javascript:alert(1)}{click}", options);
    expect(output).not.toContain('href="javascript:');
  });

  it("keeps ordinary mathematics available", () => {
    const output = bundledMath.renderToString("x^2", { trust: false });
    expect(output).toContain("katex");
    expect(output).toContain("<math");
  });
});
