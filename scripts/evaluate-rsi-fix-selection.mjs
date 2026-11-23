import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatCoveragePercent } from './rsi-fix-selection-report.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixturePath = path.join(root, 'samples', 'evaluation', 'rsi-fix-selection-v1.json');
const fixtureBytes = await readFile(fixturePath);
const fixture = JSON.parse(fixtureBytes.toString('utf8'));
if (fixture.schema !== 1 || fixture.training.length < 5 || fixture.fresh_cases.length < 10 || fixture.selection_limit < 1) throw new Error('Invalid RSI fix-selection fixture.');
const counts = new Map();
for (const item of fixture.training) counts.set(item.fix_needed, (counts.get(item.fix_needed) || 0) + 1);
const frequency = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, fixture.selection_limit).map(([type]) => type);
const evaluate = selected => ({ selected, hits: fixture.fresh_cases.filter(item => selected.includes(item.fix_needed)).length, total: fixture.fresh_cases.length });
const dynamic = evaluate(frequency), fixed = evaluate(fixture.fixed_list);
const result = {
  date: new Date().toISOString().slice(0, 10),
  experiment: 'RSI-001 fix-selection policy comparison',
  fixture: fixture.fixture,
  fixture_sha256: await import('node:crypto').then(({ createHash }) => createHash('sha256').update(fixtureBytes).digest('hex')),
  training_cases: fixture.training.length,
  fresh_cases: fixture.fresh_cases.length,
  selection_limit: fixture.selection_limit,
  baseline: { policy: 'fixed list', ...fixed, coverage: Number((fixed.hits / fixed.total).toFixed(3)) },
  candidate: { policy: 'select most frequent training miss types', ...dynamic, coverage: Number((dynamic.hits / dynamic.total).toFixed(3)) },
  outcome: dynamic.hits > fixed.hits ? 'frequency selection performed better on this fictional fixture' : dynamic.hits < fixed.hits ? 'fixed list performed better on this fictional fixture' : 'tie on this fictional fixture',
  decision: 'no_recursive_gain_claim',
  limitations: ['All cases are synthetic and authored for this fixture.', 'The fixed-list policy was specified before scoring the fresh cases, but the sample is small and not an independent benchmark.', 'This result does not establish better production retrieval, autonomous learning, or real user benefit.'],
};
const report = `# RSI-001 fix-selection experiment\n\n- Date: ${result.date}\n- Fixture: \`${result.fixture}\` (SHA-256: \`${result.fixture_sha256}\`)\n- Training baseline: ${result.training_cases} fictional cases; fixed-list top ${result.selection_limit}: ${fixed.selected.join(', ')}; fresh-case coverage ${fixed.hits}/${fixed.total} (${formatCoveragePercent(fixed.hits, fixed.total)}).\n- Candidate: frequency-selected top ${result.selection_limit}: ${dynamic.selected.join(', ')}; fresh-case coverage ${dynamic.hits}/${dynamic.total} (${formatCoveragePercent(dynamic.hits, dynamic.total)}).\n- Outcome: ${result.outcome}.\n- Decision: no recursive gain claim; no behavior or ranking changed.\n\n## Limits\n\n${result.limitations.map(item => `- ${item}`).join('\n')}\n\nRSI-001's experiment is complete for this synthetic comparison. Any decision to promote an adaptive fix-selection policy remains open and requires a fresh, independently labeled evaluation.\n`;
const output = path.join(root, 'docs', 'RSI-001-fix-selection-experiment.md');
await writeFile(output, report, 'utf8');
process.stdout.write(JSON.stringify(result, null, 2) + '\n');
