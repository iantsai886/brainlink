import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const digest = (value) => createHash('sha256').update(String(value)).digest('hex');

export function createSessionSeenStore(home, { now = () => new Date() } = {}) {
  const fileFor = (connection, role) => path.join(home, 'session-seen', `${digest(`${connection}\0${role}`)}.json`);
  return {
    async get(connection, role) {
      try {
        const record = JSON.parse(await readFile(fileFor(connection, role), 'utf8'));
        return typeof record.last_seen === 'string' && Number.isFinite(Date.parse(record.last_seen)) ? record.last_seen : null;
      } catch { return null; }
    },
    async mark(connection, role) {
      const file = fileFor(connection, role);
      await mkdir(path.dirname(file), { recursive: true });
      const temp = `${file}.${process.pid}.${digest(`${now().getTime()}-${Math.random()}`).slice(0, 12)}.tmp`;
      await writeFile(temp, `${JSON.stringify({ last_seen: now().toISOString() })}\n`, { flag: 'wx', mode: 0o600 });
      await rename(temp, file);
      return now().toISOString();
    },
  };
}

export function sessionSeenIdentity(ctx, args = {}) {
  const role = args.role || ctx.agentRole || args.agent_or_role || (ctx.agents?.length === 1 ? ctx.agents[0].name : ctx.twinScope?.profile_id || 'connection');
  const connection = ctx.mcpAgent?.id || ctx.mcpAgent?.name || ctx.platform || args.ai_platform || 'local-client';
  return { connection: String(connection).slice(0, 160), role: String(role).slice(0, 160) };
}
