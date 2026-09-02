// src/sync/MuxRoomTransport.ts
// `RoomTransport` over the vault's ONE socket (P3 spec §1.1, §9 slice 3).
//
// This is the file where the socket count actually falls. Slice 2 put `_tree` on
// `MuxLink` and left every note on its own `WebsocketProvider`, so a vault with a
// note open still cost two sockets and a vault with the publish queue running cost
// one more per room in flight. From here a note's room is a SUBSCRIPTION on the
// link the tree is already using, and the second, third and two-thousandth room
// cost no second socket — which structural case `80d` measured at the socket
// factory before anything depended on it.
//
// It is deliberately almost nothing. `MuxRoom` already satisfies `RoomConnection`
// as it stands — `synced`, `on('sync')`, `off('sync')`, `flush(ms)`, `destroy()`,
// all shipped in slice 2 and all tested against the real server — so the whole of
// this adapter is "hand it the registry's document and the registry's awareness
// instead of letting it make its own". That is the one thing it must do: the
// registry can replace a live room's connection (an old server), and a document or
// an awareness that moved when that happened would take the editor's binding with
// it.
//
// No `obsidian` import, no node builtins.

import type * as Y from 'yjs';
import type * as awarenessProtocol from 'y-protocols/awareness';

import type { MuxLink } from './MuxLink.ts';
import { MuxRoom } from './MuxRoom.ts';
import type { RoomConnection, RoomTransport } from './RoomRegistry.ts';

export class MuxRoomTransport implements RoomTransport {
  constructor(private readonly link: MuxLink) {}

  open(
    room: string,
    doc: Y.Doc,
    awareness: awarenessProtocol.Awareness,
  ): RoomConnection {
    // ⚠ `awareness` is PASSED, so `MuxRoom.ownsAwareness` is false and the room
    // will not destroy it. The registry built it and the registry destroys it,
    // which is the same rule `LegacyTreeTransport` already follows for the probe.
    return new MuxRoom(this.link, room, doc, { awareness });
  }
}
