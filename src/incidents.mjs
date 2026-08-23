import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteJson, ensureDir, nowIso, readJson, withLock } from "./utils.mjs";

export const INCIDENT_FIELDS = Object.freeze([
  "incident_id", "affected_service", "detection_time", "symptoms", "attempted_recovery",
  "diagnostic_evidence", "current_status", "assigned_agent", "severity", "autonomy_classification",
  "resolution", "verification_result",
]);

export class IncidentStore {
  constructor(dataDir, audit = null) { this.root = join(dataDir, "incidents"); this.locks = join(dataDir, "locks"); this.audit = audit; }
  path(id) { return join(this.root, `${id}.json`); }
  async create(input) {
    await ensureDir(this.root);
    const incident = { incident_id: input.incident_id, affected_service: input.affected_service, detection_time: input.detection_time ?? nowIso(), symptoms: input.symptoms ?? [], attempted_recovery: input.attempted_recovery ?? [], diagnostic_evidence: input.diagnostic_evidence ?? [], current_status: input.current_status ?? "open", assigned_agent: input.assigned_agent ?? "Rook", severity: input.severity ?? "medium", autonomy_classification: input.autonomy_classification ?? "A0", resolution: input.resolution ?? null, verification_result: input.verification_result ?? null, updated_at: nowIso() };
    for (const field of INCIDENT_FIELDS) if (!(field in incident)) throw new Error(`missing incident field: ${field}`);
    await atomicWriteJson(this.path(incident.incident_id), incident);
    await appendFile(join(this.root, "history.jsonl"), `${JSON.stringify({ incident_id: incident.incident_id, action: "created", timestamp: incident.updated_at })}\n`, { encoding: "utf8", mode: 0o600 });
    if (this.audit) await this.audit.append({ event_id: input.event_id ?? null, agent: "Rook", action: "incident.create", autonomy_level: "A1", input_source: incident.affected_service, result: { incident_id: incident.incident_id, status: incident.current_status }, errors: [] });
    return incident;
  }
  async update(id, patch) {
    return withLock(join(this.locks, `incident-${id}.lock`), async () => {
      const current = await readJson(this.path(id));
      const next = { ...current, ...patch, incident_id: id, updated_at: nowIso() };
      await atomicWriteJson(this.path(id), next);
      await appendFile(join(this.root, "history.jsonl"), `${JSON.stringify({ incident_id: id, action: "updated", fields: Object.keys(patch), timestamp: next.updated_at })}\n`, { encoding: "utf8", mode: 0o600 });
      return next;
    });
  }
}
