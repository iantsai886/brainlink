import { spawn } from 'node:child_process';

const FORMATS = Object.freeze({ win32: new Set(['exe']), darwin: new Set(['pkg']), linux: new Set(['deb', 'tar.gz']) });

export function updateLaunchCommand(file, format, platform = process.platform) {
  if (!file || typeof file !== 'string') throw new Error('Verified update file is missing.');
  if (!FORMATS[platform]?.has(format)) throw new Error('This verified package cannot be opened by the current operating system.');
  if (platform === 'win32') return { command: file, args: [] };
  if (platform === 'darwin') return { command: 'open', args: [file] };
  return { command: 'xdg-open', args: [file] };
}

/** Open only a package already verified and held by BrainLink. OS install approval stays with the user. */
export function openUpdatePackage({ file, format, platform = process.platform, spawnImpl = spawn }) {
  const { command, args } = updateLaunchCommand(file, format, platform);
  return new Promise((resolve, reject) => {
    let settled = false;
    let child;
    try { child = spawnImpl(command, args, { detached: true, shell: false, stdio: 'ignore', windowsHide: true }); }
    catch { reject(new Error('BrainLink could not open the verified package. You can still download it and open it yourself.')); return; }
    child.once('error', () => {
      if (settled) return;
      settled = true;
      reject(new Error('BrainLink could not open the verified package. You can still download it and open it yourself.'));
    });
    child.once('spawn', () => {
      if (settled) return;
      settled = true;
      child.unref?.();
      resolve();
    });
  });
}
