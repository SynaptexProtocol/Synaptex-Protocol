import { randomBytes, createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';

export interface NonceRecord {
  address: string;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
  used: boolean;
}

export interface SessionRecord {
  token: string;
  address: string;
  createdAt: string;
  expiresAt: string;
  signatureVerified: boolean;
}

interface StoreFileShape {
  nonces: NonceRecord[];
  sessions: SessionRecord[];
}

function nowIso(): string {
  return new Date().toISOString();
}

function plusSeconds(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

export class SiweSessionStore {
  private cache: StoreFileShape;

  constructor(private readonly filePath: string) {
    this.cache = this.read();
  }

  issueNonce(address: string, ttlSeconds: number): NonceRecord {
    const nonce: NonceRecord = {
      address: address.toLowerCase(),
      nonce: randomBytes(12).toString('hex'),
      issuedAt: nowIso(),
      expiresAt: plusSeconds(ttlSeconds),
      used: false,
    };
    this.cache.nonces.push(nonce);
    this.gc();
    this.write();
    return nonce;
  }

  consumeNonce(address: string, nonceValue: string): NonceRecord | null {
    const addressLc = address.toLowerCase();
    const found = this.cache.nonces.find((n) =>
      n.address === addressLc
      && n.nonce === nonceValue
      && !n.used
      && Date.parse(n.expiresAt) > Date.now());
    if (!found) return null;
    found.used = true;
    this.write();
    return found;
  }

  issueSession(address: string, ttlSeconds: number, signatureVerified: boolean): SessionRecord {
    const seed = `${address.toLowerCase()}|${Date.now()}|${randomBytes(16).toString('hex')}`;
    const token = createHash('sha256').update(seed).digest('hex');
    const session: SessionRecord = {
      token,
      address: address.toLowerCase(),
      createdAt: nowIso(),
      expiresAt: plusSeconds(ttlSeconds),
      signatureVerified,
    };
    this.cache.sessions.push(session);
    this.gc();
    this.write();
    return session;
  }

  getSession(token: string): SessionRecord | null {
    const session = this.cache.sessions.find((s) =>
      s.token === token && Date.parse(s.expiresAt) > Date.now());
    return session ?? null;
  }

  private read(): StoreFileShape {
    if (!existsSync(this.filePath)) {
      return { nonces: [], sessions: [] };
    }
    try {
      return JSON.parse(readFileSync(this.filePath, 'utf-8')) as StoreFileShape;
    } catch {
      return { nonces: [], sessions: [] };
    }
  }

  private write(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(this.cache, null, 2), 'utf-8');
  }

  private gc(): void {
    const ts = Date.now();
    this.cache.nonces = this.cache.nonces.filter((n) => !n.used && Date.parse(n.expiresAt) > ts);
    this.cache.sessions = this.cache.sessions.filter((s) => Date.parse(s.expiresAt) > ts);
  }
}

