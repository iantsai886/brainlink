# Signed update checks

## Current state

Setup has an explicit **Check for updates** action. It requests one fixed BrainLink GitHub release-manifest URL, follows at most three HTTPS redirects to approved GitHub release hosts, bounds the response size and time, checks the response type, verifies the Ed25519 signature against the public key compiled in `src/update-trust.mjs`, then checks version, channel, OS, CPU type, asset URL, size, and SHA-256 metadata. A separate **Prepare verified download** action streams the selected package into a temporary folder and checks its exact signed size and SHA-256 before making it available as a one-time, five-minute local download link. Setup requires its local session token for both actions. Temporary files are removed after a download, ticket expiry, or Setup shutdown. POSIX permissions are restricted by the OS temporary-directory defaults; Windows inherits its temporary-folder ACL, which has not been independently checked. BrainLink never installs or launches the package automatically.

The publisher key is intentionally empty in the source today. Builds therefore report that automatic checks are not enabled and do not contact GitHub. Tests can inject a temporary key; production runtime trust cannot be changed by a network response, user settings, or environment variable.

## Enabling a publisher

1. Generate and protect an Ed25519 release private key outside GitHub and outside the repository. Keep an encrypted offline backup and restrict release access.
2. Put only its public PEM in `src/update-trust.mjs` through a reviewed commit. Build and distribute that version before publishing signed update manifests.
3. For each release, publish `brainlink-update.json` at the fixed GitHub release download URL. Sign a canonical JSON payload with `npm run updates:sign-manifest`; include each package's exact byte size and SHA-256. Keep the private key in a protected release environment, never in Git, the app, or user configuration.
4. Verify the release envelope with the public key before publishing. Publish package assets and the manifest as one reviewed release operation.

Key rotation is not implemented. Do not replace a live publisher key until the app supports a reviewed overlap period with old and new public keys, or a migration may strand existing installs.

## Remaining release work

- Provision and pin the publisher key.
- Automate asset hashing, payload creation, signing, and publication without exposing the private key.
- Design and test a clear, user-approved OS installer handoff, upgrade, and rollback flow.
- Exercise signed releases on Windows, macOS, and Linux, including key rotation and interrupted downloads.

The current feature is a signed **update check**, not an updater or auto-installer. See `docs/IMPLEMENTATION-STATUS.md` for commit-specific test evidence.
