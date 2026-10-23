// B2: Windows path containment. Every scenario here builds its strings with path.win32 and passes
// os='win32' explicitly, so it runs (and means something) on this Linux box without a real
// Windows filesystem -- isWithin() is a pure string comparison, no fs calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { isWithin, samePath, stripWinPrefix } from '../src/pathsafe.mjs';

const w = path.win32;

test('isWithin: win32 containment is case-insensitive (NTFS is case-preserving, not case-sensitive)', () => {
  assert.ok(isWithin('C:\\Users\\Ian\\Vault', 'c:\\users\\ian\\vault\\Sub\\Note.md', 'win32'));
  assert.ok(isWithin('c:\\vault', 'C:\\VAULT\\note.md', 'win32'));
  assert.ok(samePath('C:\\Vault', 'c:\\VAULT', 'win32'));
});

test('isWithin: win32 still refuses a sibling folder whose name merely starts with the root (no false containment)', () => {
  assert.ok(!isWithin('C:\\Vault', 'C:\\VaultEvil\\note.md', 'win32'));
  assert.ok(!isWithin('C:\\Vault', 'C:\\Vault2', 'win32'));
});

test('isWithin: win32 normalises forward slashes to backslashes before comparing', () => {
  assert.ok(isWithin('C:/Users/Ian/Vault', 'C:\\Users\\Ian\\Vault\\note.md', 'win32'));
  assert.ok(isWithin('C:\\Users\\Ian\\Vault', w.join('C:/Users/Ian/Vault', 'sub', 'note.md'), 'win32'));
});

test('isWithin: win32 drive-root with and without a trailing backslash compare the same', () => {
  assert.ok(isWithin('C:\\', 'C:\\Vault\\note.md', 'win32'));
  assert.ok(isWithin('C:\\Vault\\', 'C:\\Vault\\note.md', 'win32'));
});

test('isWithin: win32 strips the \\\\?\\ long-path prefix before comparing', () => {
  assert.ok(isWithin('\\\\?\\C:\\Users\\Ian\\Vault', 'C:\\Users\\Ian\\Vault\\note.md', 'win32'));
  assert.ok(isWithin('C:\\Users\\Ian\\Vault', '\\\\?\\C:\\Users\\Ian\\Vault\\note.md', 'win32'));
});

test('isWithin: win32 strips the \\\\?\\UNC\\ prefix and matches the equivalent \\\\server\\share path', () => {
  const unc = '\\\\?\\UNC\\fileserver\\notes\\Vault';
  assert.strictEqual(stripWinPrefix(unc), '\\\\fileserver\\notes\\Vault');
  assert.ok(isWithin('\\\\fileserver\\notes\\Vault', unc + '\\note.md', 'win32'));
});

test('isWithin: UNC root itself is contained correctly (no false escape across two share roots)', () => {
  assert.ok(isWithin('\\\\fileserver\\notes\\Vault', '\\\\fileserver\\notes\\Vault\\sub\\note.md', 'win32'));
  assert.ok(!isWithin('\\\\fileserver\\notes\\Vault', '\\\\fileserver\\notes\\VaultOther\\note.md', 'win32'));
});

test('isWithin: posix stays case-sensitive (no regression from the win32 branch)', () => {
  assert.ok(isWithin('/home/ian/vault', '/home/ian/vault/note.md', 'linux'));
  assert.ok(!isWithin('/home/ian/vault', '/home/ian/Vault/note.md', 'linux'));
  assert.ok(!isWithin('/home/ian/vault', '/home/ian/vaultEvil/note.md', 'linux'));
});

test('isWithin: darwin stays case-sensitive by default, matching posix', () => {
  assert.ok(isWithin('/Users/ian/Vault', '/Users/ian/Vault/note.md', 'darwin'));
  assert.ok(!isWithin('/Users/ian/Vault', '/Users/ian/vault/note.md', 'darwin'));
});

test('isWithin: a path equal to the root is contained (not just strict descendants)', () => {
  assert.ok(isWithin('C:\\Vault', 'C:\\Vault', 'win32'));
  assert.ok(isWithin('C:\\Vault', 'c:\\VAULT', 'win32'));
});
