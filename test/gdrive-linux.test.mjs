import test from 'node:test';
import assert from 'node:assert/strict';
import { linuxDriveSetup, normalizeDriveSelection, findRclone } from '../src/sync/gdrive-linux.mjs';

test('Drive selection keeps the exact folder and parent IDs without credentials', () => {
  assert.deepEqual(normalizeDriveSelection({ remote: 'brainlink-gdrive', root_folder_id: '1aU-XR6fHW8czFwpAn0GGEh500HkZ13-d', parent_folder_id: '1IIE8k10Q04SIz8RrrMloPaSXDPuYv_5L', folder_name: 'Brain', mount_path: '/home/ian/Brain' }), {
    provider: 'gdrive', remote: 'brainlink-gdrive', root_folder_id: '1aU-XR6fHW8czFwpAn0GGEh500HkZ13-d', parent_folder_id: '1IIE8k10Q04SIz8RrrMloPaSXDPuYv_5L', folder_name: 'Brain', mount_path: '/home/ian/Brain',
  });
});

test('Drive selection rejects relative mount paths and malformed IDs', () => {
  assert.throws(() => normalizeDriveSelection({ root_folder_id: 'bad' }), /folder ID/);
  assert.throws(() => normalizeDriveSelection({ mount_path: 'relative/drive' }), /absolute/);
});

test('rclone discovery prefers the explicit user-local binary', () => {
  assert.equal(findRclone({ home: '/tmp/brainlink-test-home', env: { BRAINLINK_RCLONE: process.execPath } }), process.execPath);
});

test('Linux Drive setup exposes safe, actionable commands', () => {
  const result = linuxDriveSetup({ home: '/home/ian', os: 'linux', env: { BRAINLINK_RCLONE: process.execPath }, sync: { provider: 'local', drive: { remote: 'brainlink-gdrive', root_folder_id: '1aU-XR6fHW8czFwpAn0GGEh500HkZ13-d', folder_name: 'Brain', mount_path: '/home/ian/Brain' } } });
  assert.equal(result.supported, true);
  assert.match(result.commands.restrict, /1aU-XR6fHW8czFwpAn0GGEh500HkZ13-d/);
  assert.doesNotMatch(JSON.stringify(result), /access_token|refresh_token|secret/i);
});
