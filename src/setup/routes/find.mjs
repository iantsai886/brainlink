// Read-only routes used by the Find destinations in the local setup app.
// Dependencies are explicit so the HTTP route layer can be maintained by destination.
import { execFile, spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { buildAnswerReceipt } from '../../answer-receipt.mjs';
import {
  EMBED_PROVIDERS,
  DEFAULT_URL,
  DEFAULT_OPENAI_URL,
  DEFAULT_LOCAL_COMPAT_URL,
  PREFERRED_EMBED_MODEL,
  DEFAULT_OPENAI_EMBED_MODEL,
  detectOllamaBinary,
  pullOllamaModel,
  publicEmbedStatus,
  readEmbedApiKey,
  saveEmbedApiKey,
} from '../../embed.mjs';

function runExec(cmd, args, timeout = 300_000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err?.code ?? 0, stdout: String(stdout || ''), stderr: String(stderr || ''), error: err?.message || '' });
    });
  });
}

async function defaultOllamaAction({ action, url, model, os, env, openUrl }) {
  const downloadUrl = os === 'win32'
    ? 'https://ollama.com/download/windows'
    : os === 'darwin'
      ? 'https://ollama.com/download/mac'
      : 'https://ollama.com/download/linux';

  if (action === 'pull') {
    await pullOllamaModel(url, model);
    return { ok: true, method: 'api', message: `Downloaded ${model}. Meaning search is ready.` };
  }

  if (action === 'start') {
    const bin = await detectOllamaBinary(os, env);
    if (!bin) {
      return { ok: false, method: 'missing', install_url: downloadUrl, message: 'Ollama binary was not found. Click Install Ollama first.' };
    }
    try {
      const child = spawn(bin, ['serve'], { detached: true, stdio: 'ignore', windowsHide: true });
      child.unref();
    } catch (e) {
      return { ok: false, method: 'spawn', message: `Could not start Ollama: ${e.message}` };
    }
    for (let i = 0; i < 8; i++) {
      await delay(500);
      try {
        const r = await fetch(`${url.replace(/\/+$/, '')}/api/tags`);
        if (r.ok) return { ok: true, method: 'started', message: 'Ollama started!' };
      } catch {}
    }
    return { ok: true, method: 'starting', message: 'Ollama is starting in the background. Click Re-check in a few seconds.' };
  }

  if (action === 'install') {
    if (os === 'win32') {
      const wg = await runExec('winget', ['install', '-e', '--id', 'Ollama.Ollama', '--accept-package-agreements', '--accept-source-agreements'], 300_000);
      if (wg.ok) {
        const bin = await detectOllamaBinary(os, env);
        if (bin) {
          try {
            const child = spawn(bin, ['serve'], { detached: true, stdio: 'ignore', windowsHide: true });
            child.unref();
            await delay(1500);
          } catch {}
        }
        return { ok: true, method: 'winget', message: 'Ollama installed! Now click Download nomic-embed-text (or Re-check).' };
      }
      if (typeof openUrl === 'function') openUrl(downloadUrl);
      return { ok: true, method: 'download', install_url: downloadUrl, message: 'Opened the official Ollama installer page. Run the installer, then click Re-check.' };
    }
    if (os === 'darwin') {
      const br = await runExec('brew', ['install', '--cask', 'ollama'], 300_000);
      if (br.ok) return { ok: true, method: 'brew', message: 'Ollama installed via Homebrew! Launch Ollama, then click Re-check.' };
      if (typeof openUrl === 'function') openUrl(downloadUrl);
      return { ok: true, method: 'download', install_url: downloadUrl, message: 'Opened the official Ollama macOS download page. Install Ollama, then click Re-check.' };
    }
    if (typeof openUrl === 'function') openUrl(downloadUrl);
    return {
      ok: true,
      method: 'command',
      install_url: downloadUrl,
      command: 'curl -fsSL https://ollama.com/install.sh | sh',
      message: 'Run `curl -fsSL https://ollama.com/install.sh | sh` in a terminal, then click Re-check.',
    };
  }

  throw new Error(`Unsupported Ollama action "${action}".`);
}

export function createFindRoutes({
  file, env, os = process.platform, openUrl = null, ollamaRunner = null,
  normalize, loadConfig, saveConfig, localContext, searchWithVerdict,
  createReplayMisses, semanticStatus, plainText, readNote, loadVault,
  resolveNoteWikilinks,
}) {
  return {
    // Lightweight local RAG status for the Find -> Ask banner (no vault indexing required).
    'GET /api/rag-status': async () => {
      const cfg = normalize(await loadConfig(file));
      const ctx = localContext(cfg, { ...env, BRAINLINK_AI_PLATFORM: '' });
      const rawSem = await semanticStatus(ctx).catch(() => ({ available: false, provider: 'ollama', reason: 'unavailable' }));
      const sem = publicEmbedStatus(rawSem);
      const savedKey = await readEmbedApiKey(ctx.dataDir);
      return {
        semantic: sem,
        config: {
          provider: cfg.semantic?.provider || 'ollama',
          url: cfg.semantic?.url || '',
          model: cfg.semantic?.model || '',
          has_api_key: Boolean(savedKey || env.BRAINLINK_EMBED_API_KEY),
        },
        defaults: {
          ollama: { url: DEFAULT_URL, model: PREFERRED_EMBED_MODEL },
          'openai-compatible': { url: DEFAULT_LOCAL_COMPAT_URL, model: PREFERRED_EMBED_MODEL },
          openai: { url: DEFAULT_OPENAI_URL, model: DEFAULT_OPENAI_EMBED_MODEL },
          lexical: { url: '', model: '' },
        },
        providers: EMBED_PROVIDERS,
        stages: ['lexical', 'local-embeddings', 'map-index'],
      };
    },
    'POST /api/rag-config': async (b) => {
      const provider = String(b?.provider || 'ollama').trim().toLowerCase();
      if (!EMBED_PROVIDERS.includes(provider)) {
        throw new Error(`Unsupported RAG provider "${provider}". Choose: ${EMBED_PROVIDERS.join(', ')}.`);
      }
      const url = String(b?.url || '').trim();
      if (url && !/^https?:\/\//i.test(url)) throw new Error('Embedding endpoint URL must start with http:// or https://.');
      if (provider === 'openai' && url && !/^https:\/\//i.test(url)) throw new Error('Cloud API embedding URL must use https://.');
      const model = String(b?.model || '').trim().slice(0, 120);
      const cfg = normalize(await loadConfig(file));
      cfg.semantic = {
        enabled: provider !== 'lexical',
        provider,
        ...(url ? { url } : {}),
        ...(model ? { model } : {}),
      };
      await saveConfig(cfg, file);
      const ctx = localContext(cfg, { ...env, BRAINLINK_AI_PLATFORM: '' });
      if (typeof b?.api_key === 'string') {
        await saveEmbedApiKey(ctx.dataDir, b.api_key);
      }
      const rawSem = await semanticStatus(ctx).catch(() => ({ available: false, provider, reason: 'unavailable' }));
      const savedKey = await readEmbedApiKey(ctx.dataDir);
      return {
        ok: true,
        semantic: publicEmbedStatus(rawSem),
        config: {
          provider: cfg.semantic.provider,
          url: cfg.semantic.url || '',
          model: cfg.semantic.model || '',
          has_api_key: Boolean(savedKey || env.BRAINLINK_EMBED_API_KEY),
        },
      };
    },
    'POST /api/rag-ollama-action': async (b) => {
      const action = String(b?.action || '').trim().toLowerCase();
      if (!['install', 'start', 'pull'].includes(action)) {
        throw new Error('Action must be install, start, or pull.');
      }
      const cfg = normalize(await loadConfig(file));
      const url = String(cfg.semantic?.url || env.BRAINLINK_EMBED_URL || DEFAULT_URL).trim().replace(/\/+$/, '');
      const model = String(b?.model || cfg.semantic?.model || PREFERRED_EMBED_MODEL).trim();
      const runner = typeof ollamaRunner === 'function' ? ollamaRunner : defaultOllamaAction;
      const outcome = await runner({ action, url, model, os, env, openUrl });
      const ctx = localContext(cfg, { ...env, BRAINLINK_AI_PLATFORM: '' });
      const rawSem = await semanticStatus(ctx).catch(() => ({ available: false, provider: 'ollama', reason: 'unavailable' }));
      return {
        ok: outcome?.ok !== false,
        action,
        method: outcome?.method || '',
        message: outcome?.message || '',
        ...(outcome?.install_url ? { install_url: outcome.install_url } : {}),
        ...(outcome?.command ? { command: outcome.command } : {}),
        semantic: publicEmbedStatus(rawSem),
      };
    },
    // Cited local search for the owner. Vaults are searched separately; private vaults
    // are never included in the wildcard shared-vault scope.
    'POST /api/ask': async (b) => {
      const cfg = normalize(await loadConfig(file));
      const ctx = localContext(cfg, { ...env, BRAINLINK_AI_PLATFORM: '' });
      if (!ctx.enabled.length) throw new Error('Add a vault first.');
      const query = String(b.query || '').trim();
      if (!query) throw new Error('Ask a question first.');
      const requested = typeof b.vault === 'string' ? b.vault : '';
      if (requested && requested !== '*' && !ctx.enabled.includes(requested)) throw new Error('Unknown vault.');
      const shared = ctx.enabled.filter((name) => !ctx.byName.get(name).private);
      const scope = requested === '*' ? (shared.length ? shared : [ctx.enabled[0]]) : [requested || ctx.enabled[0]];
      const skippedPrivate = requested === '*' ? ctx.enabled.filter((name) => !scope.includes(name)) : [];
      const groups = [];
      for (const v of scope) {
        const r = await searchWithVerdict(ctx, v, query, { limit: 5 });
        if (cfg.replay_misses?.enabled === true) await createReplayMisses({ home: ctx.dataDir }).record({ vault: v, query, status: r.status, source: 'ask', isPrivate: Boolean(ctx.byName.get(v).private) }).catch(() => {});
        const lessTrusted = (x) => (/^(proposed|draft)$/i.test(x.status || '') ? 1 : 0);
        const top = r.results.slice(0, 3).map((x, i) => ({ x, i })).sort((a, b) => lessTrusted(a.x) - lessTrusted(b.x) || a.i - b.i).map(({ x }) => x);
        groups.push({
          vault: v, private: Boolean(ctx.byName.get(v).private), status: r.status, coverage: r.coverage, note: r.note || null,
          wiki_layer: r.wiki_layer || null,
          receipt: buildAnswerReceipt(r, { vault: v, sources: top }),
          answer: r.status === 'not_in_brain' ? null : plainText(top[0]?.snippet) || null,
          sources: top.map((x) => ({
            vault: v, path: x.path, title: x.title, heading: x.heading || '', score: x.score,
            date: x.date || '', status: x.status || '', confidence: x.confidence || '', historical: Boolean(x.historical),
            match: x.match || '', snippet: (plainText(x.snippet) || '').slice(0, 320),
          })),
        });
      }
      const rank = { hits: 0, weak: 1, not_in_brain: 2 };
      groups.sort((x, y) => (rank[x.status] ?? 3) - (rank[y.status] ?? 3));
      const first = groups[0];
      const embedder = await semanticStatus(ctx).catch(() => null);
      return {
        vault: first.vault, query, status: first.status, coverage: first.coverage, note: first.note, answer: first.answer, sources: first.sources,
        receipt: first.receipt, wiki_layer: first.wiki_layer,
        groups, vaults_searched: scope, vaults_skipped_private: skippedPrivate, search_mode: embedder?.available ? 'meaning' : 'keyword',
        ...(embedder ? { semantic: embedder } : {}),
      };
    },
    // Opens a citation source read-only. Wikilink resolution is performed against the
    // selected vault's privacy-filtered index, returning null for private and missing notes.
    'POST /api/note': async (b) => {
      const cfg = normalize(await loadConfig(file));
      const ctx = localContext(cfg, { ...env, BRAINLINK_AI_PLATFORM: '' });
      if (!b.vault || !ctx.enabled.includes(b.vault)) throw new Error('Unknown vault.');
      const note = await readNote(ctx, b.vault, String(b.path || ''));
      const index = await loadVault(ctx, b.vault);
      return { vault: b.vault, ...note, wikilinks: resolveNoteWikilinks(index, note.body) };
    },
  };
}
