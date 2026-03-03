import { appendFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

export interface AuditEvent {
  category: string;
  action: string;
  actor?: string;
  trace_id?: string;
  status: 'ok' | 'error';
  detail?: Record<string, unknown>;
}

export class AuditLog {
  constructor(private readonly filePath: string) {}

  write(event: AuditEvent): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    appendFileSync(
      this.filePath,
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        ...event,
      })}\n`,
      'utf-8',
    );
  }
}

