// server/test/auth.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { Auth } from '../auth.js';

function makeTempDir() {
  const dir = join(tmpdir(), `sl-test-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

test('Auth.bootstrap creates SHADOWLINK_ADMIN_CREDS.txt on first run', async () => {
  const dir = makeTempDir();
  const auth = new Auth(dir);
  await auth.bootstrap();
  assert.ok(existsSync(join(dir, 'SHADOWLINK_ADMIN_CREDS.txt')));
  rmSync(dir, { recursive: true });
});

test('Auth.bootstrap generates tokens with correct prefixes', async () => {
  const dir = makeTempDir();
  const auth = new Auth(dir);
  await auth.bootstrap();
  assert.ok(auth.adminToken.startsWith('at_'));
  assert.ok(auth.serverKey.startsWith('sk_'));
  rmSync(dir, { recursive: true });
});

test('Auth.bootstrap loads existing tokens on subsequent runs', async () => {
  const dir = makeTempDir();
  const auth1 = new Auth(dir);
  await auth1.bootstrap();
  const token1 = auth1.adminToken;
  const key1 = auth1.serverKey;

  const auth2 = new Auth(dir);
  await auth2.bootstrap();
  assert.equal(auth2.adminToken, token1);
  assert.equal(auth2.serverKey, key1);
  rmSync(dir, { recursive: true });
});

test('Auth.validateAdminToken returns true for correct token', async () => {
  const dir = makeTempDir();
  const auth = new Auth(dir);
  await auth.bootstrap();
  assert.ok(auth.validateAdminToken(auth.adminToken));
  rmSync(dir, { recursive: true });
});

test('Auth.validateAdminToken returns false for wrong token', async () => {
  const dir = makeTempDir();
  const auth = new Auth(dir);
  await auth.bootstrap();
  assert.ok(!auth.validateAdminToken('at_wrong'));
  rmSync(dir, { recursive: true });
});

test('Auth.validateServerKey returns true for correct key', async () => {
  const dir = makeTempDir();
  const auth = new Auth(dir);
  await auth.bootstrap();
  assert.ok(auth.validateServerKey(auth.serverKey));
  rmSync(dir, { recursive: true });
});

test('Auth.regenerateServerKey changes SERVER_KEY and updates creds file', async () => {
  const dir = makeTempDir();
  const auth = new Auth(dir);
  await auth.bootstrap();
  const oldKey = auth.serverKey;
  await auth.regenerateServerKey();
  assert.notEqual(auth.serverKey, oldKey);
  const content = readFileSync(join(dir, 'SHADOWLINK_ADMIN_CREDS.txt'), 'utf8');
  assert.ok(content.includes(auth.serverKey));
  rmSync(dir, { recursive: true });
});
