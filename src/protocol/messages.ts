// src/protocol/messages.ts
// Discriminated unions for every message type on every channel.

// ── CLIENT → SERVER ──────────────────────────────────────────────

export type ClientMessage =
  | AuthMessage
  | SyncHelloMessage
  | SyncDoneMessage
  | ManifestOpMessage
  | FileExistsMessage
  | FileRegisterMessage
  | ChunkMessage
  | UploadResumeMessage
  | PresenceUpdateMessage
  | CreateRoomMessage
  | DeleteRoomMessage
  | YjsUpdateMessage;

export interface AuthMessage {
  type: 'AUTH';
  serverKey: string;
  adminToken?: string;
  userId: string;
  name: string;
  roomCode?: string;   // omit when creating a room
}

export interface SyncHelloMessage {
  type: 'SYNC_HELLO';
  manifestVersion: number;
  yjsStateVectors: Record<string, string>; // filePath → base64 state vector
}

export interface SyncDoneMessage { type: 'SYNC_DONE'; }

export interface ManifestOpMessage {
  type: 'MANIFEST_OP';
  op: ManifestOp;
}

export type ManifestOp =
  | { kind: 'FILE_CREATE'; path: string; hash: string; size: number }
  | { kind: 'FILE_DELETE'; path: string }
  | { kind: 'FILE_RENAME'; oldPath: string; newPath: string }
  | { kind: 'FILE_MOVE';   oldPath: string; newPath: string }
  | { kind: 'FOLDER_CREATE'; path: string }
  | { kind: 'FOLDER_DELETE'; path: string };

export interface FileExistsMessage {
  type: 'FILE_EXISTS';
  hash: string;
}

export interface FileRegisterMessage {
  type: 'FILE_REGISTER';
  hash: string;
  path: string;
  size: number;
}

export interface ChunkMessage {
  type: 'CHUNK';
  hash: string;
  chunkIndex: number;
  totalChunks: number;
  data: string;  // base64
}

export interface UploadResumeMessage {
  type: 'UPLOAD_RESUME';
  hash: string;
}

export interface PresenceUpdateMessage {
  type: 'PRESENCE_UPDATE';
  currentFile: string | null;
  cursor: unknown | null;  // Y.RelativePosition pair
}

export interface CreateRoomMessage {
  type: 'CREATE_ROOM';
  ttl: 'session' | '24h' | '7d' | '30d' | 'permanent';
  permissions: 'read-write' | 'read-only';
}

export interface DeleteRoomMessage {
  type: 'DELETE_ROOM';
  code: string;
}

export interface YjsUpdateMessage {
  type: 'YJS_UPDATE';
  filePath: string;
  update: string;  // base64 Yjs binary update
}

// ── SERVER → CLIENT ──────────────────────────────────────────────

export type ServerMessage =
  | AuthOkMessage
  | AuthErrorMessage
  | RoomCreatedMessage
  | ManifestDiffMessage
  | ManifestOpResultMessage
  | FileExistsReplyMessage
  | ChunkAckMessage
  | UploadResumeReplyMessage
  | FileCreatedMessage
  | FileDeletedMessage
  | PresenceBroadcastMessage
  | MemberJoinedMessage
  | MemberLeftMessage
  | YjsDiffMessage
  | ErrorMessage;

export interface AuthOkMessage {
  type: 'AUTH_OK';
  userId: string;
  roomCode: string;
  isAdmin: boolean;
}

export interface AuthErrorMessage {
  type: 'AUTH_ERROR';
  reason: string;
}

export interface RoomCreatedMessage {
  type: 'ROOM_CREATED';
  code: string;
}

export interface ManifestDiffMessage {
  type: 'MANIFEST_DIFF';
  fromVersion: number;
  toVersion: number;
  ops: ManifestOp[];
}

export interface ManifestOpResultMessage {
  type: 'MANIFEST_OP_RESULT';
  op: ManifestOp;
  accepted: boolean;
  reason?: string;
  conflictCopyPath?: string;  // set when FILE_CREATE rejected → copy created
}

export interface FileExistsReplyMessage {
  type: 'FILE_EXISTS_REPLY';
  hash: string;
  exists: boolean;
}

export interface ChunkAckMessage {
  type: 'CHUNK_ACK';
  hash: string;
  chunkIndex: number;
}

export interface UploadResumeReplyMessage {
  type: 'UPLOAD_RESUME_REPLY';
  hash: string;
  lastChunk: number;  // -1 if no chunks received yet
}

export interface FileCreatedMessage {
  type: 'FILE_CREATED';
  path: string;
  hash: string;
  size: number;
  modified: number;
}

export interface FileDeletedMessage {
  type: 'FILE_DELETED';
  path: string;
  deletedBy: string;  // userId
}

export interface PresenceBroadcastMessage {
  type: 'PRESENCE_BROADCAST';
  userId: string;
  name: string;
  color: string;
  currentFile: string | null;
  cursor: unknown | null;
}

export interface MemberJoinedMessage {
  type: 'MEMBER_JOINED';
  userId: string;
  name: string;
  color: string;
}

export interface MemberLeftMessage {
  type: 'MEMBER_LEFT';
  userId: string;
  name: string;
}

export interface YjsDiffMessage {
  type: 'YJS_DIFF';
  filePath: string;
  update: string;  // base64 Yjs binary update
}

export interface ErrorMessage {
  type: 'ERROR';
  code: string;
  message: string;
}
