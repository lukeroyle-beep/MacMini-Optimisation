import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteJson, ensureDir, nowIso, readJson, redactSecrets, sha256, stableStringify, withLock } from "./utils.mjs";

const severities = new Set(["info", "low", "medium", "high", "critical"]);
const forbiddenKeys = new Set(["__proto__", "prototype", "constructor"]);

function payloadDepth(value, depth = 0) {
  if (value === null || typeof value !== "object") return depth;
  let maximum = depth;
  for (const [key, child] of Object.entries(value)) {
    if (forbiddenKeys.has(key)) throw new EventValidationError(`forbidden payload key: ${key}`);
    maximum = Math.max(maximum, payloadDepth(child, depth + 1));
  }
  return maximum;
}

export class EventValidationError extends Error {}

export class EventBus {
  constructor(dataDir, config, audit = null) {
    this.dataDir = dataDir;
    this.config = config;
    this.audit = audit;
    this.eventsDir = join(dataDir, "events", "accepted");
    this.routesDir = join(dataDir, "events", "routes");
    this.quarantineDir = join(dataDir, "quarantine");
    this.locksDir = join(dataDir, "locks");
  }

  async init() {
    await Promise.all([this.eventsDir, this.routesDir, this.quarantineDir, this.locksDir].map(ensureDir));
    await this.migrateLegacyRouteDirectories();
  }

  async migrateLegacyRouteDirectories() {
    const entries = await readdir(this.routesDir, { withFileTypes: true });
    for (const entry of entries.filter((item) => item.isDirectory() && !/^[0-9a-f]{64}$/.test(item.name))) {
      const legacyDir = join(this.routesDir, entry.name);
      const names = (await readdir(legacyDir)).filter((name) => name.endsWith(".json"));
      for (const name of names) {
        const task = await readJson(join(legacyDir, name));
        if (typeof task.correlation_id !== "string" || !/^[A-Za-z0-9_.:-]{8,160}$/.test(task.correlation_id)) {
          await atomicWriteJson(join(this.quarantineDir, `legacy-route-${Date.now()}-${randomUUID()}.json`), redactSecrets({ reason: "invalid_legacy_correlation_id", task }));
          continue;
        }
        const targetDir = join(this.routesDir, sha256(task.correlation_id));
        await ensureDir(targetDir);
        try { await writeFile(join(targetDir, name), `${JSON.stringify(task, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 }); }
        catch (error) { if (error?.code !== "EEXIST") throw error; }
      }
      await rm(legacyDir, { recursive: true, force: true });
    }
  }

  normalize(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new EventValidationError("event must be an object");
    if (typeof input.type !== "string" || !/^[a-z][a-z0-9_.-]{2,127}$/.test(input.type)) throw new EventValidationError("invalid event type");
    if (!(input.type in this.config.routes)) throw new EventValidationError("unknown event type");
    if (typeof input.source !== "string" || !input.source.trim()) throw new EventValidationError("event source is required");
    if (!severities.has(input.severity ?? "info")) throw new EventValidationError("invalid severity");
    if (input.payload != null && (typeof input.payload !== "object" || Array.isArray(input.payload))) throw new EventValidationError("payload must be an object");
    if (input.timestamp != null && (!Number.isFinite(Date.parse(input.timestamp)) || !/^\d{4}-\d{2}-\d{2}T/.test(input.timestamp))) throw new EventValidationError("invalid timestamp");
    const path = input.path ?? [];
    if (!Array.isArray(path) || path.some((item) => typeof item !== "string")) throw new EventValidationError("path must be a string array");
    const hopCount = Number(input.hop_count ?? 0);
    if (!Number.isInteger(hopCount) || hopCount < 0) throw new EventValidationError("hop_count must be a non-negative integer");
    const basis = {
      schema_version: this.config.schema_version,
      type: input.type,
      source: input.source,
      severity: input.severity ?? "info",
      timestamp: input.timestamp ?? nowIso(),
      resource: input.resource ?? null,
      payload: input.payload ?? {},
      correlation_id: input.correlation_id ?? null,
      causation_id: input.causation_id ?? null,
      hop_count: hopCount,
      path,
    };
    const redactedPayload = redactSecrets(basis.payload);
    if (stableStringify(redactedPayload) !== stableStringify(basis.payload)) throw new EventValidationError("event payload contains secret-like material");
    if (Buffer.byteLength(JSON.stringify(basis.payload), "utf8") > this.config.max_payload_bytes) throw new EventValidationError("payload exceeds limit");
    if (payloadDepth(basis.payload) > (this.config.max_payload_depth ?? 32)) throw new EventValidationError("payload exceeds depth limit");
    const computedId = `evt_${sha256(stableStringify(basis)).slice(0, 32)}`;
    const eventId = input.event_id ?? computedId;
    if (!/^[A-Za-z0-9_.:-]{8,160}$/.test(eventId)) throw new EventValidationError("invalid event_id");
    const correlationId = basis.correlation_id ?? eventId;
    if (typeof correlationId !== "string" || !/^[A-Za-z0-9_.:-]{8,160}$/.test(correlationId)) throw new EventValidationError("invalid correlation_id");
    if (basis.causation_id != null && (typeof basis.causation_id !== "string" || !/^[A-Za-z0-9_.:-]{8,160}$/.test(basis.causation_id))) throw new EventValidationError("invalid causation_id");
    const event = { ...basis, event_id: eventId, correlation_id: correlationId };
    event.canonical_hash = sha256(stableStringify(event));
    return event;
  }

  targets(type) { return [...new Set(this.config.routes[type] ?? [])]; }

  async publish(input) {
    await this.init();
    let event;
    try { event = this.normalize(input); }
    catch (error) {
      const quarantine = join(this.quarantineDir, `malformed-${Date.now()}-${randomUUID()}.json`);
      await atomicWriteJson(quarantine, redactSecrets({ received_at: nowIso(), error: error.message, input }));
      if (this.audit) await this.audit.append({ action: "event.publish", autonomy_level: "A0", input_source: input?.source ?? "unknown", result: "quarantined", escalation: "Rook", errors: [error.message] });
      return { status: "quarantined", reason: error.message, path: quarantine, routes: [] };
    }

    if (event.hop_count >= this.config.max_hops) {
      const path = join(this.quarantineDir, `${event.event_id}-depth.json`);
      await atomicWriteJson(path, redactSecrets({ reason: "max_hops", event }));
      if (this.audit) await this.audit.append({ event_id: event.event_id, action: "event.publish", input_source: event.source, result: "quarantined", escalation: "Rook", errors: ["max_hops"] });
      return { status: "quarantined", reason: "max_hops", routes: [] };
    }

    const acceptedPath = join(this.eventsDir, `${event.event_id}.json`);
    try {
      await writeFile(acceptedPath, `${JSON.stringify(event, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const existing = JSON.parse(await readFile(acceptedPath, "utf8"));
      if (existing.canonical_hash === event.canonical_hash) {
        if (this.audit) await this.audit.append({ event_id: event.event_id, action: "event.publish", input_source: event.source, result: "duplicate", errors: [] });
        return { status: "duplicate", event: existing, routes: [] };
      }
      const collisionPath = join(this.quarantineDir, `${event.event_id}-conflict-${Date.now()}-${randomUUID()}.json`);
      await atomicWriteJson(collisionPath, redactSecrets({ reason: "event_id_conflict", existing_hash: existing.canonical_hash, incoming: event }));
      if (this.audit) await this.audit.append({ event_id: event.event_id, action: "event.publish", input_source: event.source, result: "quarantined", escalation: "Rook", errors: ["event_id_conflict"] });
      return { status: "quarantined", reason: "event_id_conflict", path: collisionPath, routes: [] };
    }

    const routes = await withLock(join(this.locksDir, `correlation-${sha256(event.correlation_id)}.lock`), async () => {
      const correlationDir = join(this.routesDir, sha256(event.correlation_id));
      await ensureDir(correlationDir);
      const existingCount = (await readdir(correlationDir)).filter((name) => name.endsWith(".json")).length;
      const created = [];
      for (const target of this.targets(event.type)) {
        if (event.path.includes(target)) continue;
        if (existingCount + created.length >= this.config.max_correlation_dispatches) break;
        const task = {
          task_id: `task_${sha256(`${event.event_id}:${target}`).slice(0, 24)}`,
          event_id: event.event_id,
          correlation_id: event.correlation_id,
          assigned_agent: target,
          status: "queued",
          attempt_count: 0,
          max_attempts: 3,
          lease_until: null,
          last_error: null,
          autonomy_level: "A1",
          created_at: nowIso(),
          hop_count: event.hop_count + 1,
          path: [...event.path, target],
        };
        const routePath = join(correlationDir, `${task.task_id}.json`);
        try { await writeFile(routePath, `${JSON.stringify(task, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 }); created.push(task); }
        catch (error) { if (error?.code !== "EEXIST") throw error; }
      }
      return created;
    });

    if (this.audit) await this.audit.append({
      event_id: event.event_id,
      task_id: routes[0]?.task_id ?? null,
      agent: "event-bus",
      routing_reason: routes.length ? `rule:${event.type}` : "no_route_or_loop_guard",
      input_source: event.source,
      action: "event.publish",
      autonomy_level: "A1",
      result: { status: "accepted", routed_to: routes.map((route) => route.assigned_agent) },
      tool_calls: [], errors: [],
    });
    return { status: "accepted", event, routes };
  }

  async events() {
    await this.init();
    const names = (await readdir(this.eventsDir)).filter((name) => name.endsWith(".json")).sort();
    return Promise.all(names.map((name) => readJson(join(this.eventsDir, name))));
  }

  async recoverUndispatched() {
    await this.init();
    const recovered = [];
    for (const event of await this.events()) {
      const correlationDir = join(this.routesDir, sha256(event.correlation_id));
      let names = [];
      try { names = await readdir(correlationDir); } catch (error) { if (error?.code !== "ENOENT") throw error; }
      const hasEventRoute = names.some((name) => name === `task_${sha256(`${event.event_id}:${this.targets(event.type)[0] ?? ""}`).slice(0, 24)}.json`);
      if (!hasEventRoute && this.targets(event.type).length) {
        const replay = { ...event };
        delete replay.canonical_hash;
        const acceptedPath = join(this.eventsDir, `${event.event_id}.json`);
        const existing = JSON.parse(await readFile(acceptedPath, "utf8"));
        await withLock(join(this.locksDir, `correlation-${sha256(event.correlation_id)}.lock`), async () => {
          const dir = join(this.routesDir, sha256(event.correlation_id));
          await ensureDir(dir);
          const count = (await readdir(dir)).filter((name) => name.endsWith(".json")).length;
          if (count >= this.config.max_correlation_dispatches) return;
          for (const target of this.targets(existing.type)) {
            if (existing.path.includes(target)) continue;
            const task = { task_id: `task_${sha256(`${existing.event_id}:${target}`).slice(0, 24)}`, event_id: existing.event_id, correlation_id: existing.correlation_id, assigned_agent: target, status: "queued", attempt_count: 0, max_attempts: 3, lease_until: null, last_error: null, autonomy_level: "A1", created_at: nowIso(), hop_count: existing.hop_count + 1, path: [...existing.path, target], recovered_after_restart: true };
            try { await writeFile(join(dir, `${task.task_id}.json`), `${JSON.stringify(task, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 }); recovered.push(task); }
            catch (error) { if (error?.code !== "EEXIST") throw error; }
          }
        });
      }
    }
    if (recovered.length && this.audit) await this.audit.append({ agent: "event-bus", action: "event.recover", autonomy_level: "A1", routing_reason: "restart_recovery", input_source: "durable_event_store", result: { recovered: recovered.length }, errors: [] });
    return recovered;
  }
}
