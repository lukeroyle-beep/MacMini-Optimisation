import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteJson, nowIso, readJson, withLock } from "./utils.mjs";

export class DeliveryStore {
  constructor(dataDir, eventBus, audit = null, { maxAttempts = 3, leaseMs = 60000 } = {}) {
    this.root = join(dataDir, "events", "routes");
    this.locks = join(dataDir, "locks");
    this.eventBus = eventBus;
    this.audit = audit;
    this.maxAttempts = maxAttempts;
    this.leaseMs = leaseMs;
  }

  async files() {
    const output = [];
    let correlations = [];
    try { correlations = await readdir(this.root, { withFileTypes: true }); } catch (error) { if (error?.code === "ENOENT") return []; throw error; }
    for (const correlation of correlations.filter((entry) => entry.isDirectory())) {
      const directory = join(this.root, correlation.name);
      for (const name of (await readdir(directory)).filter((entry) => entry.endsWith(".json"))) output.push(join(directory, name));
    }
    return output;
  }

  async list() { return Promise.all((await this.files()).map((path) => readJson(path))); }
  async find(taskId) { const entries = await this.files(); const path = entries.find((entry) => entry.endsWith(`/${taskId}.json`)); return path ? { path, task: await readJson(path) } : null; }

  async mutate(taskId, transform) {
    return withLock(join(this.locks, `delivery-${taskId}.lock`), async () => {
      const found = await this.find(taskId);
      if (!found) throw new Error(`delivery not found: ${taskId}`);
      const next = await transform(found.task);
      await atomicWriteJson(found.path, next);
      return next;
    });
  }

  async claim(taskId, worker, now = Date.now()) {
    return this.mutate(taskId, (task) => {
      const leaseExpired = task.status === "running" && (!task.lease_until || Date.parse(task.lease_until) <= now);
      if (task.status !== "queued" && !leaseExpired) throw new Error(`delivery is not claimable: ${task.status}`);
      if ((task.attempt_count ?? 0) >= (task.max_attempts ?? this.maxAttempts)) throw new Error("delivery retry limit reached");
      return { ...task, status: "running", attempt_count: (task.attempt_count ?? 0) + 1, worker, lease_until: new Date(now + this.leaseMs).toISOString(), updated_at: new Date(now).toISOString(), recovered_expired_lease: leaseExpired || undefined };
    });
  }

  async complete(taskId, result, { sentinelStatus = null } = {}) {
    const task = await this.mutate(taskId, (current) => {
      if (current.status !== "running") throw new Error(`cannot complete ${current.status} delivery`);
      return { ...current, status: "succeeded", result, sentinel_status: sentinelStatus, lease_until: null, completed_at: nowIso(), updated_at: nowIso() };
    });
    if (this.audit) await this.audit.append({ event_id: task.event_id, task_id: task.task_id, agent: task.assigned_agent, routing_reason: "delivery_completed", input_source: task.correlation_id, action: "delivery.complete", autonomy_level: task.autonomy_level, result: { status: "success", value: result, attempts: task.attempt_count }, sentinel_status: sentinelStatus, errors: [] });
    return task;
  }

  async fail(taskId, error, { retryable = true } = {}) {
    const task = await this.mutate(taskId, (current) => {
      if (current.status !== "running") throw new Error(`cannot fail ${current.status} delivery`);
      const exhausted = !retryable || current.attempt_count >= (current.max_attempts ?? this.maxAttempts);
      return { ...current, status: exhausted ? "dead_letter" : "queued", lease_until: null, last_error: String(error?.message ?? error), retryable, updated_at: nowIso() };
    });
    if (this.audit) await this.audit.append({ event_id: task.event_id, task_id: task.task_id, agent: task.assigned_agent, routing_reason: retryable ? "retryable_failure" : "nonretryable_failure", input_source: task.correlation_id, action: "delivery.fail", autonomy_level: task.autonomy_level, result: { status: task.status, attempts: task.attempt_count }, escalation: task.status === "dead_letter" ? "Rook" : null, errors: [task.last_error] });
    if (task.status === "dead_letter" && this.eventBus) await this.eventBus.publish({ type: "repeated.failure", source: task.assigned_agent, severity: "high", resource: task.task_id, correlation_id: task.correlation_id, causation_id: task.event_id, hop_count: task.hop_count, path: task.path, payload: { failed_event_id: task.event_id, attempts: task.attempt_count, error: task.last_error } });
    return task;
  }

  async recoverExpired(now = Date.now()) {
    const recovered = [];
    for (const task of await this.list()) {
      if (task.status === "running" && (!task.lease_until || Date.parse(task.lease_until) <= now)) {
        try {
          const claimed = await this.claim(task.task_id, "recovery", now);
          recovered.push(claimed);
        } catch { /* another worker won the claim */ }
      }
    }
    return recovered;
  }
}
