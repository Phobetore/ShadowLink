import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newNodeId, treeRoom, noteRoom, NODE_ID_RE, DOC_RE } from './ids.ts';

// Spec test A17
test('newNodeId is 22 chars of [A-Za-z0-9] and collision-free over 100k draws', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 100_000; i++) {
    const id = newNodeId();
    assert.equal(id.length, 22);
    assert.match(id, NODE_ID_RE);
    assert.ok(!seen.has(id), `duplicate nodeId at draw ${i}`);
    seen.add(id);
  }
});

test('noteRoom and treeRoom satisfy the server DOC_RE', () => {
  assert.match(treeRoom(), DOC_RE);
  for (let i = 0; i < 1000; i++) assert.match(noteRoom(newNodeId()), DOC_RE);
});

test('rooms are distinguishable and parse back', () => {
  const id = newNodeId();
  assert.equal(treeRoom(), '_tree');
  assert.equal(noteRoom(id), `n_${id}`);
  assert.notEqual(noteRoom(id), treeRoom());
});

// Spec test A18 — the namespace proof, executed rather than asserted on paper.
test('a P0 path-derived docId can never collide with the _tree or n_ namespace', () => {
  const b64url = (s: string): string => {
    const bytes = new TextEncoder().encode(s);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return Buffer.from(bin, 'binary').toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  const samples = [
    'note.md', 'Shared/note.md', 'dossier/été.md', '日本語/メモ.md',
    'a'.repeat(200) + '.md', 'Ünïcødé (2).md', '_tree', 'n_abc',
  ];
  for (let i = 0; i < 2000; i++) {
    samples.push(`f${i}/` + String.fromCodePoint(0x41 + (i % 26), 0x4e00 + (i % 500)) + '.md');
  }
  for (const p of samples) {
    const enc = b64url(p);
    assert.ok(!enc.startsWith('_'), `collides with _tree namespace: ${p} -> ${enc}`);
    assert.ok(!enc.startsWith('n_'), `collides with note namespace: ${p} -> ${enc}`);
  }
});
