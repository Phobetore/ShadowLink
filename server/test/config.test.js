// server/test/config.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../config.js';

test('loadConfig returns defaults when no env vars set', () => {
  const cfg = loadConfig({});
  assert.equal(cfg.port, 4000);
  assert.equal(cfg.maxFileSizeMb, 700);
  assert.equal(cfg.maxTotalStorageGb, 0);
  assert.equal(cfg.incompleteUploadTtlHours, 24);
  assert.equal(cfg.roomDefaultTtl, 'permanent');
  assert.equal(cfg.rateLimitOpsPerSec, 10);
  assert.equal(cfg.maxConnectionsPerIp, 50);
  assert.equal(cfg.sessionCloseTimeoutMs, 5000);
  assert.equal(cfg.persistenceDir, './data');
});

test('loadConfig reads PORT from env', () => {
  const cfg = loadConfig({ PORT: '8080' });
  assert.equal(cfg.port, 8080);
});

test('loadConfig reads MAX_FILE_SIZE_MB from env', () => {
  const cfg = loadConfig({ MAX_FILE_SIZE_MB: '200' });
  assert.equal(cfg.maxFileSizeMb, 200);
});

test('loadConfig accepts valid ROOM_DEFAULT_TTL values', () => {
  for (const ttl of ['session', '24h', '7d', '30d', 'permanent']) {
    const cfg = loadConfig({ ROOM_DEFAULT_TTL: ttl });
    assert.equal(cfg.roomDefaultTtl, ttl);
  }
});

test('loadConfig throws on invalid ROOM_DEFAULT_TTL', () => {
  assert.throws(() => loadConfig({ ROOM_DEFAULT_TTL: 'forever' }));
});
