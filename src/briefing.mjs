import { join } from "node:path";
import { atomicWrite, readJson, sha256 } from "./utils.mjs";
import { aggregateMetrics } from "./metrics.mjs";

const sectionOrder = ["SYSTEMS", "AUTOMATIC RECOVERIES", "COMPLETED WORK", "SOFTWARE", "RESEARCH / INTELLIGENCE", "VALIDATION ISSUES", "RISKS", "DECISIONS REQUIRED", "TODAY"];

function bullet(values, empty = "Nothing meaningful to report.") { return values.length ? values.map((value) => `- ${value}`).join("\n") : `- ${empty}`; }

function partsAt(timestamp, timeZone) {
  return Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(timestamp)).filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
}

function zonedDateTimeToUtc(date, hour, minute, timeZone) {
  const [year, month, day] = date.split("-").map(Number);
  const desired = Date.UTC(year, month - 1, day, hour, minute, 0);
  let guess = desired;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const observed = partsAt(guess, timeZone);
    const observedAsUtc = Date.UTC(observed.year, observed.month - 1, observed.day, observed.hour, observed.minute, observed.second);
    const delta = desired - observedAsUtc;
    guess += delta;
    if (delta === 0) break;
  }
  return guess;
}

function addLocalDays(date, days) {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

export function reportingWindow({ date, timeZone = "Europe/London", hour = 7, minute = 15, lookbackHours = 24 }) {
  const end = zonedDateTimeToUtc(date, hour, minute, timeZone);
  const wholeDays = lookbackHours / 24;
  const start = Number.isInteger(wholeDays)
    ? zonedDateTimeToUtc(addLocalDays(date, -wholeDays), hour, minute, timeZone)
    : end - lookbackHours * 3600000;
  return { start, end, start_iso: new Date(start).toISOString(), end_iso: new Date(end).toISOString(), time_zone: timeZone };
}

export function renderMorningBrief({ date, health, audits, projectStates, modelClassification, staleAfterMs = 900000, now = Date.now(), timeZone = "Europe/London", briefHour = 7, briefMinute = 15, lookbackHours = 24 }) {
  const window = reportingWindow({ date, timeZone, hour: briefHour, minute: briefMinute, lookbackHours });
  const windowedAudits = audits.filter((row) => {
    const timestamp = Date.parse(row.timestamp);
    return Number.isFinite(timestamp) && timestamp >= window.start && timestamp < window.end;
  });
  const metrics = aggregateMetrics(windowedAudits, modelClassification);
  const healthAge = health?.observed_at ? now - Date.parse(health.observed_at) : Infinity;
  const healthChecks = healthAge <= staleAfterMs ? health.checks ?? [] : [];
  const systems = healthChecks.length ? healthChecks.filter((check) => check.status !== "OK").map((check) => `${check.check}: ${check.status} — ${check.summary}`) : ["Health telemetry is UNKNOWN or stale."];
  if (healthChecks.length && systems.length === 0) systems.push(`${healthChecks.length} deterministic checks are current; no exception is open.`);
  const recoveries = windowedAudits.filter((row) => row.action === "service.recovery" && (row.sentinel_status === "PASS" || row?.result?.status === "success")).map((row) => `${row.input_source ?? "service"}: recovered and validated`);
  const completed = windowedAudits.filter((row) => row?.result?.objective_completed === true).map((row) => row?.result?.summary ?? row.action);
  const software = healthChecks.filter((check) => check.check.startsWith("git:") && check.status !== "OK").map((check) => `${check.check}: ${check.summary}`);
  const research = windowedAudits.filter((row) => row.action === "research.discovery" && row?.result?.material === true).map((row) => row.result.summary);
  const validation = windowedAudits.filter((row) => ["FAIL", "ESCALATE"].includes(row.sentinel_status)).map((row) => `${row.task_id ?? row.action}: ${row.sentinel_status}`);
  const risks = [...new Set(projectStates.flatMap((state) => state?.risks ?? []))];
  const decisions = windowedAudits.filter((row) => row.escalation === "Codex" || row.action === "approval.required").map((row) => row?.result?.summary ?? row.action);
  const today = [...new Set(projectStates.flatMap((state) => state?.next_actions ?? []))].slice(0, 8);
  const sections = { "SYSTEMS": systems, "AUTOMATIC RECOVERIES": recoveries, "COMPLETED WORK": completed, "SOFTWARE": software, "RESEARCH / INTELLIGENCE": research, "VALIDATION ISSUES": validation, "RISKS": risks, "DECISIONS REQUIRED": decisions, "TODAY": today };
  const meaningful = [...recoveries, ...completed, ...software, ...research, ...validation, ...risks, ...decisions].length > 0 || healthChecks.some((check) => check.status !== "OK");
  const header = `# MACMINI / BUZZ MORNING BRIEF\n\nDate: ${date}\nWindow: ${window.start_iso} to ${window.end_iso} (${window.time_zone})\nHuman interventions per completed objective: ${metrics.human_interventions_per_completed_objective ?? "n/a"}`;
  if (!meaningful) return `${header}\n\nSYSTEMS\n\n${bullet(systems)}\n\nTODAY\n\n${bullet(today, "Continue observation; no decision is required.")}\n`;
  return `${header}\n\n${sectionOrder.map((section) => `${section}\n\n${bullet(sections[section])}`).join("\n\n")}\n`;
}

export async function buildMorningBrief({ dataDir, audit, stateStore, config, date = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" }) }) {
  const health = await readJson(join(dataDir, "health", "latest.json"), null);
  const rows = await audit.rows();
  const projects = await stateStore.list();
  const projectStates = (await Promise.all(projects.map((project) => stateStore.get(project)))).filter(Boolean);
  const content = renderMorningBrief({ date, health, audits: rows, projectStates, modelClassification: config.model_classification, staleAfterMs: config.health.stale_after_ms, timeZone: "Europe/London", briefHour: config.briefing.hour, briefMinute: config.briefing.minute, lookbackHours: config.briefing.lookback_hours });
  const path = join(dataDir, "briefs", `${date}.md`);
  const prior = await readJson(join(dataDir, "briefs", `${date}.json`), null);
  const contentHash = sha256(content);
  if (prior?.content_hash !== contentHash) {
    await atomicWrite(path, content);
    await atomicWrite(join(dataDir, "briefs", `${date}.json`), `${JSON.stringify({ idempotency_key: `morning-brief:${config.channel.id}:${date}`, content_hash: contentHash, channel_id: config.channel.id, published: false }, null, 2)}\n`);
  }
  await audit.append({ agent: "Honey", routing_reason: "deterministic_no_model", input_source: "audit+health+project-state", action: "morning_brief.prepare", autonomy_level: "A1", result: { status: prior?.content_hash === contentHash ? "unchanged" : "prepared", path, content_hash: contentHash, published: false }, errors: [] });
  return { path, content, content_hash: contentHash, idempotency_key: `morning-brief:${config.channel.id}:${date}`, published: false };
}
