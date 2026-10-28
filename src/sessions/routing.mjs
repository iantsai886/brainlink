// Reuse only a destination the user explicitly chose for this exact project identifier.
// Never infer a vault from a title, summary, keywords, or filesystem proximity.
export function recommendSessionVault(session, cfg) {
  const project = String(session?.project || '').trim();
  if (!project) return { vault: null, reason: 'This session has no project identifier.' };
  if (project.length > 1024) return { vault: null, reason: 'This project identifier is too long to use for a saved destination.' };
  const configured = cfg.session_filing?.projectVaults?.[project];
  if (!configured) return { vault: null, reason: 'No saved destination exists for this project.' };
  const vault = (cfg.vaults || []).find((candidate) => candidate.name === configured && candidate.writes !== 'off');
  if (!vault) return { vault: null, reason: 'The saved destination is unavailable or read-only; choose a destination manually.' };
  return { vault: vault.name, reason: 'Suggested from your saved choice for this exact project.' };
}

// Automatic closeout is allowed only when the user saved both an exact-project vault and folder.
// Similar project names, content guesses, and intake fallbacks are deliberately not used here.
export function exactSessionFilingDestination(session, cfg) {
  const project = String(session?.project || '').trim();
  if (!project || project.length > 1024) return null;
  const route = cfg.session_filing?.projectFolders?.[project];
  const expectedVault = cfg.session_filing?.projectVaults?.[project];
  if (!route || typeof route !== 'object' || !route.vault || route.vault !== expectedVault || typeof route.folder !== 'string') return null;
  const vault = (cfg.vaults || []).find((candidate) => candidate.name === route.vault && candidate.writes === 'on');
  if (!vault) return null;
  return { vault: vault.name, folder: route.folder };
}
