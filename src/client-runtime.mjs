import { stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';

function readWindowsClaudeStartTimes() {
  return new Promise((resolve, reject) => {
    const script = "Get-Process -Name Claude -ErrorAction SilentlyContinue | ForEach-Object { $_.StartTime.ToUniversalTime().ToString('o') }";
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      timeout: 2500, windowsHide: true, maxBuffer: 4096,
    }, (error, stdout) => {
      if (error) return reject(error);
      resolve(String(stdout || '').split(/\r?\n/).map((value) => value.trim()).filter(Boolean));
    });
  });
}

export function compareClientStartToConfig(processStartTimes, configMtimeMs) {
  const starts = processStartTimes.map((value) => new Date(value).getTime()).filter(Number.isFinite);
  if (!starts.length || !Number.isFinite(configMtimeMs)) return { status: 'unknown', started_before_config: null };
  return {
    status: 'running',
    started_before_config: Math.min(...starts) < configMtimeMs,
  };
}

// Windows only for now. The result is a hint: some clients can reload MCP settings while open.
export async function inspectClaudeDesktopRuntime({ os, configPath, readStartTimes = readWindowsClaudeStartTimes }) {
  if (os !== 'win32') return { status: 'unknown', started_before_config: null };
  const configStat = await stat(configPath).catch(() => null);
  if (!configStat) return { status: 'unknown', started_before_config: null };
  try {
    const starts = await readStartTimes();
    if (starts.length === 0) return { status: 'not_running', started_before_config: null };
    return compareClientStartToConfig(starts, configStat.mtimeMs);
  } catch {
    return { status: 'unknown', started_before_config: null };
  }
}
