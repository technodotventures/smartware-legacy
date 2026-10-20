import fs from 'node:fs';
import path from 'node:path';
import { armSummary, evaluateGates, sha256, stubSolver } from '../benchmarks/procedure-replay/runner/index.mjs';

const SOLVERS = { stub: stubSolver };

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? null : process.argv[index + 1] ?? null;
}

async function main() {
  const contractPath = process.argv[2];
  if (!contractPath || contractPath.startsWith('--')) {
    throw new Error('Usage: node scripts/run-procedure-replay-benchmark.mjs <benchmarks/procedure-replay/contract-v1.json> [--out <results-file>]');
  }
  const root = path.dirname(path.resolve(contractPath));
  const contractText = fs.readFileSync(contractPath, 'utf8');
  const contract = JSON.parse(contractText);
  const solverName = process.env.PROCEDURE_REPLAY_SOLVER ?? 'stub';
  const solve = SOLVERS[solverName];
  if (!solve) {
    throw new Error(`unknown solver: ${solverName}. Only ${Object.keys(SOLVERS).join(', ')} is registered on this branch. The live solver is not implemented here: it needs a frozen-model credential reachable from the run environment.`);
  }

  const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
  const fixture = JSON.parse(read('fixture/manifest.json'));
  const arms = ['A', 'B', 'C'].map((name) => JSON.parse(read(`arms/arm-${name.toLowerCase()}.json`)));

  const runConfigPath = path.join(root, 'run-config-v1.json');
  const runConfigHash = fs.existsSync(runConfigPath) ? sha256(fs.readFileSync(runConfigPath, 'utf8')) : null;
  const runConfig = fs.existsSync(runConfigPath) ? JSON.parse(fs.readFileSync(runConfigPath, 'utf8')) : null;

  const fixtureHashes = {};
  for (const f of ['fixture/manifest.json', 'fixture/task.md', 'fixture/repo/index.js']) {
    fixtureHashes[f] = sha256(read(f));
  }

  const replications = contract.replications ?? 2;
  const summaries = {};
  const rawRuns = {};
  for (const arm of arms) {
    const runs = [];
    for (let i = 0; i < replications; i++) runs.push(await solve({ arm, fixture }));
    summaries[arm.name] = armSummary(runs);
    rawRuns[arm.name] = runs;
  }

  const env = {
    solver: solverName,
    replications,
    node: process.version,
    model_id: runConfig?.model?.id ?? null,
    temperature: runConfig?.model?.temperature ?? null,
    seed: runConfig?.model?.seed ?? null,
    budget_cap_usd: runConfig?.budget?.max_usd_per_run ?? null,
    contract_sha256: sha256(contractText),
    run_config_sha256: runConfigHash,
    fixture_hashes: fixtureHashes,
  };

  // Safety and lifecycle are taken from what Arm B's lane returned per run, never
  // from a model claim and never from a constant. If any run did not report them
  // the gate stays unevaluated, and an unevaluated gate cannot print Adopt.
  const bRuns = rawRuns.B ?? [];
  const safetyRuns = bRuns.map((r) => r.safety).filter(Boolean);
  const lifecycleRuns = bRuns.map((r) => r.lifecycle).filter(Boolean);
  const context = {
    env,
    safety: safetyRuns.length === bRuns.length && bRuns.length > 0
      ? {
        cross_client_retrievals: Math.max(...safetyRuns.map((s) => s.cross_client_retrievals)),
        instruction_text_inert: safetyRuns.every((s) => s.instruction_text_inert === true),
        source: 'arm B lane return',
      }
      : null,
    lifecycle: lifecycleRuns.length === bRuns.length && bRuns.length > 0
      ? {
        correction_selects_new_revision: lifecycleRuns.every((l) => l.correction_selects_new_revision === true),
        forget_scope_zero_retrievability: lifecycleRuns.every((l) => l.forget_scope_zero_retrievability === true),
        source: 'arm B lane return',
      }
      : null,
  };

  const { gates, verdict, summary } = evaluateGates(context, contract, summaries);
  const result = {
    contract: contract.name,
    solver: solverName,
    replications,
    env,
    fixture_hashes: fixtureHashes,
    arms: summaries,
    raw_runs: rawRuns,
    gates,
    verdict,
    summary,
    commands: [
      `PROCEDURE_REPLAY_SOLVER=${solverName} node scripts/run-procedure-replay-benchmark.mjs ${contractPath}`,
    ],
  };

  const out = argValue('--out');
  if (out) {
    const target = path.resolve(out);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(result, null, 2) + '\n');
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

await main();
