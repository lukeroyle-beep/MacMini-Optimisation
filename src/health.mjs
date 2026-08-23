import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { atomicWriteJson, nowIso, readJson, redactSecrets, sha256, stableStringify } from "./utils.mjs";

const execFileAsync = promisify(execFile);
const terminal = new Set(["OK", "WARN", "FAIL", "UNKNOWN"]);

export async function runCommand(file, args = [], timeout = 12000) {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, { timeout, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" });
    return { ok: true, stdout, stderr, code: 0 };
  } catch (error) {
    return { ok: false, stdout: error.stdout ?? "", stderr: error.stderr ?? "", code: error.code ?? null, error: error.message };
  }
}

export async function fetchProbe(url, { timeoutMs = 5000, fetchImpl = fetch } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { method: "GET", redirect: "manual", signal: controller.signal, headers: { Accept: "application/json" } });
    return { reachable: true, status: response.status, ok: response.ok || [401, 403].includes(response.status) };
  } catch (error) { return { reachable: false, status: null, ok: false, error: error.name === "AbortError" ? "timeout" : error.message }; }
  finally { clearTimeout(timer); }
}

function result(check, status, summary, metrics = {}, observedAt = nowIso()) {
  if (!terminal.has(status)) throw new Error(`invalid health status: ${status}`);
  return { check, status, summary, metrics: redactSecrets(metrics), observed_at: observedAt };
}

export async function collectHealth(config, { runner = runCommand, fetchImpl = fetch } = {}) {
  const checks = [];
  const timeout = config.command_timeout_ms ?? 12000;
  if (config.base_health_file) {
    const base = await readJson(config.base_health_file, null);
    const baseAge = base?.generatedAt ? Date.now() - Date.parse(base.generatedAt) : Infinity;
    if (base?.checks && Array.isArray(base.checks) && baseAge <= (config.base_health_stale_after_ms ?? 1800000)) {
      checks.push(...base.checks.map((check) => result(`base:${check.name}`, check.ok ? "OK" : check.severity === "critical" ? "FAIL" : "WARN", check.detail, { source: "ai.macmini-health", generated_at: base.generatedAt }, base.generatedAt)));
    } else checks.push(result("base:macmini-health", "UNKNOWN", "existing health snapshot unavailable or malformed"));
  }
  const openclaw = await runner("/opt/homebrew/bin/openclaw", ["status", "--json"], timeout);
  if (openclaw.ok) {
    try {
      const parsed = JSON.parse(openclaw.stdout);
      const active = parsed.tasks?.active ?? 0;
      const failures = parsed.tasks?.failures ?? 0;
      const auditErrors = parsed.taskAudit?.errors ?? 0;
      checks.push(result("openclaw-tasks", auditErrors ? "FAIL" : "OK", auditErrors ? `${auditErrors} task integrity error(s)` : `${active} active task(s), ${failures} historical failure(s); no current integrity fault`, { active_tasks: active, historical_failures: failures, task_audit_errors: auditErrors }));
    } catch (error) { checks.push(result("openclaw-tasks", "UNKNOWN", "OpenClaw returned malformed status", { error: error.message })); }
  } else checks.push(result("openclaw-tasks", "FAIL", "OpenClaw status unavailable", { error: openclaw.error ?? openclaw.stderr }));

  for (const service of config.services ?? []) {
    const probe = await runner("/usr/bin/pgrep", ["-fl", service.pattern], timeout);
    checks.push(result(`process:${service.name}`, probe.ok && probe.stdout.trim() ? "OK" : "FAIL", probe.ok && probe.stdout.trim() ? "process present" : "process not found"));
  }

  for (const endpoint of config.network_endpoints ?? []) {
    const probe = await fetchProbe(endpoint.url, { timeoutMs: Math.min(timeout, 5000), fetchImpl });
    const idle = !probe.reachable && endpoint.idle_ok === true;
    checks.push(result(`endpoint:${endpoint.name}`, probe.ok || idle ? "OK" : probe.reachable ? "WARN" : "FAIL", probe.ok ? `HTTP ${probe.status}` : idle ? "dormant; starts on demand" : probe.reachable ? `reachable, HTTP ${probe.status}` : "unreachable", { http_status: probe.status, local: endpoint.local === true, idle_ok: endpoint.idle_ok === true, error: idle ? null : (probe.error ?? null) }));
  }

  const homeAssistant = config.home_assistant_url ? await fetchProbe(config.home_assistant_url, { timeoutMs: Math.min(timeout, 5000), fetchImpl }) : null;
  checks.push(homeAssistant ? result("home-assistant", homeAssistant.ok ? "OK" : homeAssistant.reachable ? "WARN" : "FAIL", homeAssistant.ok ? `reachable, HTTP ${homeAssistant.status}` : homeAssistant.reachable ? `reachable, HTTP ${homeAssistant.status}` : "unreachable", { http_status: homeAssistant.status, error: homeAssistant.error ?? null }) : result("home-assistant", "UNKNOWN", "not configured"));

  const tailscale = await runner("/usr/local/bin/tailscale", ["status", "--json"], timeout);
  if (tailscale.ok) {
    try { const parsed = JSON.parse(tailscale.stdout); checks.push(result("tailscale", ["Running", "NeedsLogin"].includes(parsed.BackendState) ? (parsed.BackendState === "Running" ? "OK" : "WARN") : "FAIL", parsed.BackendState ?? "unknown", { backend_state: parsed.BackendState ?? null, peer_count: Object.keys(parsed.Peer ?? {}).length })); }
    catch (error) { checks.push(result("tailscale", "UNKNOWN", "malformed status", { error: error.message })); }
  } else checks.push(result("tailscale", "FAIL", "status unavailable", { error: tailscale.error ?? tailscale.stderr }));

  const disk = await runner("/bin/df", ["-Pk", "/"], timeout);
  if (disk.ok) {
    const line = disk.stdout.trim().split(/\r?\n/).at(-1) ?? "";
    const columns = line.trim().split(/\s+/);
    const percent = Number((columns[4] ?? "").replace("%", ""));
    checks.push(result("disk", Number.isFinite(percent) ? (percent >= 95 ? "FAIL" : percent >= 85 ? "WARN" : "OK") : "UNKNOWN", Number.isFinite(percent) ? `${percent}% used` : "unable to parse", { used_percent: Number.isFinite(percent) ? percent : null }));
  } else checks.push(result("disk", "UNKNOWN", "df unavailable", { error: disk.error ?? disk.stderr }));

  const pressure = await runner("/usr/bin/memory_pressure", ["-Q"], timeout);
  const match = pressure.stdout?.match(/System-wide memory free percentage:\s*(\d+)%/i);
  const free = match ? Number(match[1]) : null;
  checks.push(result("memory", free == null ? "UNKNOWN" : free <= 5 ? "FAIL" : free <= 15 ? "WARN" : "OK", free == null ? "unable to parse memory pressure" : `${free}% free`, { free_percent: free }));

  const load = await runner("/usr/sbin/sysctl", ["-n", "vm.loadavg"], timeout);
  const loadNumbers = load.stdout?.match(/[0-9.]+/g)?.map(Number) ?? [];
  checks.push(result("cpu-load", load.ok && loadNumbers.length ? "OK" : "UNKNOWN", loadNumbers.length ? `load averages ${loadNumbers.slice(0, 3).join(", ")}` : "unavailable", { load_1m: loadNumbers[0] ?? null, load_5m: loadNumbers[1] ?? null, load_15m: loadNumbers[2] ?? null }));

  for (const repository of config.repositories ?? []) {
    const git = await runner("/usr/bin/git", ["-C", repository, "status", "--porcelain=v1", "--branch"], timeout);
    checks.push(result(`git:${repository}`, git.ok ? "OK" : "UNKNOWN", git.ok ? "repository readable" : "not a readable Git repository", { dirty_entries: git.ok ? Math.max(0, git.stdout.trim().split(/\r?\n/).filter(Boolean).length - 1) : null }));
  }
  return { observed_at: nowIso(), checks };
}

export async function runHeartbeat({ dataDir, config, eventBus, audit, runner = runCommand, fetchImpl = fetch }) {
  const started = Date.now();
  const path = join(dataDir, "health", "latest.json");
  const previous = await readJson(path, { checks: [] });
  const snapshot = await collectHealth(config, { runner, fetchImpl });
  snapshot.fingerprint = sha256(stableStringify(snapshot.checks.map(({ observed_at, ...check }) => check)));
  await atomicWriteJson(path, snapshot);
  const previousByCheck = new Map(previous.checks.map((check) => [check.check, check]));
  const events = [];
  for (const check of snapshot.checks) {
    const prior = previousByCheck.get(check.check);
    const priorAbnormal = prior && prior.status !== "OK";
    const abnormal = check.status !== "OK";
    if (abnormal && (!priorAbnormal || prior.status !== check.status || prior.summary !== check.summary)) {
      events.push(await eventBus.publish({
        event_id: `health:${sha256(`${check.check}:${check.status}:${check.summary}:${check.observed_at}`).slice(0, 32)}`,
        type: check.status === "FAIL" ? "service.failure" : "system.warning", source: "fizz-heartbeat",
        severity: check.status === "FAIL" ? "high" : check.status === "WARN" ? "medium" : "low",
        timestamp: check.observed_at, resource: check.check, payload: { status: check.status, summary: check.summary, metrics: check.metrics },
      }));
    } else if (!abnormal && priorAbnormal) {
      events.push(await eventBus.publish({ event_id: `recovery:${sha256(`${check.check}:${check.observed_at}`).slice(0, 32)}`, type: "service.recovered", source: "fizz-heartbeat", severity: "info", timestamp: check.observed_at, resource: check.check, payload: { previous_status: prior.status, status: "OK" } }));
    }
  }
  await audit.append({ agent: "Fizz", routing_reason: "deterministic_no_model", input_source: "scheduled_health", action: "system.inspect", autonomy_level: "A0", result: { checks: snapshot.checks.length, abnormal: snapshot.checks.filter((check) => check.status !== "OK").length, transition_events: events.filter((event) => event.status === "accepted").length }, execution_duration_ms: Date.now() - started, errors: [] });
  return { snapshot, events };
}
