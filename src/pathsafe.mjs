// Windows-safe path containment: the one place every vault-guard (safeJoin, the snapshot writer's
// assertContainedForWrite, the 3D-graph in-place edit) asks "is this path inside that root?". NTFS
// and ReFS are case-preserving but case-INsensitive, so a naive `startsWith` check that works on
// Linux/macOS can both false-positive-refuse a legitimate path (differently-cased drive letter)
// and, more dangerously, false-negative-admit an escape if the two sides of the comparison happen
// to have been cased differently by whatever produced them (user input vs. realpath()'s answer).
// `os` is injected (default process.platform) purely so tests can exercise the win32 branch with
// path.win32-built strings on a Linux box; production call sites never pass it.
import nodePath from 'node:path';

// realpath()/fs can hand back a Windows long-path ("\\?\C:\...") or UNC ("\\?\UNC\server\share\...")
// prefix that a plain "C:\..." or "\\server\share\..." string from user input will never carry.
// Strip it before comparing so the exact same folder, reported two different ways, compares equal.
export function stripWinPrefix(p) {
  if (typeof p !== 'string') return p;
  if (p.startsWith('\\\\?\\UNC\\')) return '\\\\' + p.slice(8);
  if (p.startsWith('\\\\?\\')) return p.slice(4);
  return p;
}

function normalize(p, os) {
  const stripped = stripWinPrefix(p);
  const slashed = os === 'win32' ? stripped.replace(/\//g, '\\') : stripped;
  return os === 'win32' ? slashed.toLowerCase() : slashed;
}

// True when `candidate` is exactly `root`, or a path underneath it. Case-insensitive and
// separator/prefix-normalised on win32; case-sensitive elsewhere. Both inputs are expected to
// already be absolute and (where it matters) realpath'd -- this is a pure string comparison, it
// never touches the filesystem.
export function isWithin(root, candidate, os = process.platform, p = os === 'win32' ? nodePath.win32 : nodePath.posix) {
  const sepEsc = p.sep.replace(/\\/g, '\\\\');
  const r = normalize(root, os).replace(new RegExp(`${sepEsc}+$`), '');
  const c = normalize(candidate, os);
  return c === r || c.startsWith(r + p.sep);
}

export function samePath(a, b, os = process.platform) {
  return normalize(a, os) === normalize(b, os);
}
