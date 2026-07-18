import express from "express";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { SessionStore } from "./session-store.js";

const app = express();
const store = new SessionStore();
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const publicDir = path.join(rootDir, "public");
const port = Number(process.env.PORT ?? 3000);

app.use(express.json({ limit: "1mb" }));
app.use("/vendor/mermaid", express.static(path.join(rootDir, "node_modules/mermaid/dist")));
app.use(express.static(publicDir));

app.get("/health", (_request, response) => {
  response.json({ ok: true });
});

app.post("/api/sessions", (request, response) => {
  const meetingUrl =
    typeof request.body?.meetingUrl === "string" ? request.body.meetingUrl : "";
  if (!meetingUrl) {
    response.status(400).json({ error: "meetingUrl is required" });
    return;
  }
  const snapshot = store.create(meetingUrl);
  response.status(201).json({
    sessionId: snapshot.id,
    operatorUrl: `/operator/${snapshot.id}`,
    whiteboardUrl: `/whiteboard/${snapshot.id}`
  });
});

app.get("/api/sessions/:sessionId", (request, response) => {
  const snapshot = store.get(request.params.sessionId);
  if (!snapshot) {
    response.status(404).json({ error: "session not found" });
    return;
  }
  response.json(snapshot);
});

app.get("/events/:sessionId", (request, response) => {
  const snapshot = store.get(request.params.sessionId);
  if (!snapshot) {
    response.status(404).end();
    return;
  }

  response.status(200);
  response.setHeader("Content-Type", "text/event-stream");
  response.setHeader("Cache-Control", "no-cache, no-transform");
  response.setHeader("Connection", "keep-alive");
  response.flushHeaders();

  const unsubscribe = store.subscribe(request.params.sessionId, (next) => {
    response.write(`event: session\ndata: ${JSON.stringify(next)}\n\n`);
  });
  const heartbeat = setInterval(() => {
    response.write(": heartbeat\n\n");
  }, 15_000);

  request.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

app.get("/operator/:sessionId", (_request, response) => {
  response.sendFile(path.join(publicDir, "operator.html"));
});

app.get("/whiteboard/:sessionId", (_request, response) => {
  response.sendFile(path.join(publicDir, "whiteboard.html"));
});

app.listen(port, "127.0.0.1", () => {
  console.log(`Scout v2 listening on http://127.0.0.1:${port}`);
});

export { app, store };
