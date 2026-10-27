import { homedir } from 'node:os';
import path from 'node:path';

// Resolve BrainLink's per-user data folder without loading the full configuration layer.
export function appHome(env = process.env, platform = process.platform, home = homedir()) {
  if (env.BRAINLINK_HOME) return env.BRAINLINK_HOME;
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'BrainLink');
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'BrainLink');
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'brainlink');
}
