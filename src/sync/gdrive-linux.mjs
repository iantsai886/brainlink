// Linux Google Drive guidance. BrainLink never authenticates to Google itself: rclone (or
// another user-selected client) owns the account and exposes the selected folder locally.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const ID_RE = /^[A-Za-z0-9_-]{10,256}$/;
const REMOTE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

export function normalizeDriveSelection(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Drive selection must be an object.');
  const remote = String(raw.remote || '').trim();
  const root_folder_id = String(raw.root_folder_id || raw.folder_id || '').trim();
  const parent_folder_id = String(raw.parent_folder_id || '').trim();
  const folder_name = String(raw.folder_name || '').trim();
  const mount_path = raw.mount_path == null || raw.mount_path === '' ? null : String(raw.mount_path).trim();
  if (remote && !REMOTE_RE.test(remote)) throw new Error('Drive remote name must use letters, numbers, hyphens or underscores.');
  if (root_folder_id && !ID_RE.test(root_folder_id)) throw new Error('Drive folder ID is not valid.');
  if (parent_folder_id && !ID_RE.test(parent_folder_id)) throw new Error('Drive parent folder ID is not valid.');
  if (mount_path && !path.isAbsolute(mount_path)) throw new Error('Drive mount path must be absolute.');
  if (!remote && !root_folder_id && !parent_folder_id && !folder_name && !mount_path) return null;
  return {
    provider: 'gdrive',
    ...(remote ? { remote } : {}),
    ...(root_folder_id ? { root_folder_id } : {}),
    ...(parent_folder_id ? { parent_folder_id } : {}),
    ...(folder_name ? { folder_name } : {}),
    ...(mount_path ? { mount_path } : {}),
  };
}

function executable(candidate) {
  if (!candidate) return null;
  try { return existsSync(candidate) ? candidate : null; } catch { return null; }
}

export function findRclone({ home = homedir(), env = process.env, which = execFileSync } = {}) {
  const explicit = executable(env.BRAINLINK_RCLONE);
  if (explicit) return explicit;
  const local = executable(path.join(home, '.local', 'bin', 'rclone'));
  if (local) return local;
  try {
    const found = String(which('which', ['rclone'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })).trim();
    return executable(found);
  } catch { return null; }
}

export function linuxDriveSetup({ home = homedir(), os = process.platform, env = process.env, sync = {} } = {}) {
  const selection = normalizeDriveSelection(sync.drive);
  const configPath = env.RCLONE_CONFIG || path.join(home, '.config', 'rclone', 'rclone.conf');
  const rclone = os === 'linux' ? findRclone({ home, env }) : null;
  const localPath = selection?.mount_path || (sync.provider === 'gdrive' ? sync.folder : null);
  const localExists = Boolean(localPath && existsSync(localPath));
  const remote = selection?.remote || 'brainlink-gdrive';
  const mountPath = localPath || path.join(home, '.local', 'share', 'brainlink', 'mounts', selection?.folder_name?.toLowerCase() || 'drive');
  const folderId = selection?.root_folder_id || '';
  const commands = {
    install: 'sudo pacman -S rclone fuse3',
    authenticate: `rclone config create ${shellQuote(remote)} drive`,
    restrict: folderId ? `rclone config update ${shellQuote(remote)} root_folder_id=${shellQuote(folderId)}` : `rclone config update ${shellQuote(remote)} root_folder_id=<DRIVE_FOLDER_ID>`,
    mount: `rclone mount ${shellQuote(remote)}: ${shellQuote(mountPath)} --vfs-cache-mode full`,
  };
  return {
    supported: os === 'linux',
    selected: selection,
    rclone: { available: Boolean(rclone), path: rclone, config_path: configPath, configured: existsSync(configPath) },
    local: { path: localPath, exists: localExists },
    commands,
    message: os !== 'linux'
      ? 'Use the native Google Drive client for this operating system, then select its local folder.'
      : rclone
        ? (localExists ? 'rclone is available and the selected local folder exists.' : 'rclone is available; authenticate it and mount the selected Drive folder locally.')
        : 'Install rclone (or another Google Drive filesystem client), authorize it, then select the mounted folder.',
  };
}
