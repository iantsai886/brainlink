import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { openInAppWindow } from '../src/setup.mjs';

test('Windows desktop launch opens the local Setup page in an Edge app window', () => {
  const calls = [];
  const env = { 'ProgramFiles(x86)': 'C:\\Program Files (x86)' };
  const result = openInAppWindow('http://127.0.0.1:4312/?t=local-token', {
    os: 'win32', env,
    exists: (file) => file === path.join(env['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    run: (...args) => { calls.push(args); return { unref() {} }; },
  });
  assert.deepEqual(result, { mode: 'app', browser: 'edge' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], path.join(env['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  assert.deepEqual(calls[0][1], ['--app=http://127.0.0.1:4312/?t=local-token']);
});

test('Windows desktop launch falls back to the default browser when Edge is missing', () => {
  const calls = [];
  const result = openInAppWindow('http://127.0.0.1:4312/?t=local-token', {
    os: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\demo\\AppData\\Local' },
    exists: () => false,
    run: (...args) => { calls.push(args); },
  });
  assert.deepEqual(result, { mode: 'browser', browser: 'default' });
  assert.deepEqual(calls, [['cmd', ['/c', 'start', '', 'http://127.0.0.1:4312/?t=local-token']]]);
});

test('Windows desktop launch uses Chrome app mode when Edge is not installed', () => {
  const calls = [];
  const env = { ProgramFiles: 'C:\\Program Files' };
  const chrome = path.win32.join(env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe');
  const result = openInAppWindow('http://127.0.0.1:4312/?t=local-token', {
    os: 'win32', env, exists: (file) => file === chrome,
    run: (...args) => { calls.push(args); return { unref() {} }; },
  });
  assert.deepEqual(result, { mode: 'app', browser: 'chrome' });
  assert.deepEqual(calls[0].slice(0, 2), [chrome, ['--app=http://127.0.0.1:4312/?t=local-token']]);
});

test('Edge app mode is restricted to a loopback Setup URL', () => {
  const calls = [];
  const result = openInAppWindow('https://example.com/?t=should-not-be-forwarded', {
    os: 'win32', env: { ProgramFiles: 'C:\\Program Files' },
    exists: () => true,
    run: (...args) => { calls.push(args); },
  });
  assert.deepEqual(result, { mode: 'browser', browser: 'default' });
  assert.deepEqual(calls, [['cmd', ['/c', 'start', '', 'https://example.com/?t=should-not-be-forwarded']]]);
});

test('macOS desktop launch opens a Chrome app window from the user Applications folder', () => {
  const calls = [];
  const env = { HOME: '/Users/demo' };
  const chrome = path.posix.join(env.HOME, 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome');
  const result = openInAppWindow('http://127.0.0.1:4312/?t=local-token', {
    os: 'darwin', env, exists: (file) => file === chrome,
    run: (...args) => { calls.push(args); return { unref() {} }; },
  });
  assert.deepEqual(result, { mode: 'app', browser: 'chrome' });
  assert.deepEqual(calls[0].slice(0, 2), [chrome, ['--app=http://127.0.0.1:4312/?t=local-token']]);
});

test('Linux desktop launch uses the first supported Chromium browser found on PATH', () => {
  const calls = [];
  const env = { PATH: '/usr/bin:/usr/local/bin' };
  const chromium = '/usr/bin/chromium';
  const result = openInAppWindow('http://127.0.0.1:4312/?t=local-token', {
    os: 'linux', env, exists: (file) => file === chromium,
    run: (...args) => { calls.push(args); return { unref() {} }; },
  });
  assert.deepEqual(result, { mode: 'app', browser: 'chromium' });
  assert.deepEqual(calls[0].slice(0, 2), [chromium, ['--app=http://127.0.0.1:4312/?t=local-token']]);
});

test('macOS desktop launch falls back to its normal browser if no app browser is installed', () => {
  const calls = [];
  const result = openInAppWindow('http://127.0.0.1:4312/?t=local-token', {
    os: 'darwin', env: { HOME: '/Users/demo' }, exists: () => false,
    run: (...args) => { calls.push(args); },
  });
  assert.deepEqual(result, { mode: 'browser', browser: 'default' });
  assert.deepEqual(calls, [['open', ['http://127.0.0.1:4312/?t=local-token']]]);
});

test('non-loopback macOS URLs never use browser app mode', () => {
  const calls = [];
  const result = openInAppWindow('https://example.com', {
    os: 'darwin', env: { HOME: '/Users/demo' }, exists: () => true,
    run: (...args) => { calls.push(args); },
  });
  assert.deepEqual(result, { mode: 'browser', browser: 'default' });
  assert.deepEqual(calls, [['open', ['https://example.com']]]);
});
