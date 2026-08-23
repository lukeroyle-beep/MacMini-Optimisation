import { appendFile, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { atomicWrite, ensureDir, nowIso, redactSecrets, sha256, stableStringify, withLock } from "./utils.mjs";

export const AUDIT_REQUIRED_FIELDS = Object.freeze([
  "event_id", "task_id", "agent", "selected_model", "routing_reason", "input_source",
  "action", "autonomy_level", "tool_calls", "result", "sentinel_status", "escalation",
  "human_approval", "timestamp", "execution_duration_ms", "errors",
  "execution_duration",
]);

function defaults() {
  return {
    event_id: null, task_id: null, agent: "system", selected_model: null,
    routing_reason: "deterministic", input_source: null, action: null, autonomy_level: "A0",
    tool_calls: [], result: null, sentinel_status: null, escalation: null,
    human_approval: null, timestamp: nowIso(), execution_duration_ms: 0, execution_duration: 0, errors: [],
  };
}

export class AuditLog {
  constructor(dataDir) {
    this.directory = join(dataDir, "audit");
    this.path = join(this.directory, "audit.jsonl");
    this.lock = join(dataDir, "locks", "audit.lock");
  }

  async init() {
    await ensureDir(this.directory);
    const rows = await this.rows();
    if (!rows.length || rows.every((row) => AUDIT_REQUIRED_FIELDS.every((field) => field in row))) return;
    let previous = null;
    for (const [index, row] of rows.entries()) {
      const { record_hash: supplied, ...withoutHash } = row;
      if (row.previous_hash !== previous || sha256(stableStringify(withoutHash)) !== supplied) throw new Error(`refusing to migrate invalid legacy audit chain at row ${index}`);
      previous = supplied;
    }
    let migratedPrevious = null;
    const migrated = rows.map((row) => {
      const clean = { ...defaults(), ...row, execution_duration: row.execution_duration ?? row.execution_duration_ms ?? 0, execution_duration_ms: row.execution_duration_ms ?? row.execution_duration ?? 0, previous_hash: migratedPrevious };
      delete clean.record_hash;
      clean.record_hash = sha256(stableStringify(clean));
      migratedPrevious = clean.record_hash;
      return clean;
    });
    await atomicWrite(this.path, `${migrated.map((row) => JSON.stringify(row)).join("\n")}\n`);
  }

  async rows() {
    try { return (await readFile(this.path, "utf8")).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)); }
    catch (error) { if (error?.code === "ENOENT") return []; throw error; }
  }

  async append(input) {
    await this.init();
    return withLock(this.lock, async () => {
      const rows = await this.rows();
      const previousHash = rows.at(-1)?.record_hash ?? null;
      const clean = redactSecrets({ ...defaults(), ...input });
      if (input.execution_duration_ms != null && input.execution_duration == null) clean.execution_duration = input.execution_duration_ms;
      if (input.execution_duration != null && input.execution_duration_ms == null) clean.execution_duration_ms = input.execution_duration;
      for (const field of AUDIT_REQUIRED_FIELDS) if (!(field in clean)) clean[field] = null;
      if (!Array.isArray(clean.tool_calls)) clean.tool_calls = [];
      if (!Array.isArray(clean.errors)) clean.errors = clean.errors == null ? [] : [String(clean.errors)];
      const record = { ...clean, previous_hash: previousHash };
      record.record_hash = sha256(stableStringify(record));
      await ensureDir(dirname(this.path));
      await appendFile(this.path, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
      return record;
    });
  }

  async verify() {
    const rows = await this.rows();
    const errors = [];
    let previousHash = null;
    rows.forEach((row, index) => {
      for (const field of AUDIT_REQUIRED_FIELDS) if (!(field in row)) errors.push(`row ${index}: missing ${field}`);
      if (row.previous_hash !== previousHash) errors.push(`row ${index}: broken previous_hash`);
      const { record_hash: supplied, ...withoutHash } = row;
      const expected = sha256(stableStringify(withoutHash));
      if (supplied !== expected) errors.push(`row ${index}: invalid record_hash`);
      previousHash = supplied;
    });
    return { valid: errors.length === 0, rows: rows.length, errors, last_hash: previousHash };
  }
}
