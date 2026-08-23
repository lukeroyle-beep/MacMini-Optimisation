function rate(numerator, denominator) { return denominator ? Number((numerator / denominator).toFixed(4)) : null; }

export function aggregateMetrics(rows, modelClassification = {}) {
  const terminalSuccess = rows.filter((row) => row?.result?.status === "success" || row.result === "completed" || row?.result?.objective_completed === true);
  const objectiveIds = new Set(terminalSuccess.map((row) => row?.result?.objective_id).filter(Boolean));
  const completedObjectives = objectiveIds.size;
  const interventions = rows.filter((row) => row.human_approval != null || row.action === "human.intervention").length;
  const recoveries = rows.filter((row) => row.action === "service.recovery");
  const successfulRecoveries = recoveries.filter((row) => row.sentinel_status === "PASS" || row?.result?.status === "success").length;
  const validations = rows.filter((row) => row.sentinel_status != null);
  const firstPass = validations.filter((row) => row.sentinel_status === "PASS" && Number(row?.result?.rework_count ?? 0) === 0).length;
  const terminalStatuses = new Set(["success", "succeeded", "completed", "failed", "dead_letter", "cancelled", "timed_out"]);
  const terminalByTask = new Map();
  for (const row of rows) {
    const status = typeof row.result === "string" ? row.result : row?.result?.status;
    if (!row.task_id || !terminalStatuses.has(status)) continue;
    const previous = terminalByTask.get(row.task_id);
    if (!previous || Date.parse(row.timestamp ?? 0) >= Date.parse(previous.timestamp ?? 0)) terminalByTask.set(row.task_id, row);
  }
  const tasks = [...terminalByTask.values()];
  const taskSuccess = tasks.filter((row) => ["completed", "success", "succeeded"].includes(typeof row.result === "string" ? row.result : row?.result?.status)).length;
  const durations = tasks.map((row) => Number(row.execution_duration_ms)).filter(Number.isFinite);
  const modelRows = rows.filter((row) => {
    if (!row.selected_model) return false;
    const status = typeof row.result === "string" ? row.result : row?.result?.status;
    return row.action === "model.inference" || row?.result?.model_invoked === true || terminalStatuses.has(status);
  });
  const locals = modelRows.filter((row) => (modelClassification.local_patterns ?? []).some((pattern) => row.selected_model.toLowerCase().includes(pattern.toLowerCase())));
  const clouds = modelRows.filter((row) => (modelClassification.cloud_patterns ?? []).some((pattern) => row.selected_model.toLowerCase().includes(pattern.toLowerCase())));
  const perModel = {};
  for (const row of modelRows) {
    const entry = perModel[row.selected_model] ??= { total: 0, successful: 0, success_rate: null };
    entry.total += 1;
    if (row.result === "completed" || row?.result?.status === "success") entry.successful += 1;
    entry.success_rate = rate(entry.successful, entry.total);
  }
  const pricedCloudRows = clouds.filter((row) => row?.result?.cloud_cost != null);
  const cloudCostCoverage = clouds.length === 0 ? "unavailable" : pricedCloudRows.length === 0 ? "unavailable" : pricedCloudRows.length === clouds.length ? "complete" : "partial";
  const knownCloudCost = pricedCloudRows.reduce((sum, row) => sum + Number(row.result.cloud_cost), 0);
  return {
    objectives_completed: completedObjectives,
    task_success_rate: rate(taskSuccess, tasks.length),
    human_interventions_per_completed_objective: rate(interventions, completedObjectives),
    automatic_recovery_rate: rate(successfulRecoveries, recoveries.length),
    sentinel_first_pass_acceptance_rate: rate(firstPass, validations.length),
    local_inference_percentage: rate(locals.length, modelRows.length),
    cloud_escalation_percentage: rate(clouds.length, modelRows.length),
    model_specific_success_rate: perModel,
    failed_tool_calls: rows.reduce((total, row) => total + (row.tool_calls ?? []).filter((call) => call.status === "failed").length, 0),
    average_task_duration_ms: durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : null,
    repeat_failure_frequency: rows.filter((row) => row.action === "delivery.fail" && row?.result?.status === "dead_letter").length,
    agent_to_agent_handoffs: rows.filter((row) => typeof row.routing_reason === "string" && row.routing_reason.startsWith("rule:")).length,
    unnecessary_or_redundant_actions: rows.filter((row) => row.result === "duplicate" || row?.result?.status === "duplicate").length,
    cloud_inference_cost: cloudCostCoverage === "complete" ? knownCloudCost : null,
    cloud_inference_cost_known_total: pricedCloudRows.length ? knownCloudCost : null,
    cloud_inference_cost_coverage: cloudCostCoverage,
  };
}
