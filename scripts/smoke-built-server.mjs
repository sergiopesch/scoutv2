import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const host = "127.0.0.1";
const port = Number.parseInt(process.env.SCOUT_SMOKE_PORT ?? "3199", 10);
assert(
  Number.isInteger(port) && port > 0 && port < 65_536,
  "SCOUT_SMOKE_PORT must be a valid TCP port."
);

const output = [];
const child = spawn(process.execPath, ["dist/src/server/index.js"], {
  env: {
    ...process.env,
    NODE_ENV: "test",
    HOST: host,
    PORT: String(port),
    SCOUT_ALLOW_DEV_INGEST: "true"
  },
  stdio: ["ignore", "pipe", "pipe"]
});

for (const stream of [child.stdout, child.stderr]) {
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => output.push(chunk));
}

const exit = new Promise((resolve) => {
  child.once("exit", (code, signal) => resolve({ code, signal }));
});

const baseUrl = `http://${host}:${port}`;

async function waitUntilLive() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/livez`);
      if (response.ok) return;
    } catch {
      // The listener may still be starting.
    }
    await delay(250);
  }
  throw new Error(`Scout did not become live.\n${output.join("")}`);
}

async function stopServer() {
  if (child.exitCode !== null || child.signalCode !== null) return exit;
  child.kill("SIGTERM");
  const graceful = await Promise.race([
    exit,
    delay(10_000, undefined, { ref: false }).then(() => undefined)
  ]);
  if (graceful) return graceful;
  child.kill("SIGKILL");
  await exit;
  throw new Error(`Scout did not stop within 10 seconds.\n${output.join("")}`);
}

try {
  await waitUntilLive();

  const metricsResponse = await fetch(`${baseUrl}/metrics`);
  assert.equal(metricsResponse.status, 200);
  assert.equal(typeof (await metricsResponse.json()), "object");

  const startResponse = await fetch(`${baseUrl}/operator/new/`);
  assert.equal(startResponse.status, 200);
  assert.match(await startResponse.text(), /Every meeting/);
} finally {
  const result = await stopServer();
  assert.equal(result.code, 0, `Scout exited unexpectedly.\n${output.join("")}`);
}

console.log(`Scout smoke test passed at ${baseUrl}.`);
