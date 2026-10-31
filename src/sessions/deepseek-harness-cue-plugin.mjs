// BrainLink's optional DeepSeek Harness plugin.
// It observes root-agent lifecycle only and writes a metadata-only closeout cue.
// It never reads transcripts, session contents, MCP credentials, or BrainLink config.
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const name = 'brainlink-session-closeout-cue';
export const inject = ['agents'];

const validId = (value) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,200}$/.test(value);

const cueDir = "__BRAINLINK_CUE_DIR__";

export function installHarnessCueListeners(ctx, cueDir) {
  if (typeof cueDir !== 'string' || !path.isAbsolute(cueDir)) throw new Error('BrainLink Harness cue plugin has an invalid local cue directory');
  const roots = new Set();
  const queues = new Map();
  const enqueue = (sessionId, operation) => {
    const previous = queues.get(sessionId) || Promise.resolve();
    const next = previous.catch(() => {}).then(operation).catch((error) => {
      ctx.logger?.warn?.(`[${name}] could not update closeout cue: ${error.message || String(error)}`);
    });
    queues.set(sessionId, next);
    void next.finally(() => { if (queues.get(sessionId) === next) queues.delete(sessionId); });
  };
  const cueFile = (sessionId) => {
    const id = createHash('sha256').update(`deepseek-harness\0${sessionId}`).digest('hex');
    return path.join(cueDir, `${id}.json`);
  };

  for (const agent of ctx.agents.roots()) if (validId(agent?.session?.id)) roots.add(agent.session.id);

  ctx.on('agent/created', ({ agent }) => {
    if (agent && validId(agent.session?.id) && ctx.agents.roots().includes(agent)) roots.add(agent.session.id);
  });

  ctx.on('session/event', (session, event) => {
    const sessionId = session?.id;
    if (!validId(sessionId) || !roots.has(sessionId)) return;
    if (event?.type === 'turn/start') {
      enqueue(sessionId, async () => {
        await unlink(cueFile(sessionId)).catch((error) => { if (error.code !== 'ENOENT') throw error; });
        const dismissed = cueFile(sessionId).replace(/\.json$/, '.dismissed');
        await unlink(dismissed).catch((error) => { if (error.code !== 'ENOENT') throw error; });
      });
      return;
    }
    if (event?.type !== 'turn/end' || event.data?.reason?.kind !== 'completed') return;
    enqueue(sessionId, async () => {
      const cue = { schema: 1, client: 'deepseek-harness', session_id: sessionId, ended_at: new Date().toISOString(), reason: 'turn-completed' };
      await mkdir(cueDir, { recursive: true, mode: 0o700 });
      await writeFile(cueFile(sessionId), `${JSON.stringify(cue, null, 2)}\n`, { flag: 'wx', mode: 0o600 }).catch((error) => {
        if (error.code !== 'EEXIST') throw error;
      });
    });
  });

  ctx.on('agent/disposed', ({ agent }) => {
    const sessionId = agent?.session?.id;
    if (validId(sessionId)) roots.delete(sessionId);
  });
}

export function apply(ctx) {
  return installHarnessCueListeners(ctx, cueDir);
}
