import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const port = 41_000 + (process.pid % 1_000);
let server: ChildProcess;

beforeAll(async () => {
  server = spawn(process.execPath, ["server.mjs"], {
    cwd: path.join(projectRoot, "DemoCustomer/veyra-house"),
    env: { ...process.env, VEYRA_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"]
  });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Veyra demo server did not start")),
      5_000
    );
    server.once("error", reject);
    server.stdout?.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("Veyra House is available")) {
        clearTimeout(timeout);
        resolve();
      }
    });
  });
});

afterAll(async () => {
  if (!server || server.exitCode !== null) return;
  server.kill("SIGTERM");
  await once(server, "exit");
});

describe("Veyra demo static server", () => {
  it("serves only explicit public assets and handles malformed paths safely", async () => {
    for (const pathname of ["/", "/styles.css", "/assets/veyra-hero.jpg"]) {
      expect((await fetch(`http://127.0.0.1:${port}${pathname}`)).status).toBe(200);
    }
    for (const pathname of [
      "/server.mjs",
      "/package.json",
      "/CUSTOMER_ROLE.md",
      "/node_modules/vite/package.json",
      "/assets/../server.mjs"
    ]) {
      expect((await fetch(`http://127.0.0.1:${port}${pathname}`)).status).toBe(404);
    }
    expect((await fetch(`http://127.0.0.1:${port}/%ZZ`)).status).toBe(400);
    expect(
      (await fetch(`http://127.0.0.1:${port}/`, { method: "POST" })).status
    ).toBe(405);
  });
});
