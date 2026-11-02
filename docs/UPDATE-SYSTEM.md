# Signed update checks

## Current state

Setup has an explicit **Check for updates** action. It requests one fixed BrainLink GitHub release-manifest URL, follows at most three HTTPS redirects to approved GitHub release hosts, bounds the response size and time, checks the response type, verifies the Ed25519 signature against one of up to four public keys compiled in `src/update-trust.mjs`, then checks version, channel, OS, CPU type, asset URL, size, and SHA-256 metadata. A separate **Prepare verified download** action streams the selected package into a temporary folder and checks its exact signed size and SHA-256 before making it available as a one-time, five-minute local download link. Setup requires its local session token for both actions. Temporary files are removed after a download, ticket expiry, or Setup shutdown. POSIX permissions are restricted by the OS temporary-directory defaults; Windows inherits its temporary-folder ACL, which has not been independently checked. BrainLink never installs or launches the package automatically.

The publisher key is intentionally empty in the source today. Builds therefore report that automatic checks are not enabled and do not contact GitHub. Tests can inject a temporary key; production runtime trust cannot be changed by a network response, user settings, or environment variable.

## Enabling a publisher

1. Generate and protect an Ed25519 release private key outside GitHub and outside the repository. Keep an encrypted offline backup and restrict release access.
2. Put only its public PEM in `UPDATE_PUBLIC_KEYS` in `src/update-trust.mjs` through a reviewed commit. Build and distribute that version before publishing signed update manifests.
3. Build all platform packages into one `dist` folder. Run `npm run updates:create-payload -- --dist dist --out brainlink-update-payload.json --channel stable` (or `beta`). The builder requires the Windows installer, universal macOS package, and Linux x64/arm64 `.deb` and `.tar.gz` packages; it calculates each exact byte size and SHA-256 and refuses missing, linked, changed, oversized, or non-regular packages. Review the payload, then sign it with `npm run updates:sign-manifest -- --payload brainlink-update-payload.json --key <protected-key-file> --out brainlink-update.json`. Keep the private key in a protected release environment, never in Git, the app, or user configuration. The release URL format and repository identity are currently fixed in the verifier.
4. Verify the release envelope with the public key before publishing. Publish package assets and the manifest as one reviewed release operation.

### Planned key rotation

The verifier supports a bounded overlap keyring, but no production key is configured and no rotation has been exercised with real installs. To rotate safely: ship and distribute an app version that trusts both old and new public keys; sign releases with the old key while that bridge version rolls out; only then begin signing with the new key. Keep both keys pinned through the migration window. Remove the old key only in a later reviewed app release after the supported old-version window ends. Do not treat adding a new key to the current repo as sufficient to update already-installed apps.

## Remaining release work

- Provision and pin the publisher key.
- Automate signing and publication without exposing the private key; package hashing and payload creation now have a local checked CLI, but are not yet wired into a hosted release workflow.
- Design and test a clear, user-approved OS installer handoff, upgrade, and rollback flow.
- Exercise signed releases on Windows, macOS, and Linux, including the overlap-key migration and interrupted downloads.

The current feature is a signed **update check**, not an updater or auto-installer. See `docs/IMPLEMENTATION-STATUS.md` for commit-specific test evidence.
