import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AUDIT_REQUIRED_FIELDS, AuditLog } from "../src/audit-log.mjs";
import { AutonomyPolicy } from "../src/autonomy.mjs";
import { recordMorningBriefPublication, renderMorningBrief, reportingWindow } from "../src/briefing.mjs";
import { DeliveryStore } from "../src/deliveries.mjs";
import { EventBus } from "../src/event-bus.mjs";
import { collectHealth, fetchProbe, runHeartbeat } from "../src/health.mjs";
import { IncidentStore, INCIDENT_FIELDS } from "../src/incidents.mjs";
import { aggregateMetrics } from "../src/metrics.mjs";
import { ModelRouter } from "../src/model-router.mjs";
import { ProjectStateStore, PROJECT_STATE_FIELDS } from "../src/project-state.mjs";
import { normalizeSentinelOutcome, routeSentinelOutcome, validateSentinelResult } from "../src/sentinel.mjs";
import { sha256 } from "../src/utils.mjs";

const routes = {
  "service.failure": ["Fizz"], "service.recovered": ["Fizz"], "repeated.failure": ["Rook"],
  "test.failure": ["Forge"], "pull_request.ready": ["Sentinel"], "research.discovery": ["Bumble"],
  "strategic.change": ["Nova"], "approval.required": ["Codex"], "system.warning": ["Fizz"],
};

const busConfig = (overrides = {}) => ({ schema_version: 1, max_payload_bytes: 262144, max_payload_depth: 32, max_hops: 8, max_correlation_dispatches: 32, routes, ...overrides });
const validEvent = (overrides = {}) => ({ event_id: "evt_fixture_0001", type: "service.failure", source: "home-assistant", severity: "medium", timestamp: "2026-08-23T07:00:00.000Z", resource: "ha", payload: { code: "DOWN" }, ...overrides });

async function temp() { return mkdtemp(join(tmpdir(), "buzz-phase1-")); }

test("canonical routes dispatch to the required agents", async (t) => {
  const root = await temp(); t.after(() => rm(root, { recursive: true, force: true }));
  const bus = new EventBus(root, busConfig());
  for (const [index, [type, targets]] of Object.entries(routes).entries()) {
    const published = await bus.publish(validEvent({ event_id: `evt_route_${String(index).padStart(4, "0")}`, type, timestamp: `2026-08-23T07:${String(index).padStart(2, "0")}:00.000Z` }));
    assert.equal(published.status, "accepted");
    assert.deepEqual(published.routes.map((route) => route.assigned_agent), targets);
  }
});

test("duplicate replay dispatches once and survives a bus restart", async (t) => {
  const root = await temp(); t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal((await new EventBus(root, busConfig()).publish(validEvent())).routes.length, 1);
  const replay = await new EventBus(root, busConfig()).publish(validEvent());
  assert.equal(replay.status, "duplicate"); assert.equal(replay.routes.length, 0);
});

test("twenty concurrent copies produce exactly one dispatch", async (t) => {
  const root = await temp(); t.after(() => rm(root, { recursive: true, force: true }));
  const bus = new EventBus(root, busConfig());
  const results = await Promise.all(Array.from({ length: 20 }, () => bus.publish(validEvent())));
  assert.equal(results.flatMap((item) => item.routes).length, 1);
});

test("same event id with changed content is quarantined", async (t) => {
  const root = await temp(); t.after(() => rm(root, { recursive: true, force: true }));
  const bus = new EventBus(root, busConfig()); await bus.publish(validEvent());
  const result = await bus.publish(validEvent({ payload: { code: "DIFFERENT" } }));
  assert.equal(result.status, "quarantined"); assert.equal(result.reason, "event_id_conflict");
});

test("correlation and causation identifiers cannot escape the route store", async (t) => {
  const root = await temp(); t.after(() => rm(root, { recursive: true, force: true }));
  const bus = new EventBus(root, busConfig());
  const malicious = await bus.publish(validEvent({ event_id: "evt_path_0001", correlation_id: "../../escaped-correlation" }));
  assert.equal(malicious.status, "quarantined"); assert.equal((await readdir(join(root, "events", "routes"))).length, 0);
  const badCause = await bus.publish(validEvent({ event_id: "evt_path_0002", causation_id: "../cause" })); assert.equal(badCause.status, "quarantined");
});

test("quarantine and accepted events never persist secret-like material", async (t) => {
  const root = await temp(); t.after(() => rm(root, { recursive: true, force: true }));
  const bus = new EventBus(root, busConfig());
  const secret = await bus.publish(validEvent({ event_id: "evt_secret_0001", payload: { api_key: "sentinel-secret-probe" } }));
  assert.equal(secret.status, "quarantined");
  const serialized = await readFile(secret.path, "utf8"); assert.ok(!serialized.includes("sentinel-secret-probe")); assert.match(serialized, /redacted/);
});

test("malformed, unknown, oversized, deep, prototype-polluted and invalid-time events quarantine without routing", async (t) => {
  const root = await temp(); t.after(() => rm(root, { recursive: true, force: true }));
  const bus = new EventBus(root, busConfig({ max_payload_bytes: 20, max_payload_depth: 2 }));
  let deep = { value: true }; deep = { a: { b: deep } };
  const cases = [null, [], { ...validEvent(), type: "unknown.event" }, { ...validEvent(), severity: "bogus" }, { ...validEvent(), timestamp: "not-a-time" }, { ...validEvent(), payload: [] }, { ...validEvent(), payload: { text: "x".repeat(50) } }, { ...validEvent(), payload: deep }, { ...validEvent(), payload: JSON.parse('{"__proto__":{"x":1}}') }];
  for (const [index, candidate] of cases.entries()) {
    const result = await bus.publish(candidate && !Array.isArray(candidate) ? { ...candidate, event_id: `evt_bad_${String(index).padStart(4, "0")}` } : candidate);
    assert.equal(result.status, "quarantined"); assert.equal(result.routes.length, 0);
  }
});

test("hop and path guards stop recursive routing", async (t) => {
  const root = await temp(); t.after(() => rm(root, { recursive: true, force: true }));
  const bus = new EventBus(root, busConfig());
  assert.equal((await bus.publish(validEvent({ event_id: "evt_depth_0001", hop_count: 8 }))).reason, "max_hops");
  assert.equal((await bus.publish(validEvent({ event_id: "evt_loop_0001", path: ["Fizz"] }))).routes.length, 0);
});

test("correlation dispatch limit is enforced", async (t) => {
  const root = await temp(); t.after(() => rm(root, { recursive: true, force: true }));
  const bus = new EventBus(root, busConfig({ max_correlation_dispatches: 2 }));
  const results = [];
  for (let index = 0; index < 3; index += 1) results.push(await bus.publish(validEvent({ event_id: `evt_corr_${index}0000`, correlation_id: "corr_limit", timestamp: `2026-08-23T07:0${index}:00.000Z` })));
  assert.equal(results.flatMap((item) => item.routes).length, 2);
});

test("restart recovery recreates a missing durable delivery", async (t) => {
  const root = await temp(); t.after(() => rm(root, { recursive: true, force: true }));
  const bus = new EventBus(root, busConfig()); const published = await bus.publish(validEvent());
  await unlink(join(root, "events", "routes", sha256(published.event.correlation_id), `${published.routes[0].task_id}.json`));
  const recovered = await new EventBus(root, busConfig()).recoverUndispatched();
  assert.equal(recovered.length, 1); assert.equal(recovered[0].recovered_after_restart, true);
});

const autonomyConfig = { max_level: "A1", capabilities: { "system.inspect": "A0", "proposal.create": "A1", "service.restart": "A2", "production.deploy": "A3", "credential.disclose": "A4" } };

test("autonomy registry classifies actions, not agents", async () => {
  const policy = new AutonomyPolicy(autonomyConfig); let calls = 0;
  assert.equal((await policy.run("system.inspect", { agent: "Fizz" }, async () => { calls += 1; return "ok"; })).allowed, true);
  assert.equal((await policy.run("service.restart", { agent: "Fizz" }, async () => { calls += 1; })).allowed, false);
  assert.equal(calls, 1);
});

test("A1 is prepare-only, Phase 1 denies A2, A3 never invokes, and A4 remains prohibited despite approval", async () => {
  const policy = new AutonomyPolicy(autonomyConfig); let calls = 0;
  assert.equal(policy.decide("proposal.create").disposition, "PREPARE_ONLY");
  assert.equal(policy.decide("service.restart").reason, "phase_gate_A1");
  assert.equal((await policy.run("production.deploy", { approved: true }, async () => { calls += 1; })).disposition, "APPROVAL_REQUIRED");
  assert.equal((await policy.run("credential.disclose", { approved: true }, async () => { calls += 1; })).disposition, "PROHIBITED");
  assert.equal(policy.decide("unknown.action").reason, "unknown_capability"); assert.equal(calls, 0);
});

test("A3 creates a pending approval event routed to Codex without invoking an executor", async () => {
  const published = []; const eventBus = { publish: async (event) => { published.push(event); return { status: "accepted" }; } };
  const policy = new AutonomyPolicy(autonomyConfig, null, eventBus); let calls = 0;
  const result = await policy.run("production.deploy", { agent: "Forge", task_id: "T-1" }, async () => { calls += 1; });
  assert.equal(result.disposition, "APPROVAL_REQUIRED"); assert.equal(calls, 0); assert.equal(published[0].type, "approval.required"); assert.equal(published[0].payload.task_id, "T-1");
});

test("audit rows are complete, hash chained and secret redacted", async (t) => {
  const root = await temp(); t.after(() => rm(root, { recursive: true, force: true }));
  const audit = new AuditLog(root);
  const row = await audit.append({ action: "probe", input_source: { api_key: "do-not-log", header: "Bearer abcdefghijklmnop" }, result: "completed" });
  for (const field of AUDIT_REQUIRED_FIELDS) assert.ok(field in row);
  const serialized = JSON.stringify(row); assert.ok(!serialized.includes("do-not-log")); assert.ok(!serialized.includes("abcdefghijklmnop"));
  assert.equal((await audit.verify()).valid, true);
});

test("audit tampering fails integrity verification", async (t) => {
  const root = await temp(); t.after(() => rm(root, { recursive: true, force: true }));
  const audit = new AuditLog(root); await audit.append({ action: "one" }); await audit.append({ action: "two" });
  const lines = (await readFile(audit.path, "utf8")).trim().split("\n"); const changed = JSON.parse(lines[0]); changed.action = "tampered"; lines[0] = JSON.stringify(changed); await writeFile(audit.path, `${lines.join("\n")}\n`);
  assert.equal((await audit.verify()).valid, false);
});

test("Sentinel maps legacy outcomes to the canonical contract", () => {
  assert.deepEqual(["PASS", "PASS_WITH_NOTES", "REWORK", "ESCALATE"].map(normalizeSentinelOutcome), ["PASS", "PASS_WITH_WARNINGS", "FAIL", "ESCALATE"]);
});

test("Sentinel fails safely on malformed or unsupported pass and routes FAIL back without user notification", () => {
  assert.equal(validateSentinelResult("bad").status, "ESCALATE");
  const passedWithoutEvidence = validateSentinelResult({ status: "PASS", criteria: [{ criterion: "x", status: "PASS", evidence: "x" }] }, { requiredEvidence: false });
  assert.equal(passedWithoutEvidence.status, "ESCALATE");
  assert.deepEqual(routeSentinelOutcome({ status: "FAIL" }, "Forge"), { action: "rework", target: "Forge", oversight: "Rook", notify_user: false });
  assert.equal(routeSentinelOutcome({ status: "FAIL" }, "Bumble").oversight, "Nova");
});

test("delivery retries are bounded, durable and dead-letter to Rook", async (t) => {
  const root = await temp(); t.after(() => rm(root, { recursive: true, force: true }));
  const audit = new AuditLog(root); const bus = new EventBus(root, busConfig(), audit); const published = await bus.publish(validEvent());
  const store = new DeliveryStore(root, bus, audit);
  for (let attempt = 1; attempt <= 3; attempt += 1) { await store.claim(published.routes[0].task_id, "worker"); const failed = await store.fail(published.routes[0].task_id, new Error("temporary")); assert.equal(failed.status, attempt < 3 ? "queued" : "dead_letter"); }
  const rookTasks = (await store.list()).filter((task) => task.assigned_agent === "Rook"); assert.equal(rookTasks.length, 1);
});

test("expired delivery lease is reclaimed once after restart and completed work is not", async (t) => {
  const root = await temp(); t.after(() => rm(root, { recursive: true, force: true }));
  const bus = new EventBus(root, busConfig()); const published = await bus.publish(validEvent()); const store = new DeliveryStore(root, bus, null, { leaseMs: 10 });
  await store.claim(published.routes[0].task_id, "worker", 1000);
  assert.equal((await store.recoverExpired(1011)).length, 1);
  assert.equal((await store.recoverExpired(1011)).length, 0);
  await store.complete(published.routes[0].task_id, "done", { sentinelStatus: "PASS" });
  assert.equal((await store.recoverExpired(999999)).length, 0);
});

function fakeRunner(file) {
  if (file.endsWith("openclaw")) return Promise.resolve({ ok: true, stdout: JSON.stringify({ tasks: { active: 0, failures: 0 }, taskAudit: { errors: 0 } }), stderr: "", code: 0 });
  if (file.endsWith("tailscale")) return Promise.resolve({ ok: true, stdout: JSON.stringify({ BackendState: "Running", Peer: {} }), stderr: "", code: 0 });
  if (file.endsWith("df")) return Promise.resolve({ ok: true, stdout: "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/x 100 10 90 10% /\n", stderr: "", code: 0 });
  if (file.endsWith("memory_pressure")) return Promise.resolve({ ok: true, stdout: "System-wide memory free percentage: 63%\n", stderr: "", code: 0 });
  if (file.endsWith("sysctl")) return Promise.resolve({ ok: true, stdout: "{ 0.5 0.4 0.3 }\n", stderr: "", code: 0 });
  if (file.endsWith("pgrep")) return Promise.resolve({ ok: true, stdout: "1 buzz-desktop\n", stderr: "", code: 0 });
  if (file.endsWith("git")) return Promise.resolve({ ok: true, stdout: "## main\n", stderr: "", code: 0 });
  return Promise.resolve({ ok: false, stdout: "", stderr: "not found", code: 1, error: "not found" });
}

const healthConfig = { command_timeout_ms: 10, services: [], network_endpoints: [], home_assistant_url: null, repositories: [] };

test("all-normal deterministic health collection uses no model and returns silently", async () => {
  let fetchCalls = 0; const health = await collectHealth(healthConfig, { runner: fakeRunner, fetchImpl: async () => { fetchCalls += 1; } });
  assert.equal(fetchCalls, 0); assert.ok(health.checks.every((check) => ["OK", "UNKNOWN"].includes(check.status)));
});

test("dependency refusal and timeout are captured without crashing other probes", async () => {
  const config = { ...healthConfig, network_endpoints: [{ name: "Ollama", url: "http://local" }] };
  const health = await collectHealth(config, { runner: fakeRunner, fetchImpl: async () => { throw new Error("connection refused"); } });
  assert.equal(health.checks.find((check) => check.check === "endpoint:Ollama").status, "FAIL");
  assert.ok(health.checks.find((check) => check.check === "tailscale"));
  const timeout = await fetchProbe("http://local", { timeoutMs: 1, fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error("abort"), { name: "AbortError" })))) });
  assert.equal(timeout.error, "timeout");
});

test("heartbeat emits only state transitions and records normal snapshots", async (t) => {
  const root = await temp(); t.after(() => rm(root, { recursive: true, force: true }));
  const audit = new AuditLog(root); const bus = new EventBus(root, busConfig(), audit);
  const first = await runHeartbeat({ dataDir: root, config: healthConfig, eventBus: bus, audit, runner: fakeRunner, fetchImpl: async () => { throw new Error("unused"); } });
  const second = await runHeartbeat({ dataDir: root, config: healthConfig, eventBus: bus, audit, runner: fakeRunner, fetchImpl: async () => { throw new Error("unused"); } });
  assert.ok(first.snapshot.checks.length); assert.ok(first.events.length >= 1); assert.equal(second.events.length, 0);
});

test("metrics use null for undefined rates and compute the strategic metric", () => {
  assert.equal(aggregateMetrics([]).human_interventions_per_completed_objective, null);
  const rows = [
    { action: "task", result: { status: "success", objective_completed: true, objective_id: "O1" }, execution_duration_ms: 10, tool_calls: [] },
    { action: "task", result: { status: "success", objective_completed: true, objective_id: "O2" }, execution_duration_ms: 20, tool_calls: [] },
    { action: "human.intervention", human_approval: { approved: true }, result: "completed", execution_duration_ms: 1, tool_calls: [] },
  ];
  assert.equal(aggregateMetrics(rows).human_interventions_per_completed_objective, 0.5);
});

test("model metrics separate local/cloud and do not invent missing cost", () => {
  const rows = [{ selected_model: "qwen3.5:4b", result: { status: "success" }, tool_calls: [] }, { selected_model: "openai/gpt-5.6-sol", result: { status: "success" }, tool_calls: [] }];
  const metrics = aggregateMetrics(rows, { local_patterns: ["qwen"], cloud_patterns: ["openai"] });
  assert.equal(metrics.local_inference_percentage, 0.5); assert.equal(metrics.cloud_escalation_percentage, 0.5); assert.equal(metrics.cloud_inference_cost, null); assert.equal(metrics.cloud_inference_cost_coverage, "unavailable");
});

test("metrics count one distinct terminal outcome per task and report partial cost coverage", () => {
  const rows = [
    { task_id: "T1", timestamp: "2026-08-23T06:00:00Z", result: { status: "accepted" }, tool_calls: [] },
    { task_id: "T1", timestamp: "2026-08-23T06:01:00Z", result: { status: "success" }, selected_model: "openai/a", tool_calls: [] },
    { task_id: "T2", timestamp: "2026-08-23T06:01:00Z", result: { status: "failed", cloud_cost: 0.4 }, selected_model: "openai/b", tool_calls: [] },
  ];
  const metrics = aggregateMetrics(rows, { cloud_patterns: ["openai"] });
  assert.equal(metrics.task_success_rate, 0.5); assert.equal(metrics.cloud_inference_cost, null); assert.equal(metrics.cloud_inference_cost_known_total, 0.4); assert.equal(metrics.cloud_inference_cost_coverage, "partial");
  const oneTask = aggregateMetrics(rows.slice(0, 2), { cloud_patterns: ["openai"] }); assert.equal(oneTask.task_success_rate, 1);
});

test("dry-run model router decouples identity from model without changing production assignments", async () => {
  const config = {
    mode: "dry-run", production_assignments_unchanged: true,
    models: [{ id: "local-small", locality: "local", classes: ["routine"], coding: false, tools: false, context_limit: 1000 }, { id: "cloud-frontier", locality: "cloud", classes: ["routine", "critical"], coding: true, tools: true, context_limit: 10000 }],
    rules: [{ task_class: "routine", prefer: ["local-small", "cloud-frontier"] }, { task_class: "critical", prefer: ["cloud-frontier"] }],
  };
  const router = new ModelRouter(config);
  const fizz = await router.select({ agent: "Fizz", task_class: "routine" }, { "local-small": true, "cloud-frontier": true });
  const honey = await router.select({ agent: "Honey", task_class: "routine" }, { "local-small": true, "cloud-frontier": true });
  assert.equal(fizz.selected_model, honey.selected_model); assert.equal(fizz.execute, false); assert.equal(fizz.production_assignments_changed, false);
});

test("local/cloud unavailability and fallback are explicit and never silently succeed", async () => {
  const config = { mode: "dry-run", production_assignments_unchanged: true, models: [{ id: "local", locality: "local", coding: true, tools: true, context_limit: 1000 }, { id: "cloud", locality: "cloud", coding: true, tools: true, context_limit: 1000 }], rules: [{ task_class: "coding", prefer: ["local", "cloud"] }] };
  const router = new ModelRouter(config);
  assert.equal((await router.select({ task_class: "coding", requires_coding: true }, { local: false, cloud: true })).status, "defer");
  assert.equal((await router.select({ task_class: "coding", requires_coding: true, allow_cloud_fallback: true }, { local: false, cloud: true })).selected_model, "cloud");
  assert.equal((await router.select({ task_class: "coding", requires_coding: true, allow_cloud_fallback: true }, { local: false, cloud: false })).status, "defer");
});

test("morning brief is concise when quiet, deterministic, ordered and marks stale health UNKNOWN", () => {
  const input = { date: "2026-08-23", health: { observed_at: "2020-01-01T00:00:00Z", checks: [{ check: "x", status: "OK", summary: "ok" }] }, audits: [], projectStates: [{ risks: [], next_actions: ["Observe"] }], modelClassification: {}, staleAfterMs: 1000, now: Date.parse("2026-08-23T07:00:00Z") };
  const first = renderMorningBrief(input); const second = renderMorningBrief(input);
  assert.equal(first, second); assert.match(first, /MACMINI \/ BUZZ MORNING BRIEF/); assert.match(first, /UNKNOWN/); assert.ok(first.indexOf("SYSTEMS") < first.indexOf("TODAY")); assert.ok(first.length < 500);
});

test("morning brief includes all required sections when material activity exists", () => {
  const brief = renderMorningBrief({ date: "2026-08-23", health: { observed_at: "2026-08-23T06:59:00Z", checks: [{ check: "disk", status: "FAIL", summary: "full" }] }, audits: [{ action: "approval.required", escalation: "Codex", result: { summary: "Approve X" }, tool_calls: [] }], projectStates: [{ risks: ["Risk X"], next_actions: ["Action X"] }], modelClassification: {}, staleAfterMs: 900000, now: Date.parse("2026-08-23T07:00:00Z") });
  for (const section of ["SYSTEMS", "AUTOMATIC RECOVERIES", "COMPLETED WORK", "SOFTWARE", "RESEARCH / INTELLIGENCE", "VALIDATION ISSUES", "RISKS", "DECISIONS REQUIRED", "TODAY"]) assert.match(brief, new RegExp(section.replace("/", "\\/")));
});

test("morning brief excludes old audit rows and treats current risks as material", () => {
  const brief = renderMorningBrief({
    date: "2026-08-23", health: null,
    audits: [{ timestamp: "2025-01-01T00:00:00Z", action: "old", result: { objective_completed: true, summary: "OLD WORK" }, tool_calls: [] }],
    projectStates: [{ risks: ["Current unresolved risk"], next_actions: [] }], modelClassification: {}, now: Date.parse("2026-08-23T07:00:00Z"), briefHour: 7, briefMinute: 15, lookbackHours: 24,
  });
  assert.ok(!brief.includes("OLD WORK")); assert.match(brief, /RISKS[\s\S]*Current unresolved risk/);
});

test("Europe/London briefing windows remain contiguous across DST", () => {
  const spring = reportingWindow({ date: "2026-03-29", hour: 7, minute: 15, lookbackHours: 24 });
  const autumn = reportingWindow({ date: "2026-10-25", hour: 7, minute: 15, lookbackHours: 24 });
  assert.equal(spring.end - spring.start, 23 * 3600000);
  assert.equal(autumn.end - autumn.start, 25 * 3600000);
});

test("morning brief publication is hash-bound, audited and idempotent", async (t) => {
  const root = await temp(); t.after(() => rm(root, { recursive: true, force: true }));
  const audit = new AuditLog(root); const config = { channel: { id: "private-channel" } };
  const metadata = { idempotency_key: "morning-brief:private-channel:2026-08-23", content_hash: "hash-one", channel_id: "private-channel", published: false };
  await mkdir(join(root, "briefs"), { recursive: true });
  await writeFile(join(root, "briefs", "2026-08-23.json"), JSON.stringify(metadata));
  const published = await recordMorningBriefPublication({ dataDir: root, audit, config, date: "2026-08-23", contentHash: "hash-one", status: "success", eventId: "event-one", now: "2026-08-23T07:15:00.000Z" });
  assert.equal(published.status, "published"); assert.equal(published.published_event_id, "event-one");
  assert.equal((await recordMorningBriefPublication({ dataDir: root, audit, config, date: "2026-08-23", contentHash: "hash-one", status: "success", eventId: "event-one" })).status, "already_published");
  await assert.rejects(() => recordMorningBriefPublication({ dataDir: root, audit, config, date: "2026-08-23", contentHash: "different", status: "success", eventId: "event-two" }), /hash mismatch/);
  const rows = await audit.rows(); assert.equal(rows.length, 1); assert.equal(rows[0].autonomy_level, "A2"); assert.ok(rows[0].approval_id);
});

test("Honey project state writes only meaningful revisions and detects conflicts", async (t) => {
  const root = await temp(); t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ProjectStateStore(root); const seed = Object.fromEntries(PROJECT_STATE_FIELDS.map((field) => [field, ["objective", "current_architecture", "current_status"].includes(field) ? field : []]));
  const first = await store.update("project-one", seed, { force: true, reason: "seed" });
  assert.equal((await store.update("project-one", {}, { reason: "noop" })).status, "no_change");
  await assert.rejects(() => store.update("project-one", { current_status: "changed" }, { expectedRevision: 99 }), /revision conflict/);
  const second = await store.update("project-one", { current_status: "changed" }, { expectedRevision: first.state.revision }); assert.equal(second.state.revision, 2);
});

test("Rook incidents contain the complete structured contract", async (t) => {
  const root = await temp(); t.after(() => rm(root, { recursive: true, force: true }));
  const store = new IncidentStore(root); const incident = await store.create({ incident_id: "INC-1", affected_service: "Buzz", symptoms: ["down"] });
  for (const field of INCIDENT_FIELDS) assert.ok(field in incident);
  assert.equal((await store.update("INC-1", { current_status: "resolved", verification_result: "PASS" })).verification_result, "PASS");
});
