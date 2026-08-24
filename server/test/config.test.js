// server/test/config.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../config.js';

test('loadConfig returns defaults when no env vars set', () => {
  const cfg = loadConfig({});
  assert.equal(cfg.port, 4000);
  // 100, not the 700 this setting carried while nothing read it: the client holds
  // a whole attachment in memory to hash it, and Obsidian mobile offers neither a
  // streaming binary write nor an incremental digest, so 700 MB is a number no
  // client on the far end could honour (spec §7.4).
  assert.equal(cfg.maxFileSizeMb, 100);
  // 10 GB, not unlimited: `incoming/` counts against this, and a store with no
  // ceiling fills the volume DocHub writes its snapshots to, which fails into
  // `lastPersistError` where nothing surfaces it. 0 still means unlimited.
  assert.equal(cfg.maxTotalStorageGb, 10);
  assert.equal(cfg.incompleteUploadTtlHours, 24);
  assert.equal(cfg.maxBlobConcurrency, 6);
  assert.equal(cfg.blobChunkBytes, 4_194_304);
  assert.equal(cfg.blobOrphanTtlDays, 90);
  assert.equal(cfg.roomDefaultTtl, 'permanent');
  assert.equal(cfg.rateLimitOpsPerSec, 10);
  assert.equal(cfg.maxConnectionsPerIp, 50);
  assert.equal(cfg.sessionCloseTimeoutMs, 5000);
  assert.equal(cfg.persistenceDir, './data');
});

test('the blob settings are read from env', () => {
  const cfg = loadConfig({
    MAX_FILE_SIZE_MB: '25',
    MAX_TOTAL_STORAGE_GB: '2',
    INCOMPLETE_UPLOAD_TTL_HOURS: '6',
    MAX_BLOB_CONCURRENCY: '3',
    BLOB_CHUNK_BYTES: '1048576',
    BLOB_ORPHAN_TTL_DAYS: '30',
  });
  assert.equal(cfg.maxFileSizeMb, 25);
  assert.equal(cfg.maxTotalStorageGb, 2);
  assert.equal(cfg.incompleteUploadTtlHours, 6);
  assert.equal(cfg.maxBlobConcurrency, 3);
  assert.equal(cfg.blobChunkBytes, 1_048_576);
  assert.equal(cfg.blobOrphanTtlDays, 30);
});

test('MAX_TOTAL_STORAGE_GB = 0 still means unlimited', () => {
  assert.equal(loadConfig({ MAX_TOTAL_STORAGE_GB: '0' }).maxTotalStorageGb, 0);
});

test('a setting that is not a number is refused rather than silently disabled', () => {
  // `parseInt('unlimited')` is NaN, and every comparison against NaN is false —
  // so a typo in MAX_FILE_SIZE_MB would not raise the cap, it would REMOVE it,
  // and the server would accept a 4 GB upload while its own settings said 100 MB.
  // The same class of typo in MAX_CONNECTIONS_PER_IP removes that ceiling too.
  for (const key of [
    'PORT', 'MAX_FILE_SIZE_MB', 'MAX_TOTAL_STORAGE_GB', 'INCOMPLETE_UPLOAD_TTL_HOURS',
    'MAX_BLOB_CONCURRENCY', 'BLOB_CHUNK_BYTES', 'BLOB_ORPHAN_TTL_DAYS',
    'RATE_LIMIT_OPS_PER_SEC', 'MAX_CONNECTIONS_PER_IP', 'SESSION_CLOSE_TIMEOUT_MS',
  ]) {
    assert.throws(
      () => loadConfig({ [key]: 'unlimited' }),
      new RegExp(key),
      `${key} = "unlimited" must be refused`,
    );
    assert.throws(() => loadConfig({ [key]: '-1' }), new RegExp(key), `${key} = -1 must be refused`);
    assert.throws(() => loadConfig({ [key]: '' }), new RegExp(key), `${key} = "" must be refused`);
    assert.throws(() => loadConfig({ [key]: '1.5' }), new RegExp(key), `${key} = 1.5 must be refused`);
  }
});

test('a blob setting that must be positive refuses zero', () => {
  // 0 is meaningful for MAX_TOTAL_STORAGE_GB (unlimited) and for nothing else
  // here: a 0-byte chunk size or a 0-transfer concurrency cap is a server that
  // accepts nothing, which is a configuration error and not a policy.
  for (const key of ['PORT', 'MAX_FILE_SIZE_MB', 'MAX_BLOB_CONCURRENCY', 'BLOB_CHUNK_BYTES']) {
    assert.throws(() => loadConfig({ [key]: '0' }), new RegExp(key), `${key} = 0 must be refused`);
  }
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
