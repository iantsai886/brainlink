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
    assert.match(source, /ui[\\/]app[\\/]test/, `${label} must exclude development UI tests from the package`);
  }
  const windowsPreview = await read('packaging/windows/build-portable-zip.sh');
  assert.match(windowsPreview, /skills/, 'Windows portable preview must ship versioned BrainLink skills');
  assert.match(windowsPreview, /ui[\\/]app[\\/]test/, 'Windows portable preview must exclude development UI tests');
  assert.ok(pkg.dependencies.yaml, 'YAML connector dependency must remain a production dependency');

  const windowsBuilder = await read('packaging/windows/build-windows.ps1');
  assert.match(windowsBuilder, /LOCALAPPDATA.*Inno Setup 6\\ISCC\.exe/, 'Windows builder must find a per-user Inno Setup installation');
  assert.match(windowsBuilder, /Inno Setup compiler failed with exit code/, 'Windows builder must report compiler failures');
  const windowsInstaller = await read('packaging/windows/BrainLink.iss');
  const installedWindowsSmoke = await read('scripts/smoke-installed-windows.ps1');
  const windowsLauncher = await read('packaging/windows/BrainLink.vbs');
  assert.match(pkg.scripts['smoke:installed:win'], /smoke-installed-windows\.ps1/, 'Windows installed-app acceptance must have a repeatable command');
  assert.match(windowsInstaller, /BRAINLINK_SMOKE_TEST/, 'the test build must use an isolated Inno Setup identity');
  assert.match(windowsInstaller, /BrainLink QA Smoke/, 'the test installer must use isolated product and shortcut names');
  assert.match(windowsInstaller, /^#define ProductStartupLauncher "BrainLink Background\.vbs"$/m, 'the production uninstaller must target the real startup launcher name');
  assert.match(windowsInstaller, /^#define ProductStartupLauncher "BrainLink QA Smoke Background\.vbs"$/m, 'the smoke installer must use its own startup launcher name');
  assert.match(installedWindowsSmoke, /TcpListener/, 'the installed-app smoke must use a port separate from a running BrainLink');
  assert.match(installedWindowsSmoke, /Join-Path \$TestRoot "BrainLink-QA-Smoke-Setup-\$Version\.exe"/, 'the smoke installer must live in its unique temporary directory');
  assert.match(installedWindowsSmoke, /"\/O\$TestRoot"/, 'the compiler must not overwrite a shared QA installer artifact');
  assert.match(installedWindowsSmoke, /setup-instance\.json/, 'the smoke must verify it started its own Setup process');
  assert.match(installedWindowsSmoke, /CreateShortcut\(\$StartMenuShortcut\)/, 'the smoke must read the installed Start menu shortcut settings');
  assert.match(installedWindowsSmoke, /Start-Process -FilePath \$shortcut\.TargetPath -ArgumentList \$shortcut\.Arguments/, 'the smoke must execute the installed Start menu shortcut target and arguments');
  assert.match(windowsLauncher, /BRAINLINK_SETUP_PORT/, 'the Windows shortcut launcher must support a controlled test port');
  assert.match(windowsLauncher, /BRAINLINK_NO_OPEN/, 'the Windows shortcut launcher must support headless verification');
  assert.match(installedWindowsSmoke, /setup-token/, 'the smoke must authenticate its local Setup UI check');
  assert.match(installedWindowsSmoke, /restored the prior PATH/, 'the smoke must verify uninstall restores PATH');
  assert.match(installedWindowsSmoke, /preserved the isolated user home/, 'the smoke must verify uninstall preserves user data');
  assert.match(windowsInstaller, /^#define ProductName "BrainLink"$/m, 'the production Inno installer should use the customer-facing product name');
  assert.match(windowsInstaller, /^#define ProductName "BrainLink QA Smoke"$/m, 'the isolated smoke build should have a separate name');
  assert.match(windowsInstaller, /^#define ProductShortcut "BrainLink"$/m, 'the production shortcut should keep its product name');
  assert.match(windowsInstaller, /^#define ProductShortcut "BrainLink QA Smoke"$/m, 'the smoke shortcut must not collide with the product shortcut');
  assert.match(windowsInstaller, /^AppName=\{#ProductName\}$/m, 'the Inno installer app name should use the selected production or smoke identity');
  assert.match(windowsInstaller, /CurUninstallStepChanged\(CurUninstallStep: TUninstallStep\)/, 'Windows uninstaller must clean up its PATH entry');
  assert.match(windowsInstaller, /SamePathEntry\(Segment, Target\)/, 'Windows PATH cleanup must remove only the BrainLink entry');
  assert.match(windowsInstaller, /RemoveBrainLinkStartupLauncher/, 'Windows uninstall must remove BrainLink-owned sign-in startup');
  assert.match(windowsInstaller, /BrainLink managed startup launcher v1/, 'Windows uninstall must check the ownership marker before deleting startup');
  assert.match(installedWindowsSmoke, /owned start-at-sign-in entry behind/, 'installed-app smoke must verify owned startup cleanup');
  assert.match(windowsInstaller, /\{autodesktop\}\\\{#ProductShortcut\}/, 'Windows install must add a desktop shortcut that opens Setup');
  assert.match(windowsInstaller, /Filename: "\{sys\}\\wscript\.exe"; Parameters: """\{app\}\\BrainLink\.vbs"""/, 'Windows desktop shortcut must use the quiet Setup launcher');
  const nsisInstaller = await read('packaging/windows/BrainLink.nsi');
  assert.match(nsisInstaller, /^Name "BrainLink \$\{VERSION\}"$/m, 'NSIS installer should use the customer-facing product name');
  assert.match(nsisInstaller, /DisplayName" "BrainLink"/, 'Windows uninstall list should use the customer-facing product name');
  assert.match(nsisInstaller, /CreateShortcut "\$DESKTOP\\BrainLink\.lnk"/, 'NSIS install must add the same desktop shortcut');
  assert.match(nsisInstaller, /Delete "\$DESKTOP\\BrainLink\.lnk"/, 'NSIS uninstall must remove the shortcut it created');

  const macZipTest = await read('packaging/macos/test-zip.sh');
  assert.match(await read('packaging/macos/resources/welcome.html'), /<h2[^>]*>BrainLink<\/h2>/, 'macOS installer should use the customer-facing product name');
  assert.match(await read('packaging/macos/resources/license.txt'), /^BrainLink — Pre-release Use Notice/, 'macOS license page should match the customer-facing product name');
  assert.match(macZipTest, /app\/src\/update-manifest\.mjs/, 'the macOS zip package must include the update verifier');
  assert.match(macZipTest, /app\/node_modules\/yaml\/dist\/index\.js/, 'the macOS package smoke test must check a loadable YAML runtime');
  assert.match(macZipTest, /app\/skills\/brainlink-session-closeout\/SKILL\.md/, 'the macOS package smoke test must check a shipped skill');
  assert.match(macZipTest, /app\/skills\/brainlink-graph-curation\/SKILL\.md/, 'the macOS package smoke test must check the graph-curation skill');
  assert.match(macZipTest, /app\/ui\/app\/test/, 'the macOS package smoke test must reject development UI tests');

  const workflow = await read('.github/workflows/ci.yml');
  const stagedSmoke = await read('scripts/smoke-staged-runtime.mjs');
  assert.match(stagedSmoke, /PRIVATE_CANARY_88420/, 'the staged runtime smoke must plant a private note canary');
  assert.match(stagedSmoke, /PUBLIC_CANARY_56381/, 'the staged runtime smoke must prove an allowed note is searchable');
  assert.match(stagedSmoke, /src\/connectors\.mjs/);
  assert.match(stagedSmoke, /src\/update-manifest\.mjs/);
  for (const skill of ['brainlink-cross-ai-handoff', 'brainlink-session-closeout', 'brainlink-graph-curation']) {
    assert.ok(stagedSmoke.includes(skill), `staged smoke must check ${skill}`);
  }
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
    assert.match(job, /smoke-staged-runtime\.mjs/, `${jobName} must run the packaged MCP/privacy smoke`);
  }
  assert.match(workflow, /Install, run and uninstall Windows package/, 'Windows CI must exercise install and uninstall');
  assert.match(workflow, /Smoke-test isolated Windows shortcut install and uninstall[\s\S]*?npm run smoke:installed:win/, 'Windows CI must run the isolated shortcut acceptance test');
  assert.match(workflow, /Installer did not create the BrainLink desktop shortcut/, 'Windows package smoke test must verify the installed desktop shortcut');
  assert.match(workflow, /Windows installer included development UI tests/, 'Windows package smoke test must reject development UI tests');
  assert.match(workflow, /Desktop shortcut does not open the BrainLink Setup launcher/, 'Windows package smoke test must verify what the shortcut opens');
  assert.match(workflow, /Uninstaller left the BrainLink desktop shortcut behind/, 'Windows package smoke test must verify shortcut cleanup');
  assert.match(workflow, /Install and smoke-test macOS package/, 'macOS CI must install and run the packaged app');
  assert.match(workflow, /test ! -e "\$app_root\/ui\/app\/test"/, 'macOS package smoke test must reject development UI tests');
  assert.match(workflow, /Remove macOS smoke-test installation/, 'macOS CI must clean up its installed package');
  assert.match(workflow, /test ! -e \/opt\/brainlink/, 'Linux CI must verify package removal');
  assert.match(workflow, /Verify Linux package checksums and runtime architectures/, 'Linux CI must check package digests and both runtime architectures');
  assert.match(workflow, /Install and smoke-test per-user Linux tarball/, 'Linux CI must exercise the no-root installer and its removal path');
  assert.match(workflow, /test ! -e \/opt\/brainlink\/app\/ui\/app\/test/, 'Linux package smoke test must reject development UI tests');
  assert.match(workflow, /test ! -e "\$bundle\/app\/ui\/app\/test"/, 'Linux tarball smoke test must reject development UI tests');
  assert.match(workflow, /test ! -e "\$XDG_DATA_HOME\/brainlink"/, 'Linux CI must verify tarball uninstall removes the application only');
});

test('the staged connector loads with the bundled YAML package outside the checkout', async () => {
  const stage = await mkdtemp(path.join(tmpdir(), 'brainlink-package-smoke-'));
  try {
    const app = path.join(stage, 'app');
    await mkdir(path.join(app, 'src'), { recursive: true });
    await mkdir(path.join(app, 'node_modules'), { recursive: true });
    await cp(path.join(ROOT, 'src', 'connectors.mjs'), path.join(app, 'src', 'connectors.mjs'));
    await cp(path.join(ROOT, 'src', 'app-home.mjs'), path.join(app, 'src', 'app-home.mjs'));
    await cp(path.join(ROOT, 'src', 'update-manifest.mjs'), path.join(app, 'src', 'update-manifest.mjs'));
    await cp(path.join(ROOT, 'node_modules', 'yaml'), path.join(app, 'node_modules', 'yaml'), { recursive: true });
    await writeFile(path.join(app, 'package.json'), '{"type":"module"}\n');
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', "const { detect } = await import('./src/connectors.mjs'); const { verifyUpdateManifest } = await import('./src/update-manifest.mjs'); if (typeof detect !== 'function' || typeof verifyUpdateManifest !== 'function') process.exit(2);"], {
      cwd: app, encoding: 'utf8', timeout: 10_000,
    });
    assert.equal(child.status, 0, `packaged import failed: ${child.stderr || child.error || child.stdout}`);
  } finally { await rm(stage, { recursive: true, force: true }); }
});
