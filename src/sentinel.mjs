export const SENTINEL_OUTCOMES = Object.freeze(["PASS", "PASS_WITH_WARNINGS", "FAIL", "ESCALATE"]);

export function normalizeSentinelOutcome(status) {
  return ({ PASS: "PASS", PASS_WITH_NOTES: "PASS_WITH_WARNINGS", PASS_WITH_WARNINGS: "PASS_WITH_WARNINGS", REWORK: "FAIL", FAIL: "FAIL", ESCALATE: "ESCALATE" })[status] ?? "ESCALATE";
}

export function validateSentinelResult(input, { requiredEvidence = true, deterministicFailures = [] } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return safeEscalation(["validation result must be an object"]);
  const status = normalizeSentinelOutcome(input.status ?? input.validation_status);
  const criteria = Array.isArray(input.criteria) ? input.criteria : [];
  const errors = [];
  if (!SENTINEL_OUTCOMES.includes(status)) errors.push("invalid status");
  if (!criteria.length) errors.push("criteria are required");
  for (const [index, criterion] of criteria.entries()) {
    if (typeof criterion?.criterion !== "string" || !criterion.criterion) errors.push(`criterion ${index} missing description`);
    if (!SENTINEL_OUTCOMES.includes(normalizeSentinelOutcome(criterion?.status))) errors.push(`criterion ${index} invalid status`);
    if (typeof criterion?.evidence !== "string" || !criterion.evidence) errors.push(`criterion ${index} missing evidence`);
  }
  if (["PASS", "PASS_WITH_WARNINGS"].includes(status) && (!requiredEvidence || deterministicFailures.length || criteria.some((criterion) => !["PASS", "PASS_WITH_WARNINGS"].includes(normalizeSentinelOutcome(criterion.status))))) errors.push("pass forbidden with missing or failed evidence");
  if (errors.length) return safeEscalation(errors);
  return { valid: true, safe_failure: false, status, criteria, reasons: input.reasons ?? [], escalation_target: status === "ESCALATE" ? (input.escalation_target ?? "Codex") : null };
}

export function evaluateCriteria(criteria) {
  const normalized = criteria.map((criterion) => ({ ...criterion, status: normalizeSentinelOutcome(criterion.status) }));
  const status = normalized.some((criterion) => criterion.status === "ESCALATE") ? "ESCALATE"
    : normalized.some((criterion) => criterion.status === "FAIL") ? "FAIL"
      : normalized.some((criterion) => criterion.status === "PASS_WITH_WARNINGS") ? "PASS_WITH_WARNINGS" : "PASS";
  return { status, criteria: normalized };
}

export function safeEscalation(errors) {
  return { valid: false, safe_failure: true, status: "ESCALATE", criteria: [], reasons: errors, escalation_target: "Codex" };
}

export function routeSentinelOutcome(result, originatingAgent) {
  const status = normalizeSentinelOutcome(result.status ?? result.validation_status);
  if (status === "FAIL") {
    const lieutenant = ["Fizz", "Forge"].includes(originatingAgent) ? "Rook" : ["Bumble", "Honey"].includes(originatingAgent) ? "Nova" : originatingAgent;
    return { action: "rework", target: originatingAgent, oversight: lieutenant, notify_user: false };
  }
  if (status === "ESCALATE") return { action: "escalate", target: result.escalation_target ?? "Codex", notify_user: false };
  return { action: "accept", target: ["Fizz", "Forge"].includes(originatingAgent) ? "Rook" : "Nova", notify_user: false };
}
