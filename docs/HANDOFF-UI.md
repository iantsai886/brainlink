# BrainLink UI boundaries

`brainlink ui` and `brainlink demo` serve the active Setup application from `src/setup.mjs` and
`ui/index.html`. Its graph is implemented in `ui/notes3d.js`. The separate `ui/app/*` host UI and
`src/ui-server.mjs` are currently exercised by their own tests; they are not the CLI's active UI.

The active Setup app watches configured Markdown vaults. It sends a token-authenticated,
content-free event to the local browser after a note change. The 3D graph reloads when it is open;
if a note editor is open, the refresh waits until the edit ends. Recursive `fs.watch` is used when
available. Unsupported platforms poll Markdown file metadata every 10 seconds. Adding or removing
a vault refreshes the watch set immediately. An external rename can appear as a removed graph node
and a new one because the filesystem has no BrainLink note ID to preserve.

The separate `ui/app/*` host UI has these remaining integration gaps:

- Its theme preference is held in an in-memory map and does not survive restarting that host.
- Its `services.sessions.setPrivate` uses a read-and-reimport fallback; large histories have not
  been manually exercised.
- Its JSON RPC bridge cannot upload binary files, though the folder store supports blobs.

Keep these two UI paths clearly distinguished when recording desktop acceptance evidence.
