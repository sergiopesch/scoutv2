import { createScoutRuntime } from "../../src/server/index.js";
import type { AppConfig } from "../../src/server/config.js";
import type { AnalyzeMeetingInput, MeetingAnalyzer } from "../../src/server/contracts.js";
import type { BusinessGraph } from "../../src/shared/types.js";

class FixtureAnalyzer implements MeetingAnalyzer {
  async analyze(input: AnalyzeMeetingInput) {
    return { threadId: input.threadId ?? "fixture-thread", graph: input.currentGraph };
  }
  async resetSession(): Promise<void> {}
  async close(): Promise<void> {}
  async checkReadiness() { return { ready: true }; }
}

const config: AppConfig = {
  port: 4174,
  host: "127.0.0.1",
  analysisDelayMs: 1_000,
  analysisRerunDelayMs: 500,
  analysisMaxBatchUtterances: 40,
  analysisMaxBatchBytes: 48_000,
  maxAutomaticAnalysisTurnsPerSession: 20,
  maxActiveSessions: 3,
  maxSseConnections: 128,
  maxSseConnectionsPerSession: 32,
  sessionRetentionMs: 4 * 60 * 60 * 1_000,
  shutdownGraceMs: 1_000,
  allowDevIngest: true,
  codex: { binary: "codex", model: "gpt-5.6-sol", reasoningEffort: "low" }
};

const evidence = ["utt-1"];
const graph: BusinessGraph = {
  topic: {
    id: "veyra-order-delivery",
    label: "Veyra order-to-delivery transformation",
    evidenceUtteranceIds: evidence
  },
  nodes: [
    ["capture", "Capture customer order", "process", { process: { kind: "start" } }],
    ["validate", "Validate pricing and credit", "process", { process: { kind: "activity", taskType: "business_rule" } }],
    ["allocate", "Allocate available stock", "process", { process: { kind: "activity", taskType: "service" } }],
    ["pick", "Pick and pack order", "process", { process: { kind: "activity", taskType: "manual" } }],
    ["ship", "Book carrier and ship", "process", { process: { kind: "activity", taskType: "service" } }],
    ["deliver", "Deliver and confirm receipt", "process", { process: { kind: "end" } }],
    ["ceo", "Chief Executive", "actor", { organization: { kind: "position" } }],
    ["coo", "Chief Operating Officer", "actor", { organization: { kind: "position" } }],
    ["sales-lead", "Head of Sales", "actor", { organization: { kind: "position" } }],
    ["ops-manager", "Operations Manager", "actor", { organization: { kind: "position" } }],
    ["fulfilment-lead", "Fulfilment Lead", "actor", { organization: { kind: "position" } }],
    ["storefront", "Customer storefront", "system", { architecture: { kind: "application", technology: "Web" } }],
    ["orders-api", "Orders API", "system", { architecture: { kind: "api", technology: "REST" } }],
    ["erp", "Order ERP", "system", { architecture: { kind: "software_system", product: "ERP" } }],
    ["inventory-db", "Inventory database", "system", { architecture: { kind: "database", technology: "SQL" } }],
    ["event-bus", "Fulfilment event bus", "system", { architecture: { kind: "event_bus" } }],
    ["warehouse", "Warehouse system", "system", { architecture: { kind: "external_system" } }],
    ["carrier", "Carrier network", "system", { architecture: { kind: "external_system" } }]
  ].map(([id, label, kind, facets]) => ({
    id: id as string,
    label: label as string,
    kind: kind as BusinessGraph["nodes"][number]["kind"],
    state: "current" as const,
    scope: "current" as const,
    certainty: "asserted" as const,
    confidence: 1,
    facets: facets as BusinessGraph["nodes"][number]["facets"],
    evidenceUtteranceIds: evidence
  })),
  edges: [
    ...[
      ["capture-validate", "capture", "validate"],
      ["validate-allocate", "validate", "allocate"],
      ["allocate-pick", "allocate", "pick"],
      ["pick-ship", "pick", "ship"],
      ["ship-deliver", "ship", "deliver"]
    ].map(([id, from, to]) => ({
      id: id!, from: from!, to: to!, kind: "hands_off_to" as const,
      state: "current" as const, scope: "current" as const,
      certainty: "asserted" as const, confidence: 1,
      facets: { process: { kind: "sequence" as const } }, evidenceUtteranceIds: evidence
    })),
    ...[
      ["coo-ceo", "coo", "ceo"],
      ["sales-ceo", "sales-lead", "ceo"],
      ["ops-coo", "ops-manager", "coo"],
      ["fulfilment-ops", "fulfilment-lead", "ops-manager"]
    ].map(([id, from, to]) => ({
      id: id!, from: from!, to: to!, kind: "depends_on" as const,
      state: "current" as const, scope: "current" as const,
      certainty: "asserted" as const, confidence: 1,
      facets: { organization: { kind: "primary_report" as const } }, evidenceUtteranceIds: evidence
    })),
    ...[
      ["storefront-api", "storefront", "orders-api", "HTTPS"],
      ["api-erp", "orders-api", "erp", "REST"],
      ["erp-db", "erp", "inventory-db", "SQL"],
      ["erp-bus", "erp", "event-bus", "events"],
      ["bus-warehouse", "event-bus", "warehouse", "events"],
      ["warehouse-carrier", "warehouse", "carrier", "EDI"]
    ].map(([id, from, to, protocol]) => ({
      id: id!, from: from!, to: to!, kind: "depends_on" as const,
      state: "current" as const, scope: "current" as const,
      certainty: "asserted" as const, confidence: 1,
      facets: { architecture: { kind: "connection" as const, protocol } }, evidenceUtteranceIds: evidence
    }))
  ],
  pains: [{
    id: "manual-validation",
    description: "Validation adds six to twelve hours before allocation.",
    targetNodeIds: ["validate"],
    severity: "high",
    state: "current",
    scope: "current",
    certainty: "asserted",
    evidenceUtteranceIds: evidence
  }],
  contradictions: [{
    id: "inventory-timing",
    description: "The ERP and warehouse disagree about when stock becomes reserved.",
    evidenceUtteranceIds: evidence
  }],
  suggestedQuestion: {
    text: "Which validation decision is safest to automate first?",
    evidenceUtteranceIds: evidence
  }
};

const runtime = createScoutRuntime(config, { analyzer: new FixtureAnalyzer() });
const session = runtime.store.create(
  "https://meet.example.invalid/veyra",
  "session-post-call-browser"
);
runtime.store.upsertParticipant(session.id, { id: "scout", name: "Scout facilitator" });
runtime.store.upsertParticipant(session.id, { id: "customer", name: "Morgan Chen" });
runtime.store.selectOperator(session.id, "scout");
runtime.store.appendUtterance(session.id, {
  id: "utt-1",
  sequence: 1,
  participantId: "customer",
  participantName: "Morgan Chen",
  text: "Orders are validated manually before stock allocation, and the ERP and warehouse disagree about when stock is reserved.",
  startedAt: 1,
  endedAt: 8,
  finalized: true
});
runtime.store.acceptGraph(session.id, graph);
runtime.store.setStatus(session.id, "ended");

const server = runtime.app.listen(config.port, config.host, () => {
  console.log(`Post-call fixture ready at http://${config.host}:${config.port}/operator/${session.id}`);
});

const close = async () => {
  await runtime.close();
  server.close(() => process.exit(0));
};
process.once("SIGINT", close);
process.once("SIGTERM", close);
