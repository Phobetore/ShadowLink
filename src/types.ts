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
  /**
   * Spec §7.5. Has the user said they do not want to be told again that new
   * attachments would land outside the shared folder?
   *
   * It lives in the plugin's settings rather than in device state because it is a
   * preference about a VAULT-GLOBAL Obsidian setting, and device state is
   * discarded whole whenever it names another device or another workspace — which
   * would re-open a dialog the user already dismissed, on a schedule they could
   * not predict.
   */
  attachmentFolderWarningDismissed: boolean;
  /**
   * Force the previous, per-room connection for this vault instead of the
   * multiplexed one (P3 spec §4).
   *
   * ⚠ THE LEVER, AND IT IS A LEVER BECAUSE THERE IS NO SOUND INFERENCE. A
   * deployment can accept the `/_mux` upgrade and then carry nothing on it — a
   * proxy that upgrades the socket and drops the frames, a tunnel that forwards
   * the handshake and nothing after it. From inside the client that is
   * indistinguishable from a path that is merely slow, and three rounds of
   * arithmetic that tried to tell them apart each shipped a sentence telling a
   * user their current server was old. So the client states what it measured and
   * the person who knows their own deployment decides.
   *
   * It lives HERE rather than in `share` because the first three fields of
   * `ShareConfig` must be identical for every member of a workspace and this is a
   * fact about one device's path to the server. It is read once, when the runtime
   * starts, so turning it off returns to the multiplexed route on the next
   * connect; nothing in the plugin ever sets it, and nothing latches it.
   */
  useCompatibilityConnection: boolean;
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
  /**
   * Identical for every member of a workspace, and constrained by
   * `WORKSPACE_ID_RE` in `src/tree/ids.ts` — which is where the client states that
   * charset, once, for both the settings tab and the two filenames the id becomes.
   * Restating the pattern here would make this a third copy to keep in step.
   *
   * `''` means "not configured yet"; `ShadowLinkPlugin.configured` reads it.
   */
  workspaceId: string;
  /** Vault-relative folder to share, e.g. 'Shared'. No leading or trailing slash. */
  sharedFolder: string;
}

export const DEFAULT_SETTINGS: ShadowLinkSettings = {
  displayName: 'Anonymous',
  cursorColor: '#7c6af7',
  share: { serverUrl: '', serverKey: '', workspaceId: '', sharedFolder: '' },
  deviceId: '',
  attachmentFolderWarningDismissed: false,
  useCompatibilityConnection: false,
};
