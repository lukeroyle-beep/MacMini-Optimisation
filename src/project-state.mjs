import { appendFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { atomicWriteJson, ensureDir, nowIso, readJson, sha256, stableStringify, withLock } from "./utils.mjs";

export const PROJECT_STATE_FIELDS = Object.freeze([
  "objective", "current_architecture", "current_status", "major_decisions", "rationale",
  "dependencies", "unresolved_issues", "risks", "next_actions", "important_evidence",
  "significant_implementation_history",
]);

function normalizedState(project, input, revision = 1) {
  const state = { project, revision };
  for (const field of PROJECT_STATE_FIELDS) {
    const value = input[field];
    if (["objective", "current_architecture", "current_status"].includes(field)) state[field] = typeof value === "string" ? value : "";
    else state[field] = Array.isArray(value) ? [...new Set(value.filter((item) => typeof item === "string" && item.trim()))] : [];
  }
  state.updated_at = input.updated_at ?? nowIso();
  state.digest = sha256(stableStringify(Object.fromEntries(PROJECT_STATE_FIELDS.map((field) => [field, state[field]]))));
  return state;
}

export class ProjectStateStore {
  constructor(dataDir, audit = null) { this.root = join(dataDir, "project-state"); this.locks = join(dataDir, "locks"); this.audit = audit; }

  path(project) { return join(this.root, project, "state.json"); }
  historyPath(project) { return join(this.root, project, "history.jsonl"); }

  async init(seed = {}) {
    await ensureDir(this.root);
    for (const [project, state] of Object.entries(seed)) {
      const current = await readJson(this.path(project), null);
      if (!current) await this.update(project, state, { reason: "initial_seed", agent: "Honey", force: true });
    }
  }

  async get(project) { return readJson(this.path(project), null); }

  async update(project, patch, { reason, evidence = [], agent = "Honey", expectedRevision = null, force = false } = {}) {
    if (!/^[a-z0-9][a-z0-9-]{1,80}$/.test(project)) throw new Error("invalid project slug");
    const unknown = Object.keys(patch).filter((key) => !PROJECT_STATE_FIELDS.includes(key) && !["updated_at"].includes(key));
    if (unknown.length) throw new Error(`unknown project-state field(s): ${unknown.join(", ")}`);
    return withLock(join(this.locks, `project-${project}.lock`), async () => {
      const current = await this.get(project);
      if (expectedRevision != null && current?.revision !== expectedRevision) throw new Error("project-state revision conflict");
      const merged = { ...(current ?? {}), ...patch };
      const next = normalizedState(project, merged, (current?.revision ?? 0) + 1);
      if (!force && current?.digest === next.digest) return { status: "no_change", state: current };
      await atomicWriteJson(this.path(project), next);
      const changedFields = PROJECT_STATE_FIELDS.filter((field) => stableStringify(current?.[field]) !== stableStringify(next[field]));
      const history = {
        project, revision: next.revision, timestamp: next.updated_at, agent, reason: reason ?? "meaningful_state_change",
        changed_fields: changedFields, before_digest: current?.digest ?? null, after_digest: next.digest, evidence,
      };
      await appendFile(this.historyPath(project), `${JSON.stringify(history)}\n`, { encoding: "utf8", mode: 0o600 });
      if (this.audit) await this.audit.append({ agent, action: "project_state.update", autonomy_level: "A1", input_source: project, result: { revision: next.revision, changed_fields: changedFields }, errors: [] });
      return { status: "updated", state: next, history };
    });
  }

  async list() {
    try { return (await readdir(this.root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => basename(entry.name)).sort(); }
    catch (error) { if (error?.code === "ENOENT") return []; throw error; }
  }
}
