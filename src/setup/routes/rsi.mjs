// RSI (Recursive Self-Improvement) ledger, observation, discovery, experiment, and weekly
// benchmark routes extracted from src/setup.mjs.
export function createRsiRoutes({
  file, env, loadConfig, saveConfig, stat, createHash,
  rsiLedger, rsiWeekly, rsiObservationSchedule, rsiExperiments, rsiDiscovery,
  validateWeeklyBenchmarkSchedule, setWeeklyBenchmarkKeepsAlive, touch, runWeeklyBenchmark,
  refreshObservationIdlePolicy, analyzeActivitySignals, attachRetrievalObservationSignals,
  readActivity, refreshDiscoveryIdlePolicy, runDiscovery,
}) {
  return {
    'GET /api/rsi': async () => ({ ideas: await rsiLedger.list() }),
    'GET /api/rsi/weekly-benchmark': async () => {
      const cfg = await loadConfig(file);
      return { runs: await rsiWeekly.benchmarkReport(8), schedule: validateWeeklyBenchmarkSchedule({}, cfg.weekly_benchmark) };
    },
    'POST /api/rsi/weekly-benchmark/settings': async (b) => {
      const cfg = await loadConfig(file);
      cfg.weekly_benchmark = validateWeeklyBenchmarkSchedule(b, cfg.weekly_benchmark);
      await saveConfig(cfg, file);
      setWeeklyBenchmarkKeepsAlive(cfg.weekly_benchmark.enabled);
      touch();
      return { schedule: cfg.weekly_benchmark };
    },
    'POST /api/rsi/weekly-benchmark/run': async () => {
      const run = await runWeeklyBenchmark('manual');
      const cfg = await loadConfig(file);
      return { run, runs: await rsiWeekly.benchmarkReport(8), schedule: validateWeeklyBenchmarkSchedule({}, cfg.weekly_benchmark) };
    },
    'GET /api/rsi/observations': async () => ({ observations: await rsiObservationSchedule.status() }),
    'POST /api/rsi/observations/settings': async (b) => {
      if (b?.vault_health_enabled === true) {
        const cfg = await loadConfig(file);
        const selected = cfg.vaults.find((vault) => vault.name === b.vault_health_vault);
        if (!selected || !await stat(selected.path).then((result) => result.isDirectory(), () => false)) throw new Error('Choose one available vault for link-health checks. The selected vault stays local and is not combined with another vault.');
      }
      let observations = await rsiObservationSchedule.configure(b);
      refreshObservationIdlePolicy(observations);
      if (await rsiObservationSchedule.due()) await rsiObservationSchedule.run('schedule');
      observations = await rsiObservationSchedule.status();
      return { observations };
    },
    'POST /api/rsi/observations/run': async () => ({ run: await rsiObservationSchedule.run('manual'), observations: await rsiObservationSchedule.status() }),
    'GET /api/rsi/export': async () => {
      const record = { schema: 1, exported_at: new Date().toISOString(), ideas: await rsiLedger.list() };
      return { ...record, sha256: createHash('sha256').update(JSON.stringify(record)).digest('hex') };
    },
    'POST /api/rsi/observations/analyze': async () => {
      const now = new Date();
      const report = analyzeActivitySignals(await readActivity(env, 20000), { now });
      const since = new Date(now.getTime() - 60 * 86400000).toISOString();
      attachRetrievalObservationSignals(report, await rsiWeekly.listRetrievalObservations({ since }), { now });
      return { report };
    },
    'GET /api/rsi/experiments': async () => {
      const cfg = await loadConfig(file);
      return { suites: rsiExperiments.suites({ rerankerEnabled: cfg.reranker.enabled }) };
    },
    'POST /api/rsi/experiments/run': async (b) => {
      const ideas = await rsiLedger.list();
      const idea = ideas.find((item) => item.id === b.idea_id);
      if (!idea) throw new Error('RSI idea not found.');
      if (idea.status !== 'testing') throw new Error('Move this RSI idea to testing before running an experiment.');
      const cfg = await loadConfig(file);
      const suite = rsiExperiments.suites({ rerankerEnabled: cfg.reranker.enabled }).find((item) => item.id === b.suite);
      if (!suite) throw new Error('Choose one of the built-in fictional evaluation suites.');
      if (idea.fields.candidate_version !== suite.candidate_version) throw new Error(`This test is for candidate ${suite.candidate_version}; update the RSI idea candidate version first.`);
      const receipt = await rsiExperiments.run(b.suite);
      return { idea: await rsiLedger.recordExperiment({ id: idea.id, expected_revision: idea.revision, receipt }) };
    },
    'POST /api/rsi/ideas/check': async (b) => ({ similar: await rsiLedger.similar(b) }),
    'POST /api/rsi/ideas': async (b) => ({ idea: await rsiLedger.create(b) }),
    'POST /api/rsi/ideas/update': async (b) => ({ idea: await rsiLedger.update(b) }),
    'POST /api/rsi/ideas/monitor': async (b) => ({ idea: await rsiLedger.recordMonitoring(b) }),
    'POST /api/rsi/ideas/rollback': async (b) => ({ idea: await rsiLedger.recordRollback(b) }),
    'GET /api/rsi/discovery': async () => ({ discovery: await rsiDiscovery.status() }),
    'POST /api/rsi/discovery/settings': async (b) => { const discovery = await rsiDiscovery.configure(b); refreshDiscoveryIdlePolicy(discovery); return { discovery }; },
    'POST /api/rsi/discovery/pause': async () => { const discovery = await rsiDiscovery.pause(); refreshDiscoveryIdlePolicy(discovery); return { discovery }; },
    'POST /api/rsi/discovery/resume': async () => { const discovery = await rsiDiscovery.resume(); refreshDiscoveryIdlePolicy(discovery); return { discovery }; },
    'POST /api/rsi/discovery/run': async () => ({ run: await runDiscovery('manual'), discovery: await rsiDiscovery.status() }),
    'POST /api/rsi/discovery/refresh-source': async (b) => ({ check: await rsiDiscovery.refreshSource(b.idea_id), discovery: await rsiDiscovery.status() }),
  };
}
