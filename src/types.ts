// src/types.ts
// Plugin settings, as persisted in the vault's `data.json`.

export interface ShadowLinkSettings {
  /** Shown beside this user's cursor to collaborators. */
  displayName: string;
  /** Hex colour for this user's cursor, e.g. '#7c6af7'. */
  cursorColor: string;
  share: ShareConfig;
  /**
   * 16 random hex characters, minted once and then never again.
   *
   * It lives here rather than inside the device-state file it names, because
   * that file is only trusted when it already agrees with this value — storing
   * the identity inside the thing it authenticates would make every copy of the
   * file self-authenticating, which is exactly what the check exists to prevent.
   * (`.obsidian/` is replicated by other sync tools, so copies do happen.)
   *
   * Empty means "not minted yet".
   */
  deviceId: string;
}

/**
 * The shared workspace. Every member types the first three identically; the
 * fourth is local, so two people may mount the same workspace at different
 * paths in their own vaults.
 */
export interface ShareConfig {
  /** ws://host:port or wss://host — no trailing slash. */
  serverUrl: string;
  /** `sk_…`, from the server's SHADOWLINK_ADMIN_CREDS.txt. */
  serverKey: string;
  /** [A-Za-z0-9_-]{1,64}. Identical for every member of a workspace. */
  workspaceId: string;
  /** Vault-relative folder to share, e.g. 'Shared'. No leading or trailing slash. */
  sharedFolder: string;
}

export const DEFAULT_SETTINGS: ShadowLinkSettings = {
  displayName: 'Anonymous',
  cursorColor: '#7c6af7',
  share: { serverUrl: '', serverKey: '', workspaceId: '', sharedFolder: '' },
  deviceId: '',
};
