import { describe, it, expect } from 'vitest';
import {
  p50,
  ratio,
  armSummary,
  isDistinct,
  computeVerdict,
  evaluateGates,
  stubSolver,
} from '../benchmarks/procedure-replay/runner/index.mjs';

const contract = {
  gates: {
    utility: { turns_ratio_max: 0.81, tool_calls_ratio_max: 0.60 },
    context: { procedure_tokens_max: 500 },
    safety: { cross_client_retrievals_max: 0 },
    lifecycle: {},
  },
};

const one = (turns, toolCalls, extra = {}) => armSummary([{ turns, toolCalls, testsPassed: true, ...extra }]);
const measured = (summary, injected, total) => ({
  ...summary,
  procedure_tokens_measured: injected,
  total_tokens_measured: total,
});

const allPassingArms = () => ({
  A: one(10, 10),
  B: measured(one(4, 4), 120, 160),
  C: measured(one(10, 10), 0, 1400),
});

const safetyOk = { cross_client_retrievals: 0, instruction_text_inert: true };
const lifecycleOk = { correction_selects_new_revision: true, forget_scope_zero_retrievability: true };

describe('procedure-replay measurement kernel', () => {
  it('p50 is the median', () => {
    expect(p50([1, 2, 3, 4, 5])).toBe(3);
    expect(p50([1, 2, 3, 4])).toBe(2.5);
    expect(p50([])).toBe(null);
  });

  it('first proof (fail-before): identical arms are not distinct', () => {
    expect(isDistinct(one(5, 9), one(5, 9), contract)).toBe(false);
  });

  it('first proof (pass-after): a materially cheaper Arm B is distinct', () => {
    expect(isDistinct(one(10, 10), one(4, 4), contract)).toBe(true);
  });

  it('stub solver ignores the memory lane, so A and B are identical', () => {
    const fixture = { bugs: [{ id: 'bug-1' }, { id: 'bug-2' }, { id: 'bug-3' }] };
    const a = stubSolver({ arm: { name: 'A' }, fixture });
    const b = stubSolver({ arm: { name: 'B' }, fixture });
    expect(a.turns).toBe(b.turns);
    expect(a.toolCalls).toBe(b.toolCalls);
    expect(isDistinct(armSummary([a]), armSummary([b]), contract)).toBe(false);
  });

  // Defect 3: isDistinct divided by A's p50 turns and tool calls with no zero guard.
  it('zero guard: a zero denominator is not a ratio and never passes', () => {
    expect(ratio(0, 0)).toBe(null);
    expect(ratio(1, 0)).toBe(null);
    expect(ratio(4, 10)).toBe(0.4);
    expect(isDistinct(one(0, 0), one(4, 4), contract)).toBe(false);
    const { gates } = evaluateGates({ env: { node: 'v22' } }, contract, {
      A: one(0, 0),
      B: measured(one(4, 4), 120, 160),
      C: measured(one(10, 10), 0, 1400),
    });
    expect(gates.utility.pass).toBe(null);
    expect(gates.utility.turns_ratio).toBe(null);
  });

  // Defect 1: the context gate read hand-written arm JSON literals.
  it('context gate fails a measured procedure over 500 tokens', () => {
    const arms = { A: one(10, 10), B: measured(one(4, 4), 600, 700), C: measured(one(10, 10), 0, 1400) };
    const { gates } = evaluateGates({ env: { node: 'v22' } }, contract, arms);
    expect(gates.context.evaluated).toBe(true);
    expect(gates.context.procedure_tokens).toBe(600);
    expect(gates.context.procedure_tokens_pass).toBe(false);
    expect(gates.context.pass).toBe(false);
  });

  it('context gate ignores a declared token number and refuses to pass unmeasured runs', () => {
    const stubbed = armSummary([stubSolver({ arm: { name: 'B' }, fixture: { bugs: [] } })]);
    expect(stubbed.procedure_tokens_measured).toBe(null);
    const { gates } = evaluateGates(
      { env: { node: 'v22' }, procedure_tokens: 96, armB_total_tokens: 140, armC_total_tokens: 1440 },
      contract,
      { A: stubbed, B: stubbed, C: stubbed },
    );
    expect(gates.context.procedure_tokens).toBe(null);
    expect(gates.context.evaluated).toBe(false);
    expect(gates.context.pass).toBe(null);
  });

  it('context gate also requires Arm B total tokens below Arm C', () => {
    const arms = { A: one(10, 10), B: measured(one(4, 4), 120, 1500), C: measured(one(10, 10), 0, 1400) };
    const { gates } = evaluateGates({ env: { node: 'v22' } }, contract, arms);
    expect(gates.context.arm_b_total_lt_arm_c).toBe(false);
    expect(gates.context.pass).toBe(false);
  });

  // Defect 2: computeVerdict's evaluable list omitted safety and lifecycle.
  it('safety and lifecycle are required gates: unevaluated is never Adopt', () => {
    const { gates, verdict } = evaluateGates({ env: { node: 'v22' } }, contract, allPassingArms());
    expect(gates.safety.evaluated).toBe(false);
    expect(gates.lifecycle.evaluated).toBe(false);
    expect(verdict).not.toBe('Adopt');
    expect(verdict).toBe('Assess');
  });

  it('prints Adopt only when every required gate passes, safety and lifecycle included', () => {
    const { gates, verdict } = evaluateGates(
      { env: { node: 'v22' }, safety: safetyOk, lifecycle: lifecycleOk },
      contract,
      allPassingArms(),
    );
    expect(gates.safety.pass).toBe(true);
    expect(gates.lifecycle.pass).toBe(true);
    expect(verdict).toBe('Adopt');
  });

  it('a cross-client retrieval holds the run even when everything else passes', () => {
    const { verdict } = evaluateGates(
      { env: { node: 'v22' }, safety: { ...safetyOk, cross_client_retrievals: 1 }, lifecycle: lifecycleOk },
      contract,
      allPassingArms(),
    );
    expect(verdict).toBe('Hold');
  });

  it('a lifecycle regression holds the run even when everything else passes', () => {
    const { verdict } = evaluateGates(
      { env: { node: 'v22' }, safety: safetyOk, lifecycle: { ...lifecycleOk, forget_scope_zero_retrievability: false } },
      contract,
      allPassingArms(),
    );
    expect(verdict).toBe('Hold');
  });

  it('computeVerdict treats a missing gate as unevaluated, never as a pass', () => {
    const complete = {
      first_proof: { pass: true },
      correctness: { pass: true },
      utility: { pass: true },
      context: { pass: true },
      safety: { pass: true },
      lifecyle: { pass: true },
      reproducibility: { pass: true },
    };
    expect(computeVerdict(complete)).toBe('Assess');
    expect(computeVerdict({ ...complete, lifecyle: undefined, lifecycle: { pass: true } })).toBe('Adopt');
  });
});
