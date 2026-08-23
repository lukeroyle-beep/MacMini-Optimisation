export class ModelRouter {
  constructor(config, audit = null) {
    this.config = config;
    this.models = new Map(config.models.map((model) => [model.id, model]));
    this.rules = new Map(config.rules.map((rule) => [rule.task_class, rule.prefer]));
    this.audit = audit;
  }

  async select(task, availability = {}) {
    const taskClass = task.task_class ?? "routine";
    const chain = this.rules.get(taskClass) ?? [];
    const considered = [];
    let selected = null;
    for (const id of chain) {
      const model = this.models.get(id);
      if (!model) { considered.push({ id, accepted: false, reason: "unknown_model" }); continue; }
      if (availability[id] === false) { considered.push({ id, accepted: false, reason: "unavailable" }); continue; }
      if (task.privacy_required && model.locality !== "local") { considered.push({ id, accepted: false, reason: "privacy_requires_local" }); continue; }
      if (task.requires_coding && !model.coding) { considered.push({ id, accepted: false, reason: "coding_capability_required" }); continue; }
      if (task.requires_tools && !model.tools) { considered.push({ id, accepted: false, reason: "tool_capability_required" }); continue; }
      if (Number(task.context_tokens ?? 0) > model.context_limit) { considered.push({ id, accepted: false, reason: "context_limit" }); continue; }
      if (model.locality === "cloud" && taskClass !== "critical" && taskClass !== "strategic" && taskClass !== "difficult" && taskClass !== "ambiguous" && task.allow_cloud_fallback !== true) { considered.push({ id, accepted: false, reason: "cloud_fallback_not_authorized" }); continue; }
      considered.push({ id, accepted: true, reason: "first_capable_available_model" }); selected = model; break;
    }
    const plan = {
      mode: this.config.mode,
      status: selected ? "selected" : "defer",
      selected_model: selected?.id ?? null,
      locality: selected?.locality ?? null,
      routing_reason: selected ? `${taskClass}:first_capable_available_model` : `${taskClass}:no_authorized_available_model`,
      considered,
      production_assignments_changed: false,
      execute: false,
      escalation: selected ? null : (["critical", "strategic"].includes(taskClass) ? "Codex" : "Rook"),
    };
    if (this.audit) await this.audit.append({ agent: task.agent ?? "router", selected_model: plan.selected_model, routing_reason: plan.routing_reason, input_source: task.input_source ?? taskClass, action: "model.route.prepare", autonomy_level: "A1", result: plan, escalation: plan.escalation, errors: selected ? [] : ["no_authorized_available_model"] });
    return plan;
  }
}
