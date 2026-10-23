// Safety net, not the fix itself: every test that touches appHome-backed state (snapshot
// manifests, session stores, activity logs, config.json) is expected to pass its own BRAINLINK_HOME
// in a temp dir. This preload (wired into `npm test` in package.json) catches the case where a
// test forgets and some code falls back to its default `env = process.env` -- appHome() would
// otherwise resolve to the real ~/.config/brainlink and leave files behind there (see the F2/N4
// test-hygiene item: this happened for real, from a test that passed `{}` instead of an env).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

if (!process.env.BRAINLINK_HOME) {
  process.env.BRAINLINK_HOME = mkdtempSync(path.join(tmpdir(), 'bl-test-apphome-'));
}
