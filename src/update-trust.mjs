// Add release publisher Ed25519 public keys here only through a reviewed source change.
// During rotation, ship an app that pins both old and new keys, then sign a later release
// with the new key. Remove an old key only after its trust window has safely ended.
// Never load trust roots from the network, user settings, or an environment variable.
// No production publisher key is configured yet.
export const UPDATE_PUBLIC_KEYS = Object.freeze([]);
