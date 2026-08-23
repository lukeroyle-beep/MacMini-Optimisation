const ranks = Object.freeze({ A0: 0, A1: 1, A2: 2, A3: 3, A4: 4 });

export class AutonomyPolicy {
  constructor(config, audit = null, eventBus = null) {
    this.maxLevel = config.max_level;
    this.capabilities = config.capabilities ?? {};
    this.audit = audit;
    this.eventBus = eventBus;
    if (!(this.maxLevel in ranks)) throw new Error(`invalid phase autonomy level: ${this.maxLevel}`);
  }

  decide(capability, { approved = false } = {}) {
    const level = this.capabilities[capability];
    if (!level || !(level in ranks)) return { allowed: false, level: null, disposition: "DENY", reason: "unknown_capability" };
    if (level === "A4") return { allowed: false, level, disposition: "PROHIBITED", reason: "a4_prohibited" };
    if (level === "A3") return { allowed: false, level, disposition: "APPROVAL_REQUIRED", reason: approved ? "a3_requires_separate_approved_executor" : "human_approval_required" };
    if (ranks[level] > ranks[this.maxLevel]) return { allowed: false, level, disposition: "DENY", reason: `phase_gate_${this.maxLevel}` };
    if (level === "A1") return { allowed: true, level, disposition: "PREPARE_ONLY", reason: "phase1_preparation_allowed" };
    return { allowed: true, level, disposition: "ALLOW", reason: "read_only" };
  }

  async run(capability, context, executor) {
    const started = Date.now();
    const decision = this.decide(capability, context);
    let invoked = false;
    let result = null;
    let error = null;
    if (decision.allowed) {
      try { invoked = true; result = await executor(decision); }
      catch (caught) { error = caught; }
    }
    if (this.audit) await this.audit.append({
      event_id: context?.event_id ?? null,
      task_id: context?.task_id ?? null,
      agent: context?.agent ?? "system",
      input_source: context?.input_source ?? capability,
      action: capability,
      autonomy_level: decision.level,
      result: error ? "failed" : decision.allowed ? "completed" : decision.disposition,
      escalation: decision.disposition === "APPROVAL_REQUIRED" ? "Codex" : null,
      human_approval: context?.approved ? { approved: true } : null,
      execution_duration_ms: Date.now() - started,
      errors: error ? [error.message] : decision.allowed ? [] : [decision.reason],
    });
    if (decision.disposition === "APPROVAL_REQUIRED" && this.eventBus) {
      await this.eventBus.publish({
        type: "approval.required", source: context?.agent ?? "autonomy-policy", severity: "high",
        resource: capability, correlation_id: context?.correlation_id ?? context?.event_id ?? undefined,
        causation_id: context?.event_id ?? null, payload: { capability, task_id: context?.task_id ?? null, autonomy_level: decision.level, reason: decision.reason },
      });
    }
    if (error) throw error;
    return { ...decision, invoked, result };
  }
}

export function compareAutonomy(left, right) { return ranks[left] - ranks[right]; }
