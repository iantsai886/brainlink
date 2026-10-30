import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Windows upgrade smoke uses the real 1.2.7 tag and an isolated QA installer identity', async () => {
  const [manifest, script] = await Promise.all([
    readFile(new URL('../package.json', import.meta.url), 'utf8').then(JSON.parse),
    readFile(new URL('../scripts/smoke-upgrade-windows.ps1', import.meta.url), 'utf8'),
  ]);
  assert.equal(manifest.scripts['smoke:upgrade:win'], 'pwsh -NoProfile -File scripts/smoke-upgrade-windows.ps1');
  assert.match(script, /param\(\[string\]\$FromTag = 'v1\.2\.7',/);
  assert.match(script, /worktree add --detach/);
  assert.match(script, /D4A160C8-6D2C-4F44-9D35-8D10A92F7B31/);
  assert.doesNotMatch(script, /6F2B8E4C-9A51-4C1E-B7D3-2B1A9E5C7F40/, 'the QA run must not register as the production app');
  assert.match(script, /upgrade-canary\.json/);
  assert.match(script, /Start-IsolatedApp \$OldVersion/);
  assert.match(script, /Start-IsolatedApp \$CurrentVersion/);
  assert.match(script, /Start-Process -FilePath \$nodeExe/);
  assert.doesNotMatch(script, /Start-Process -FilePath \$shortcut\.TargetPath/);
  assert.match(script, /Remove-Item -LiteralPath \$tempFull -Recurse -Force/);
});
