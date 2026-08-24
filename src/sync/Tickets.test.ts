// src/sync/Tickets.test.ts
//
// Invariant I9 is the frame for every test here: tickets are an OPTIMIZATION, not
// the correctness mechanism. The watcher stays idempotent without them. So the
// property that actually matters is not "a ticket suppresses an echo" — it is
// "a ticket can never suppress more than exactly what was armed, and never
// suppresses anything at all once it has aged out".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Tickets } from './Tickets.ts';
import { TICKET_TTL_MS } from '../tree/constants.ts';

/** A controllable clock, so expiry is tested without sleeping. */
function clock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

test('a create ticket is claimed exactly once', () => {
  const t = new Tickets();
  t.arm('create', 'Shared/a.md');

  assert.equal(t.claim('create', 'Shared/a.md'), true);
  assert.equal(t.claim('create', 'Shared/a.md'), false, 'tickets are single-shot');
  assert.equal(t.size(), 0);
});

test('a delete ticket is claimed exactly once', () => {
  const t = new Tickets();
  t.arm('delete', 'Shared/a.md');

  assert.equal(t.claim('delete', 'Shared/a.md'), true);
  assert.equal(t.claim('delete', 'Shared/a.md'), false);
});

test('claiming with no ticket armed returns false', () => {
  const t = new Tickets();
  assert.equal(t.claim('create', 'Shared/a.md'), false);
  assert.equal(t.claim('rename', 'Shared/a.md', 'Shared/b.md'), false);
});

test('a ticket does not match a different op or a different path', () => {
  const t = new Tickets();
  t.arm('create', 'Shared/a.md');

  assert.equal(t.claim('delete', 'Shared/a.md'), false, 'op must match');
  assert.equal(t.claim('create', 'Shared/b.md'), false, 'path must match');
  assert.equal(t.claim('rename', 'Shared/a.md', 'Shared/a.md'), false);
  // I9: a non-matching claim must not consume the armed ticket either.
  assert.equal(t.size(), 1);
  assert.equal(t.claim('create', 'Shared/a.md'), true);
});

test('matching is case-insensitive and unicode-normalized', () => {
  const t = new Tickets();
  t.arm('create', 'Notes/A.md');
  assert.equal(t.claim('create', 'notes/a.md'), true);

  // macOS hands paths back in NFD; the ticket was armed from an NFC path.
  t.arm('create', 'Notes/Café.md'.normalize('NFC'));
  assert.equal(t.claim('create', 'Notes/Café.md'.normalize('NFD')), true);
  assert.equal(t.size(), 0);
});

test('a rename ticket matches on the (from, to) pair', () => {
  const t = new Tickets();
  t.arm('rename', 'Shared/a.md', 'Shared/b.md');

  assert.equal(t.claim('rename', 'Shared/a.md', 'Shared/c.md'), false, 'wrong destination');
  assert.equal(t.claim('rename', 'Shared/x.md', 'Shared/b.md'), false, 'wrong source');
  assert.equal(t.claim('rename', 'Shared/b.md', 'Shared/a.md'), false, 'the pair is ordered');
  assert.equal(t.size(), 1, 'none of those near misses consumed it');

  assert.equal(t.claim('rename', 'SHARED/A.MD', 'shared/b.md'), true);
  assert.equal(t.claim('rename', 'Shared/a.md', 'Shared/b.md'), false);
});

test('a ticket older than TICKET_TTL_MS never matches, and sweep drops it', () => {
  const c = clock();
  const t = new Tickets(c.now);
  t.arm('create', 'Shared/a.md');
  t.arm('delete', 'Shared/b.md');
  assert.equal(t.size(), 2);

  c.advance(TICKET_TTL_MS - 1);
  assert.equal(t.claim('create', 'Shared/a.md'), true, 'still inside the window');

  t.arm('create', 'Shared/a.md');
  c.advance(TICKET_TTL_MS);
  assert.equal(t.claim('create', 'Shared/a.md'), false, 'expired tickets never match');

  // The unrelated ticket is expired too but has not been walked over yet;
  // sweep() is what reclaims it.
  assert.equal(t.size(), 1);
  t.sweep();
  assert.equal(t.size(), 0);
  assert.equal(t.claim('delete', 'Shared/b.md'), false);
});

test('a custom ttl is honoured', () => {
  const c = clock();
  const t = new Tickets(c.now, 50);
  t.arm('create', 'Shared/a.md');
  c.advance(49);
  assert.equal(t.claim('create', 'Shared/a.md'), true);

  t.arm('create', 'Shared/a.md');
  c.advance(50);
  assert.equal(t.claim('create', 'Shared/a.md'), false);
});

test('arming twice permits exactly two claims', () => {
  const t = new Tickets();
  t.arm('create', 'Shared/a.md');
  t.arm('create', 'Shared/a.md');
  assert.equal(t.size(), 2);

  assert.equal(t.claim('create', 'Shared/a.md'), true);
  assert.equal(t.size(), 1);
  assert.equal(t.claim('create', 'Shared/a.md'), true);
  assert.equal(t.claim('create', 'Shared/a.md'), false, 'and no more than two');
  assert.equal(t.size(), 0);
});

test('the oldest armed ticket is consumed first, so a stale one cannot outlive a fresh one', () => {
  const c = clock();
  const t = new Tickets(c.now);
  t.arm('create', 'Shared/a.md');
  c.advance(TICKET_TTL_MS - 1);
  t.arm('create', 'Shared/a.md');

  // Now the first is one millisecond from expiry and the second is fresh.
  c.advance(1);
  assert.equal(t.claim('create', 'Shared/a.md'), true, 'the fresh one still matches');
  assert.equal(t.claim('create', 'Shared/a.md'), false, 'the stale one was discarded, not banked');
  assert.equal(t.size(), 0);
});

test('clearArmed empties the store and size tracks it throughout', () => {
  const t = new Tickets();
  assert.equal(t.size(), 0);

  t.arm('create', 'Shared/a.md');
  t.arm('rename', 'Shared/a.md', 'Shared/b.md');
  t.arm('delete', 'Shared/c.md');
  assert.equal(t.size(), 3);

  t.clearArmed();
  assert.equal(t.size(), 0);
  assert.equal(t.claim('create', 'Shared/a.md'), false);
  assert.equal(t.claim('rename', 'Shared/a.md', 'Shared/b.md'), false);
  assert.equal(t.claim('delete', 'Shared/c.md'), false);

  // The store is reusable after a clear (it runs in the reconciler's finally block).
  t.arm('create', 'Shared/d.md');
  assert.equal(t.size(), 1);
  assert.equal(t.claim('create', 'Shared/d.md'), true);
});
