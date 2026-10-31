import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { openUpdatePackage, updateLaunchCommand } from '../src/update-launcher.mjs';

test('update package launcher uses fixed OS commands without a shell', async () => {
  const file = 'C:/BrainLink Updates/BrainLink 1.2.9.exe';
  assert.deepEqual(updateLaunchCommand(file, 'exe', 'win32'), { command: file, args: [] });
  assert.deepEqual(updateLaunchCommand('/tmp/BrainLink.pkg', 'pkg', 'darwin'), { command: 'open', args: ['/tmp/BrainLink.pkg'] });
  assert.deepEqual(updateLaunchCommand('/tmp/brainlink.deb', 'deb', 'linux'), { command: 'xdg-open', args: ['/tmp/brainlink.deb'] });
  assert.deepEqual(updateLaunchCommand('/tmp/brainlink.tar.gz', 'tar.gz', 'linux'), { command: 'xdg-open', args: ['/tmp/brainlink.tar.gz'] });
  assert.throws(() => updateLaunchCommand('/tmp/untrusted.sh', 'sh', 'linux'), /cannot be opened/);

  let call;
  await openUpdatePackage({ file, format: 'exe', platform: 'win32', spawnImpl: (...args) => {
    call = args;
    const child = new EventEmitter();
    child.unref = () => { child.unrefCalled = true; };
    queueMicrotask(() => child.emit('spawn'));
    return child;
  } });
  assert.equal(call[0], file);
  assert.deepEqual(call[1], []);
  assert.equal(call[2].shell, false);
  assert.equal(call[2].detached, true);
  assert.equal(call[2].windowsHide, true);
});

test('update package launcher reports OS launch errors in plain language', async () => {
  await assert.rejects(openUpdatePackage({ file: '/tmp/brainlink.deb', format: 'deb', platform: 'linux', spawnImpl: () => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('error', new Error('fixture')));
    return child;
  } }), /You can still download it and open it yourself/);
});
