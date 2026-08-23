#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { AuditLog } from "./audit-log.mjs";
import { AutonomyPolicy } from "./autonomy.mjs";
import { buildMorningBrief, recordMorningBriefPublication } from "./briefing.mjs";
import { loadConfig, projectRoot } from "./config.mjs";
import { EventBus } from "./event-bus.mjs";
import { runHeartbeat } from "./health.mjs";
import { aggregateMetrics } from "./metrics.mjs";
import { ProjectStateStore } from "./project-state.mjs";
import { evaluateCriteria } from "./sentinel.mjs";
import { atomicWriteJson, ensureDir, readJson } from "./utils.mjs";

const args = process.argv.slice(2);
const command = args[0] ?? "help";
const option = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : null; };
const config = await loadConfig(option("--config") ? resolve(option("--config")) : undefined);
const audit = new AuditLog(config.data_dir);
const eventBus = new EventBus(config.data_dir, config.event_bus, audit);
const stateStore = new ProjectStateStore(config.data_dir, audit);
const policy = new AutonomyPolicy(config.autonomy, audit, eventBus);

async function init() {
  await audit.init(); await eventBus.init();
  await ensureDir(resolve(config.data_dir, "logs"));
  await eventBus.recoverUndispatched();
  const seed = await readJson(resolve(projectRoot, "config/project-state.seed.json"));
  await stateStore.init(seed);
  await atomicWriteJson(resolve(config.data_dir, "runtime.json"), { phase: config.phase, max_autonomy: config.autonomy.max_level, channel: config.channel, initialized_at: new Date().toISOString() });
  return { status: "initialized", data_dir: config.data_dir, phase: config.phase, max_autonomy: config.autonomy.max_level };
}

let output;
if (command === "init") output = await init();
else if (command === "heartbeat") { await init(); output = await policy.run("system.inspect", { agent: "Fizz", input_source: "launchd" }, async () => runHeartbeat({ dataDir: config.data_dir, config: config.health, eventBus, audit })); }
else if (command === "publish") {
  await init();
  const file = option("--file");
  const raw = file ? await readFile(resolve(file), "utf8") : option("--json");
  if (!raw) throw new Error("publish requires --json or --file");
  output = await eventBus.publish(JSON.parse(raw));
} else if (command === "recover") { await init(); output = { recovered: await eventBus.recoverUndispatched() };
} else if (command === "brief") { await init(); output = await buildMorningBrief({ dataDir: config.data_dir, audit, stateStore, config }); }
else if (command === "brief-record-publication") {
  await init();
  const date = option("--date"); const contentHash = option("--content-hash"); const status = option("--status");
  if (!date || !contentHash || !["success", "failure"].includes(status)) throw new Error("brief-record-publication requires --date, --content-hash and --status success|failure");
  output = await recordMorningBriefPublication({ dataDir: config.data_dir, audit, config, date, contentHash, status, eventId: option("--event-id"), errorCode: option("--error-code") });
}
else if (command === "state-update") {
  await init();
  const project = option("--project"); const raw = option("--json");
  if (!project || !raw) throw new Error("state-update requires --project and --json");
  output = await policy.run("proposal.create", { agent: "Honey", input_source: project }, async () => stateStore.update(project, JSON.parse(raw), { reason: option("--reason") ?? "meaningful_state_change", agent: "Honey" }));
}
else if (command === "metrics") { output = aggregateMetrics(await audit.rows(), config.model_classification); await atomicWriteJson(resolve(config.data_dir, "metrics", "latest.json"), output); }
else if (command === "validate") {
  const criteria = [
    { criterion: "Audit chain is complete", status: (await audit.verify()).valid ? "PASS" : "FAIL", evidence: JSON.stringify(await audit.verify()) },
    { criterion: "Phase 1 denies A2", status: policy.decide("service.restart.approved").allowed ? "FAIL" : "PASS", evidence: JSON.stringify(policy.decide("service.restart.approved")) },
    { criterion: "A4 remains prohibited", status: policy.decide("credential.disclose", { approved: true }).disposition === "PROHIBITED" ? "PASS" : "FAIL", evidence: JSON.stringify(policy.decide("credential.disclose", { approved: true })) },
  ];
  output = evaluateCriteria(criteria);
} else {
  output = { usage: "node src/cli.mjs <init|heartbeat|publish|recover|brief|brief-record-publication|state-update|metrics|validate> [--config path]" };
}
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
