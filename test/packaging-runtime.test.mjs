import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFile(path.join(ROOT, rel), 'utf8');

test('every native installer bundles all production dependencies and portable BrainLink skills', async () => {
  const pkg = JSON.parse(await read('package.json'));
  const builders = [
    ['Windows NSIS', 'packaging/windows/build-windows.sh'],
    ['Windows Inno Setup', 'packaging/windows/build-windows.ps1'],
    ['macOS installer', 'packaging/macos/build-pkg.sh'],
    ['macOS zip app', 'packaging/macos/build-zip.sh'],
    ['Linux tar and deb', 'packaging/linux/build-linux.sh'],
  ];
  for (const [label, file] of builders) {
    const source = await read(file);
    assert.match(source, /skills/, `${label} must ship the versioned SKILL.md files`);
    assert.match(source, /yaml/, `${label} must bundle the YAML runtime dependency`);
    assert.match(source, /brainlink-store/, `${label} must bundle the local store dependency`);
  }
  assert.ok(pkg.dependencies.yaml, 'YAML connector dependency must remain a production dependency');

  const windowsBuilder = await read('packaging/windows/build-windows.ps1');
  assert.match(windowsBuilder, /LOCALAPPDATA.*Inno Setup 6\\ISCC\.exe/, 'Windows builder must find a per-user Inno Setup installation');
  assert.match(windowsBuilder, /Inno Setup compiler failed with exit code/, 'Windows builder must report compiler failures');
  const windowsInstaller = await read('packaging/windows/BrainLink.iss');
  assert.match(windowsInstaller, /CurUninstallStepChanged\(CurUninstallStep: TUninstallStep\)/, 'Windows uninstaller must clean up its PATH entry');
  assert.match(windowsInstaller, /SamePathEntry\(Segment, Target\)/, 'Windows PATH cleanup must remove only the BrainLink entry');

  const macZipTest = await read('packaging/macos/test-zip.sh');
  assert.match(macZipTest, /app\/node_modules\/yaml\/dist\/index\.js/, 'the macOS package smoke test must check a loadable YAML runtime');
  assert.match(macZipTest, /app\/skills\/brainlink-session-closeout\/SKILL\.md/, 'the macOS package smoke test must check a shipped skill');

  const workflow = await read('.github/workflows/ci.yml');
  const packageJobs = ['windows-package:', 'macos-package:', 'linux-package:'];
  for (const jobName of packageJobs) {
    const jobStart = workflow.indexOf(`  ${jobName}`);
    assert.notEqual(jobStart, -1, `CI workflow must include ${jobName}`);
    const nextJob = packageJobs
      .filter((candidate) => candidate !== jobName)
      .map((candidate) => workflow.indexOf(`\n  ${candidate}`, jobStart + 2))
      .filter((index) => index !== -1)
      .sort((a, b) => a - b)[0] ?? -1;
    const job = workflow.slice(jobStart, nextJob === -1 ? undefined : nextJob);
    assert.match(job, /npm ci --omit=dev/, `${jobName} must install production runtime dependencies before building`);
    assert.match(job, /skills\/brainlink-session-closeout\/SKILL\.md/, `${jobName} must smoke-test the packaged Agent Skill`);
    assert.match(job, /connectors\.mjs/, `${jobName} must smoke-test the packaged YAML connector runtime`);
  }
  assert.match(workflow, /Install, run and uninstall Windows package/, 'Windows CI must exercise install and uninstall');
  assert.match(workflow, /Install and smoke-test macOS package/, 'macOS CI must install and run the packaged app');
  assert.match(workflow, /Remove macOS smoke-test installation/, 'macOS CI must clean up its installed package');
  assert.match(workflow, /test ! -e \/opt\/brainlink/, 'Linux CI must verify package removal');
});

test('the staged connector loads with the bundled YAML package outside the checkout', async () => {
  const stage = await mkdtemp(path.join(tmpdir(), 'brainlink-package-smoke-'));
  try {
    const app = path.join(stage, 'app');
    await mkdir(path.join(app, 'src'), { recursive: true });
    await mkdir(path.join(app, 'node_modules'), { recursive: true });
    await cp(path.join(ROOT, 'src', 'connectors.mjs'), path.join(app, 'src', 'connectors.mjs'));
    await cp(path.join(ROOT, 'node_modules', 'yaml'), path.join(app, 'node_modules', 'yaml'), { recursive: true });
    await writeFile(path.join(app, 'package.json'), '{"type":"module"}\n');
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', "const { detect } = await import('./src/connectors.mjs'); if (typeof detect !== 'function') process.exit(2);"], {
      cwd: app, encoding: 'utf8', timeout: 10_000,
    });
    assert.equal(child.status, 0, `packaged import failed: ${child.stderr || child.error || child.stdout}`);
  } finally { await rm(stage, { recursive: true, force: true }); }
});
