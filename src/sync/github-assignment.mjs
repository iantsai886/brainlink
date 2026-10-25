// Profile-scoped GitHub repository assignment: a user-confirmed binding of one Twin profile to one
// GitHub repository identity, one local clone, one vault and an optional folder allowlist.
// Pure config logic (no filesystem or Git access) so config validation and every GitHub operation
// apply the same rules. A missing, malformed, or shared assignment fails closed.
import path from 'node:path';

export const GITHUB_ASSIGNMENT_KEYS = ['remote', 'path', 'vault', 'folders', 'whole_vault', 'confirmed_at'];
const REMOTE_ID = /^[a-z0-9_.-]{1,100}\/[a-z0-9_.-]{1,100}$/;
const MAX_FOLDERS = 50;

// "owner/repo" (lowercase) for a GitHub origin that carries no credentials, otherwise null.
export function githubRemoteIdentity(remote) {
  if (typeof remote !== 'string' || !remote || /[\r\n]/.test(remote)) return null;
  const scp = /^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(remote);
  if (scp) return `${scp[1]}/${scp[2]}`.toLowerCase();
  try {
    const u = new URL(remote);
    if (u.hostname.toLowerCase() !== 'github.com' || u.username || u.password || u.search || u.hash || (u.port && u.port !== '443')) return null;
    if (!['https:', 'ssh:'].includes(u.protocol)) return null;
    if (u.protocol === 'ssh:' && u.username !== 'git') return null;
    const m = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(u.pathname);
    return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
  } catch { return null; }
}

export function safeFolderPrefix(value) {
  if (typeof value !== 'string' || !value || value.length > 300 || /[\\:\x00-\x1f]/.test(value)) return false;
  return value.split('/').every((p) => p && p !== '.' && p !== '..' && !p.startsWith('.'));
}

const pathKey = (value) => path.resolve(value).toLowerCase();

export function profileList(cfg) { return Array.isArray(cfg?.twin_profiles) ? cfg.twin_profiles : []; }

// Errors for one profile's assignment (empty when it has none).
export function assignmentErrors(cfg, profile) {
  const a = profile?.github_repository;
  if (a === undefined || a === null) return [];
  const id = profile?.id || '';
  const bad = (why) => `twin profile "${id}": github_repository ${why}`;
  if (typeof a !== 'object' || Array.isArray(a)) return [bad('must be an object')];
  const errors = [];
  if (Object.keys(a).some((key) => !GITHUB_ASSIGNMENT_KEYS.includes(key))) errors.push(bad('contains unsupported fields; credentials and URLs are never stored'));
  if (typeof a.remote !== 'string' || !REMOTE_ID.test(a.remote) || a.remote.endsWith('.git')) errors.push(bad('remote must be a lowercase owner/repo identity'));
  if (typeof a.path !== 'string' || !a.path || a.path.length > 1024 || /\x00/.test(a.path) || !path.isAbsolute(a.path)) errors.push(bad('path must be an absolute local clone path'));
  const vaults = Array.isArray(profile.vaults) ? profile.vaults : [];
  const vault = (cfg.vaults || []).find((v) => v.name === a.vault);
  if (typeof a.vault !== 'string' || !vaults.some((v) => v?.name === a.vault) || !vault) errors.push(bad('vault must be one of this profile\'s configured vaults'));
  else if (vault.private) errors.push(bad('vault is private and cannot be published'));
  else if (profileList(cfg).some((other) => other !== profile && Array.isArray(other?.vaults) && other.vaults.some((v) => v?.name === a.vault))) errors.push(bad('vault is also declared by another profile, so its owner is ambiguous'));
  if (a.folders !== undefined) {
    if (!Array.isArray(a.folders) || a.folders.length > MAX_FOLDERS || a.folders.some((f) => !safeFolderPrefix(f)) || new Set(a.folders).size !== a.folders.length) errors.push(bad('folders must be a short list of distinct safe vault-relative folders'));
  }
  const hasFolders = Array.isArray(a.folders) && a.folders.length > 0;
  if (typeof a.whole_vault !== 'boolean' || (hasFolders && a.whole_vault) || (!hasFolders && !a.whole_vault)) errors.push(bad('must explicitly confirm the whole vault or select one or more folders'));
  if (typeof a.confirmed_at !== 'string' || Number.isNaN(Date.parse(a.confirmed_at))) errors.push(bad('needs a confirmed_at timestamp from the user confirmation'));
  return errors;
}

// Cross-profile rules: one repository identity or clone path serves exactly one profile.
export function assignmentCollisionErrors(cfg) {
  const errors = [];
  const remotes = new Map();
  const paths = new Map();
  for (const profile of profileList(cfg)) {
    const a = profile?.github_repository;
    if (!a || typeof a !== 'object') continue;
    if (typeof a.remote === 'string') {
      if (remotes.has(a.remote.toLowerCase())) errors.push('a GitHub repository may be assigned to only one Twin profile');
      remotes.set(a.remote.toLowerCase(), profile.id);
    }
    if (typeof a.path === 'string' && a.path) {
      const key = pathKey(a.path);
      if (paths.has(key)) errors.push('a local repository clone may be assigned to only one Twin profile');
      paths.set(key, profile.id);
    }
  }
  return errors;
}

export function validateGitHubAssignments(cfg) {
  return [...profileList(cfg).flatMap((profile) => assignmentErrors(cfg, profile)), ...assignmentCollisionErrors(cfg)];
}

export function noteInScope(assignment, rel) {
  const folders = assignment?.folders;
  if (assignment?.whole_vault === true) return true;
  if (!Array.isArray(folders) || !folders.length) return false;
  return folders.some((folder) => rel.startsWith(`${folder}/`));
}

// Resolve the assignment an operation may use. Throws a generic error, never echoing another
// profile's data. GitHub sharing is unavailable until an owner and repository are explicit.
export function resolveGitHubScope(cfg, { profileId, vaultName }) {
  const profiles = profileList(cfg);
  if (!profiles.length) throw new Error('Create a Personal, Organisation, or Client Twin profile and confirm its GitHub repository before sharing notes.');
  if (!profileId || typeof profileId !== 'string') throw new Error('Choose a Twin profile before using GitHub sharing.');
  const profile = profiles.find((item) => item.id === profileId);
  if (!profile) throw new Error('Choose an existing Twin profile.');
  const assignment = profile.github_repository;
  if (!assignment) throw new Error('This profile has no confirmed GitHub repository. Review and confirm an assignment first.');
  if (assignmentErrors(cfg, profile).length || assignmentCollisionErrors(cfg).length) throw new Error('This profile\'s GitHub repository assignment is invalid. Review and confirm it again.');
  if (vaultName !== assignment.vault) throw new Error('This vault is not assigned to the selected profile\'s GitHub repository.');
  return { legacy: false, profile, assignment };
}

// What the Setup UI shows: the user's own declarations only, never tokens or URLs.
export function githubAssignmentProjection(cfg) {
  return profileList(cfg).map((profile) => {
    const a = profile.github_repository || null;
    return {
      profile_id: profile.id, name: profile.name, mode: profile.mode,
      vaults: (profile.vaults || []).map((v) => v.name),
      assignment: a ? { remote: a.remote, path: a.path, vault: a.vault, folders: [...(a.folders || [])], whole_vault: a.whole_vault === true, confirmed_at: a.confirmed_at } : null,
      status: a ? (assignmentErrors(cfg, profile).length ? 'invalid' : 'assigned') : 'unassigned',
    };
  });
}
