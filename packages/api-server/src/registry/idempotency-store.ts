import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';

interface IdempotencyRecord {
  key: string;
  request_hash: string;
  response: unknown;
  created_at: string;
}

interface StoreShape {
  records: IdempotencyRecord[];
}

export class IdempotencyStore {
  private cache: StoreShape;

  constructor(private readonly filePath: string, private readonly maxRecords = 5000) {
    this.cache = this.read();
  }

  hashPayload(payload: unknown): string {
    return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  }

  get(key: string): IdempotencyRecord | null {
    return this.cache.records.find((r) => r.key === key) ?? null;
  }

  save(key: string, requestHash: string, response: unknown): void {
    this.cache.records.push({
      key,
      request_hash: requestHash,
      response,
      created_at: new Date().toISOString(),
    });
    if (this.cache.records.length > this.maxRecords) {
      this.cache.records = this.cache.records.slice(this.cache.records.length - this.maxRecords);
    }
    this.write();
  }

  private read(): StoreShape {
    if (!existsSync(this.filePath)) return { records: [] };
    try {
      return JSON.parse(readFileSync(this.filePath, 'utf-8')) as StoreShape;
    } catch {
      return { records: [] };
    }
  }

  private write(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(this.cache, null, 2), 'utf-8');
  }
}

