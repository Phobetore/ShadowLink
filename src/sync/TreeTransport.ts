// src/sync/TreeTransport.ts
// What the plugin needs from whatever carries `_tree`, and the mux implementation
// of it (P3 spec §2, §9 slice 2).
//
// The interface exists so that `main.ts` names ONE thing and the removal-scheduled
// legacy bridge (`LegacyTreeTransport.ts`) is a file that can be deleted rather
// than a mode that has to be untangled. Four members is the whole surface the
// plugin ever used from the tree's `WebsocketProvider`:
//
//   connect()      Bootstrap's `connectTree`, which is idempotent by design
//   whenSynced()   a GENUINE sync event, never a timeout (I3)
//   onConnected()  the transition that runs `onReconnect` (I15)
//   connected      whether that transition has already happened
//   destroy()      teardown, which must never throw
//
// ⚠ `connected` IS THERE BECAUSE `onConnected` IS A TRANSITION. Something that
// takes over an ALREADY-connected transport — which is what the bridge does when
// it adopts its own probe — will never see the transition, and `onConnected` is
// the only exit from read-only. Measured: verdict at 2,002 ms, `synced` true from
// then on, and zero fires across 32 s. A transition is only usable by a late
// arrival if the state behind it can be read.
//
// Everything else the provider exposed — `awareness`, `wsconnected`, `ws`,
// `disconnect` — was never read for the tree, and naming it here would only make
// the bridge harder to remove.
//
// No `obsidian` import, no node builtins.

import type * as Y from 'yjs';

import type { MuxLink } from './MuxLink.ts';
import { MuxRoom } from './MuxRoom.ts';

/** The room the structural document has always lived in. Unchanged by P3 §10. */
export const TREE_ROOM = '_tree';

export interface TreeTransport {
  /** True only after a genuine handshake completed on the current connection. */
  readonly synced: boolean;
  /**
   * True while the transport is in the state `onConnected` announces entering.
   *
   * Read by anything that registers a handler LATE and would otherwise wait for
   * ever on a transition that already happened.
   */
  readonly connected: boolean;
  /**
   * Idempotent: `Bootstrap.connectTree` calls it on every attempt.
   *
   * `immediate` means somebody is waiting — a bootstrap, a reconnect pass — so
   * the backoff rung, which exists to protect a server from a retry LOOP, must
   * not also be what makes that person wait.
   */
  connect(options?: { immediate?: boolean }): void;
  /** Resolves TRUE only on a genuine sync. A timeout resolves FALSE (I3/I4). */
  whenSynced(ms: number): Promise<boolean>;
  /** Fires on every transition INTO connected. Returns an unsubscribe. */
  onConnected(handler: () => void): () => void;
  destroy(): void;
}

/**
 * `_tree` over the vault's one socket.
 *
 * ⚠ The reason `_tree` is the room slice 2 moves, and it is a safety argument
 * rather than a convenience one: no note content passes through it. The reconnect
 * ladder, the jitter, the re-handshake-every-room rule and the frame codec all
 * get to soak on the one document in the system whose worst failure is a
 * structural pass that has to run again, before slice 3 puts a user's prose on
 * the same machinery.
 */
export class MuxTreeTransport implements TreeTransport {
  private readonly room: MuxRoom;

  constructor(private readonly link: MuxLink, doc: Y.Doc, room: string = TREE_ROOM) {
    this.room = new MuxRoom(link, room, doc);
  }

  /** The room, for a flush or an awareness read. Nothing in slice 2 needs it. */
  get muxRoom(): MuxRoom {
    return this.room;
  }

  get synced(): boolean {
    return this.room.synced;
  }

  get connected(): boolean {
    return this.link.connected;
  }

  connect(options: { immediate?: boolean } = {}): void {
    this.link.connect(options);
  }

  whenSynced(ms: number): Promise<boolean> {
    return this.room.whenSynced(ms);
  }

  onConnected(handler: () => void): () => void {
    return this.link.onStatus((status) => {
      if (status === 'connected') handler();
    });
  }

  /**
   * Releases the ROOM, never the link: the link is the vault's, and from slice 3
   * it will be carrying every note's room as well.
   */
  destroy(): void {
    this.room.destroy();
  }
}
