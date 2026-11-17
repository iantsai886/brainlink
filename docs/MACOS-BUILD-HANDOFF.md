# Build the macOS installer

The latest source is pushed to `origin/codex/complete-review-work-order`. On the MacBook, from a terminal in the BrainLink repository:

```sh
git fetch origin
git switch --track origin/codex/complete-review-work-order
git rev-parse --short HEAD
npm ci
npm run test:all
npm run build:mac
version="$(node -p "require('./package.json').version")"
(cd dist && shasum -a 256 -c "BrainLink-$version.pkg.sha256")
```

If that branch already exists locally, use `git switch codex/complete-review-work-order` followed by `git pull --ff-only` instead of the `git switch --track` line.

The script verifies checksums for the pinned universal Node runtime and creates `dist/BrainLink-1.3.8.pkg` plus its SHA-256 file. It requires native macOS tools including `lipo`, `pkgbuild`, `productbuild`, and `codesign`, supplied with Xcode Command Line Tools. `npm run test:all` runs both core and UI suites before packaging.

After building, verify the package contents and bundled runtime without installing it:

```sh
version="$(node -p "require('./package.json').version")"
pkgutil --expand-full "dist/BrainLink-$version.pkg" "$TMPDIR/brainlink-pkg"
app="$(find "$TMPDIR/brainlink-pkg" -path '*/BrainLink.app/Contents/Resources/app/bin/brainlink.mjs' -print -quit)"
test -n "$app"
resources="${app%/app/bin/brainlink.mjs}"
test "$("$resources/node/bin/node" "$app" --version)" = "$version"
app_root="${app%/bin/brainlink.mjs}"
test ! -e "$app_root/ui/app/test"
"$resources/node/bin/node" scripts/smoke-staged-runtime.mjs --node "$resources/node/bin/node" --app "$app_root" --version "$version"
```

The default build is unsigned/ad-hoc signed; follow [INSTALL-UNSIGNED.md](../packaging/macos/INSTALL-UNSIGNED.md) to install it through Gatekeeper. A Developer ID signed and notarized build requires the configured Apple signing identities and notarization profile; do not put those credentials in Git or chat. Installing the package replaces `/Applications/BrainLink.app` and installs the `/usr/local/bin/brainlink` link, so review that before running the installer on a Mac already in use.

GitHub Actions did not run on this commit because the repository account is blocked by a billing/spending-limit check. The Mac build must therefore be run locally unless that account condition is resolved. A local build does not replace verification by installing and launching the package on the target Mac.
