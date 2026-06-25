// server/auth.js
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const TOKENS_FILE = 'tokens.json';

function generateToken(prefix) {
  return `${prefix}${randomBytes(16).toString('hex')}`;
}

function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) {
    // still run comparison to avoid timing leak on length
    timingSafeEqual(Buffer.from(a), Buffer.from(a));
    return false;
  }
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export class Auth {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.adminToken = '';
    this.serverKey = '';
    this.serverUrl = '';
  }

  async bootstrap(serverUrl = '') {
    this.serverUrl = serverUrl;
    const tokensPath = join(this.dataDir, TOKENS_FILE);
    if (existsSync(tokensPath)) {
      const data = JSON.parse(readFileSync(tokensPath, 'utf8'));
      this.adminToken = data.adminToken;
      this.serverKey = data.serverKey;
    } else {
      this.adminToken = generateToken('at_');
      this.serverKey = generateToken('sk_');
      this._persist();
    }
    this._writeCredsFile();
  }

  validateAdminToken(token) {
    return safeCompare(token, this.adminToken);
  }

  validateServerKey(key) {
    return safeCompare(key, this.serverKey);
  }

  async regenerateServerKey() {
    this.serverKey = generateToken('sk_');
    this._persist();
    this._writeCredsFile();
  }

  async regenerateAdminToken() {
    this.adminToken = generateToken('at_');
    this._persist();
    this._writeCredsFile();
  }

  _persist() {
    writeFileSync(
      join(this.dataDir, TOKENS_FILE),
      JSON.stringify({ adminToken: this.adminToken, serverKey: this.serverKey }),
    );
  }

  _writeCredsFile() {
    const content = [
      '========================================',
      '  SHADOWLINK — ADMINISTRATOR CREDENTIALS',
      '========================================',
      '',
      `ADMIN_TOKEN=${this.adminToken}`,
      '  → Grants full admin access to the server.',
      '    Enter once in your Obsidian plugin settings.',
      '    Never share except via an admin invitation link.',
      '',
      `SERVER_KEY=${this.serverKey}`,
      '  → Access key embedded in invitation links.',
      '    Guests need this to connect to any room.',
      '    Without this key, no connection to the server is possible.',
      '',
      `SERVER_URL=${this.serverUrl || 'ws://your-ip:' + (process.env.PORT ?? '4000')}`,
      '  → Your ShadowLink server URL.',
      '',
      '========================================',
      '  Keep this file in a safe place.',
      '  Regenerating SERVER_KEY invalidates all existing guest links.',
      '  Regenerating ADMIN_TOKEN invalidates all existing admin links.',
      '========================================',
    ].join('\n');
    writeFileSync(join(this.dataDir, 'SHADOWLINK_ADMIN_CREDS.txt'), content);
  }
}
