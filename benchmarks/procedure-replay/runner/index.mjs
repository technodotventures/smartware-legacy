import crypto from 'node:crypto';

export function p50(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

// A ratio needs a real denominator. Returning null instead of Infinity or NaN is
// what stops a zero-turn or zero-tool-call Arm A from reporting a threshold pass,
// and it keeps an unmeasured ratio out of the verdict instead of silently true.
export function ratio(part, whole) {
  if (!Number.isFinite(part) || !Number.isFinite(whole)) return null;
  if (whole <= 0) return null;
  return part / whole;
}

const measuredValues = (runs, key) => runs
  .map((run) => run[key])
  .filter((value) => Number.isFinite(value));

// Token counts are taken from what each run reported, never from a number written
// by hand in an arm JSON. A run that reported no measurement leaves the median at
// null, and a null can never clear a gate.
export function armSummary(runs) {
  const injected = measuredValues(runs, 'injectedTokens');
  const total = measuredValues(runs, 'totalTokens');
  const allMeasured = runs.length > 0 && injected.length === runs.length;
  const totalsMeasured = runs.length > 0 && total.length === runs.length;
  return {
    runs: runs.length,
    p50_turns: p50(runs.map((r) => r.turns)),
    p50_tool_calls: p50(runs.map((r) => r.toolCalls)),
    raw_turns: runs.map((r) => r.turns),
    raw_tool_calls: runs.map((r) => r.toolCalls),
    tests_passed: runs.length > 0 && runs.every((r) => r.testsPassed === true),
    test_failures: runs.flatMap((r) => r.testFailures ?? []),
    procedure_tokens_measured: allMeasured ? p50(injected) : null,
    total_tokens_measured: totalsMeasured ? p50(total) : null,
    raw_injected_tokens: injected,
    raw_total_tokens: total,
  };
}

// Distinctness equals the utility gate: Arm B is distinct from A only when both
// ratios clear the pre-registered thresholds. A no-op lane leaves the ratios at
// 1.0, so the harness reports "not distinct" (the fail-before first proof).
export function isDistinct(A, B, contract) {
  const g = contract.gates.utility;
  const turnsRatio = ratio(B.p50_turns, A.p50_turns);
  const toolRatio = ratio(B.p50_tool_calls, A.p50_tool_calls);
  if (turnsRatio === null || toolRatio === null) return false;
  return turnsRatio <= g.turns_ratio_max && toolRatio <= g.tool_calls_ratio_max;
}

// Every gate in this list is required. Safety and lifecycle are in it because an
// unevaluated gate used to be skipped, which let a run print Adopt with both of
// them still reading evaluated: false. Only all seven passing prints Adopt.
export const REQUIRED_GATES = [
  'first_proof',
  'correctness',
  'utility',
  'context',
  'safety',
  'lifecycle',
  'reproducibility',
];

export function computeVerdict(gates) {
  const states = REQUIRED_GATES.map((name) => {
    const gate = gates[name];
    if (!gate) return 'missing';
    if (gate.pass === true) return 'pass';
    if (gate.pass === false) return 'fail';
    return 'unevaluated';
  });
  if (states.every((state) => state === 'pass')) return 'Adopt';
  if (states.includes('fail') && gates.first_proof?.pass === false) return 'Reject';
  if (states.includes('fail')) return 'Hold';
  return 'Assess';
}

function passCounts(gate, expected) {
  if (!gate) return null;
  return REQUIRED_GATES.filter((name) => gate[name]?.pass === expected).length;
}

export function evaluateGates(context, contract, armSummaries) {
  const { A, B, C } = armSummaries;
  const g = contract.gates;
  const turnsRatio = ratio(B.p50_turns, A.p50_turns);
  const toolRatio = ratio(B.p50_tool_calls, A.p50_tool_calls);
  const procedureTokens = B.procedure_tokens_measured;
  const armBTotal = B.total_tokens_measured;
  const armCTotal = C.total_tokens_measured;
  const utilityEvaluated = turnsRatio !== null && toolRatio !== null;
  const contextEvaluated = procedureTokens !== null && armBTotal !== null && armCTotal !== null;
  const safety = context.safety ?? null;
  const lifecycle = context.lifecycle ?? null;
  const safetyEvaluated = safety !== null && Number.isFinite(safety.cross_client_retrievals);
  const lifecycleEvaluated = lifecycle !== null
    && typeof lifecycle.correction_selects_new_revision === 'boolean'
    && typeof lifecycle.forget_scope_zero_retrievability === 'boolean';

  const gates = {
    first_proof: {
      evaluated: true,
      pass: isDistinct(A, B, contract),
    },
    correctness: {
      evaluated: true,
      pass: A.tests_passed && B.tests_passed && C.tests_passed,
    },
    utility: {
      evaluated: utilityEvaluated,
      turns_ratio: turnsRatio,
      turns_pass: turnsRatio === null ? null : turnsRatio <= g.utility.turns_ratio_max,
      tool_calls_ratio: toolRatio,
      tool_calls_pass: toolRatio === null ? null : toolRatio <= g.utility.tool_calls_ratio_max,
      pass: utilityEvaluated
        ? turnsRatio <= g.utility.turns_ratio_max && toolRatio <= g.utility.tool_calls_ratio_max
        : null,
    },
    context: {
      evaluated: contextEvaluated,
      source: 'measured',
      procedure_tokens: procedureTokens,
      procedure_tokens_pass: procedureTokens === null
        ? null
        : procedureTokens <= g.context.procedure_tokens_max,
      arm_b_total_lt_arm_c: contextEvaluated ? armBTotal < armCTotal : null,
      pass: contextEvaluated
        ? procedureTokens <= g.context.procedure_tokens_max && armBTotal < armCTotal
        : null,
    },
    safety: {
      evaluated: safetyEvaluated,
      cross_client_retrievals: safety?.cross_client_retrievals ?? null,
      instruction_text_inert: safety?.instruction_text_inert ?? null,
      pass: safetyEvaluated
        ? safety.cross_client_retrievals <= g.safety.cross_client_retrievals_max
          && safety.instruction_text_inert === true
        : null,
      note: safetyEvaluated ? null : 'no safety evidence: requires a live run',
    },
    lifecycle: {
      evaluated: lifecycleEvaluated,
      correction_selects_new_revision: lifecycle?.correction_selects_new_revision ?? null,
      forget_scope_zero_retrievability: lifecycle?.forget_scope_zero_retrievability ?? null,
      pass: lifecycleEvaluated
        ? lifecycle.correction_selects_new_revision === true
          && lifecycle.forget_scope_zero_retrievability === true
        : null,
      note: lifecycleEvaluated ? null : 'no lifecycle evidence: requires a live Smartware run',
    },
    reproducibility: {
      evaluated: true,
      pass: Boolean(context.env),
      env_keys: context.env ? Object.keys(context.env).sort() : [],
    },
  };

  return {
    gates,
    verdict: computeVerdict(gates),
    summary: {
      required_gates: REQUIRED_GATES.length,
      passed: passCounts(gates, true) ?? 0,
      failed: passCounts(gates, false) ?? 0,
      unevaluated: REQUIRED_GATES.filter((name) => !gates[name] || gates[name].pass === null || gates[name].pass === undefined).length,
    },
  };
}

// Deterministic no-op solver: the memory lane is never consulted, so every arm
// produces an identical sequence. This is the fail-before baseline. It reports no
// token measurements, so it can never clear the context gate either.
export function stubSolver({ arm, fixture }) {
  const bugs = fixture.bugs ?? [];
  const turns = [...bugs.map(() => 1), 1];
  const toolCalls = [...bugs.map(() => 2), 1];
  return {
    arm: arm.name,
    solver: 'stub',
    turns: turns.length,
    toolCalls: toolCalls.length,
    testsPassed: false,
    testFailures: bugs.map((b) => b.id),
    sequence: { turns, toolCalls },
  };
}
