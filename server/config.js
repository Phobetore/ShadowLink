// server/config.js
const VALID_TTL = ['session', '24h', '7d', '30d', 'permanent'];

export function loadConfig(env = process.env) {
  const roomDefaultTtl = env.ROOM_DEFAULT_TTL ?? 'permanent';
  if (!VALID_TTL.includes(roomDefaultTtl)) {
    throw new Error(`Invalid ROOM_DEFAULT_TTL: "${roomDefaultTtl}". Must be one of: ${VALID_TTL.join(', ')}`);
  }
  return {
    port:                     parseInt(env.PORT ?? '4000', 10),
    maxFileSizeMb:            parseInt(env.MAX_FILE_SIZE_MB ?? '700', 10),
    maxTotalStorageGb:        parseInt(env.MAX_TOTAL_STORAGE_GB ?? '0', 10),
    incompleteUploadTtlHours: parseInt(env.INCOMPLETE_UPLOAD_TTL_HOURS ?? '24', 10),
    persistenceDir:           env.PERSISTENCE_DIR ?? './data',
    roomDefaultTtl,
    rateLimitOpsPerSec:       parseInt(env.RATE_LIMIT_OPS_PER_SEC ?? '10', 10),
    maxConnectionsPerIp:      parseInt(env.MAX_CONNECTIONS_PER_IP ?? '50', 10),
    sessionCloseTimeoutMs:    parseInt(env.SESSION_CLOSE_TIMEOUT_MS ?? '5000', 10),
  };
}
