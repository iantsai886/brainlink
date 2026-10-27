import { runDiscoveryEvaluation } from '../src/rsi-discovery-evaluation.mjs';

try {
  const result = await runDiscoveryEvaluation();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.guardrails.hostile_entries_accepted > 0) process.exitCode = 2;
} catch (error) {
  process.stderr.write(`Discovery evaluation failed: ${error.message}\n`);
  process.exitCode = 1;
}
