# Build the macOS installer

The latest source is pushed to `origin/codex/complete-review-work-order` at commit `f4d3a4a`. On the MacBook, from a terminal in the BrainLink repository:

```sh
git fetch origin
git switch --track origin/codex/complete-review-work-order
npm ci
npm run build:mac
```

If that branch already exists locally, use `git switch codex/complete-review-work-order` followed by `git pull --ff-only` instead of the `git switch --track` line.

The script verifies checksums for the pinned universal Node runtime and creates `dist/BrainLink-1.3.8.pkg` plus its SHA-256 file. It requires native macOS tools including `lipo`, `pkgbuild`, `productbuild`, and `codesign`, supplied with Xcode Command Line Tools. The default build is unsigned/ad-hoc signed; follow [INSTALL-UNSIGNED.md](../packaging/macos/INSTALL-UNSIGNED.md) to install it through Gatekeeper. A Developer ID signed and notarized build requires the configured Apple signing identities and notarization profile; do not put those credentials in Git or chat.

GitHub Actions did not run on this commit because the repository account is blocked by a billing/spending-limit check. The Mac build must therefore be run locally unless that account condition is resolved. A local build does not replace verification by installing and launching the package on the target Mac.
