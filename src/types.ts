// src/types.ts

export interface ShadowLinkSettings {
  displayName: string;
  cursorColor: string;
  servers: ServerEntry[];
  showCursors: boolean;
  showJoinLeaveNotifications: boolean;
  autoRejoinRecentRooms: boolean;
  activeRoom: ActiveRoom | null;
  share: ShareConfig;
  /**
   * Spec §2.5: 16 random hex characters, minted once and then never again.
   *
   * It lives in `data.json` rather than in the device-state file it names,
   * because that file is only trusted when it already agrees with this value —
   * storing the identity inside the thing it authenticates would make every copy
   * of the file self-authenticating, which is exactly what the check exists to
   * prevent. Empty means "not minted yet".
   */
  deviceId: string;
}

/** P0 single shared-folder configuration. Generalized to a list in P1. */
export interface ShareConfig {
  serverUrl: string;     // ws://host:port  (no trailing slash)
  serverKey: string;     // sk_... from SHADOWLINK_ADMIN_CREDS.txt
  workspaceId: string;   // [A-Za-z0-9_-]{1,64}; identical for all members
  sharedFolder: string;  // vault-relative folder, e.g. "Shared" (no leading/trailing slash)
}

export interface ServerEntry {
  url: string;           // ws://... or wss://...
  serverKey: string;     // SERVER_KEY for this server
  adminToken: string;    // ADMIN_TOKEN if admin, empty string if guest
  label: string;         // display label (auto-derived from URL)
}

export interface ActiveRoom {
  code: string;          // WOLF-7842-a3f9c2
  serverUrl: string;
  permissions: 'read-write' | 'read-only';
}

export interface RoomMember {
  userId: string;
  name: string;
  color: string;
  currentFile: string | null;
  cursor: RelativeCursor | null;
}

export interface RelativeCursor {
  anchor: unknown;  // Y.RelativePosition (opaque to TypeScript)
  head: unknown;
}

export interface ManifestFile {
  hash: string;             // sha256:...
  size: number;
  modified: number;         // unix timestamp ms
  yjsStateVector?: string;  // base64, only for .md files
}

export interface Manifest {
  version: number;
  files: Record<string, ManifestFile>;
  folders: string[];
}

export const DEFAULT_SETTINGS: ShadowLinkSettings = {
  displayName: 'Anonymous',
  cursorColor: '#7c6af7',
  servers: [],
  showCursors: true,
  showJoinLeaveNotifications: true,
  autoRejoinRecentRooms: false,
  activeRoom: null,
  share: { serverUrl: '', serverKey: '', workspaceId: '', sharedFolder: '' },
  deviceId: '',
};
