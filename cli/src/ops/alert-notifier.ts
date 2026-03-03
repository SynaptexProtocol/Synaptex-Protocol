import { appendFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { createHash } from 'crypto';

export interface AlertEvent {
  level: 'warn' | 'error';
  category: string;
  message: string;
  context?: Record<string, unknown>;
}

export interface IAlertNotifier {
  notify(event: AlertEvent): Promise<void>;
}

class NoopAlertNotifier implements IAlertNotifier {
  async notify(_event: AlertEvent): Promise<void> {}
}

class RoutedAlertNotifier implements IAlertNotifier {
  constructor(
    private readonly fallback?: IAlertNotifier,
    private readonly perLevel?: Partial<Record<AlertEvent['level'], IAlertNotifier>>
  ) {}

  async notify(event: AlertEvent): Promise<void> {
    const target = this.perLevel?.[event.level] ?? this.fallback;
    if (!target) return;
    await target.notify(event);
  }
}

interface GuardedNotifierOptions {
  dedupWindowMs: number;
  rateLimitWindowMs: number;
  rateLimitMax: number;
}

class GuardedAlertNotifier implements IAlertNotifier {
  private readonly dedupUntil = new Map<string, number>();
  private readonly rateWindow = new Map<string, { windowStart: number; count: number }>();

  constructor(private readonly inner: IAlertNotifier, private readonly opts: GuardedNotifierOptions) {}

  async notify(event: AlertEvent): Promise<void> {
    const now = Date.now();
    const dedupKey = this.buildDedupKey(event);
    const dedupUntil = this.dedupUntil.get(dedupKey) ?? 0;
    if (dedupUntil > now) return;
    this.dedupUntil.set(dedupKey, now + this.opts.dedupWindowMs);

    const rateKey = `${event.level}:${event.category}`;
    const bucket = this.rateWindow.get(rateKey);
    if (!bucket || now - bucket.windowStart >= this.opts.rateLimitWindowMs) {
      this.rateWindow.set(rateKey, { windowStart: now, count: 1 });
    } else {
      if (bucket.count >= this.opts.rateLimitMax) return;
      bucket.count += 1;
      this.rateWindow.set(rateKey, bucket);
    }

    await this.inner.notify(event);
  }

  private buildDedupKey(event: AlertEvent): string {
    const payload = JSON.stringify({
      level: event.level,
      category: event.category,
      message: event.message,
      context: event.context ?? {},
    });
    return createHash('sha256').update(payload).digest('hex');
  }
}

interface WebhookNotifierOptions {
  timeoutMs: number;
  maxAttempts: number;
  backoffMs: number;
  authToken?: string;
  deadLetterPath?: string;
}

class WebhookAlertNotifier implements IAlertNotifier {
  constructor(private readonly endpoint: string, private readonly opts: WebhookNotifierOptions) {}

  async notify(event: AlertEvent): Promise<void> {
    const payload = {
      timestamp: new Date().toISOString(),
      ...event,
    };

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Arena-Alert-Version': '1.0',
    };
    if (this.opts.authToken) headers['Authorization'] = `Bearer ${this.opts.authToken}`;

    const body = JSON.stringify(payload);
    let lastError = 'unknown error';
    for (let attempt = 1; attempt <= this.opts.maxAttempts; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
      try {
        const res = await fetch(this.endpoint, {
          method: 'POST',
          headers,
          body,
          signal: controller.signal,
        });
        if (!res.ok) {
          const text = await res.text();
          throw new Error(`HTTP ${res.status}: ${text}`);
        }
        clearTimeout(timer);
        return;
      } catch (err) {
        clearTimeout(timer);
        lastError = err instanceof Error ? err.message : String(err);
        if (attempt < this.opts.maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, this.opts.backoffMs * attempt));
        }
      }
    }

    if (this.opts.deadLetterPath) {
      mkdirSync(dirname(this.opts.deadLetterPath), { recursive: true });
      appendFileSync(this.opts.deadLetterPath, `${JSON.stringify({ payload, lastError })}\n`, 'utf-8');
    }
    throw new Error(`Alert webhook failed after ${this.opts.maxAttempts} attempts: ${lastError}`);
  }
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const normalized = Math.floor(parsed);
  return normalized > 0 ? normalized : fallback;
}

export function createAlertNotifier(): IAlertNotifier {
  const sharedOpts: WebhookNotifierOptions = {
    timeoutMs: parsePositiveInt(process.env['ARENA_ALERT_TIMEOUT_MS'], 5000),
    maxAttempts: parsePositiveInt(process.env['ARENA_ALERT_MAX_ATTEMPTS'], 3),
    backoffMs: parsePositiveInt(process.env['ARENA_ALERT_BACKOFF_MS'], 500),
    deadLetterPath: process.env['ARENA_ALERT_DLQ_PATH']?.trim(),
  };

  const defaultEndpoint = process.env['ARENA_ALERT_WEBHOOK_URL']?.trim();
  const defaultToken = process.env['ARENA_ALERT_AUTH_TOKEN']?.trim();
  const warnEndpoint = process.env['ARENA_ALERT_WEBHOOK_URL_WARN']?.trim();
  const errorEndpoint = process.env['ARENA_ALERT_WEBHOOK_URL_ERROR']?.trim();
  const warnToken = process.env['ARENA_ALERT_AUTH_TOKEN_WARN']?.trim() ?? defaultToken;
  const errorToken = process.env['ARENA_ALERT_AUTH_TOKEN_ERROR']?.trim() ?? defaultToken;

  const fallback = defaultEndpoint
    ? new WebhookAlertNotifier(defaultEndpoint, {
        ...sharedOpts,
        authToken: defaultToken,
      })
    : undefined;

  const perLevel: Partial<Record<AlertEvent['level'], IAlertNotifier>> = {};
  if (warnEndpoint) {
    perLevel.warn = new WebhookAlertNotifier(warnEndpoint, {
      ...sharedOpts,
      authToken: warnToken,
    });
  }
  if (errorEndpoint) {
    perLevel.error = new WebhookAlertNotifier(errorEndpoint, {
      ...sharedOpts,
      authToken: errorToken,
    });
  }

  if (!fallback && !perLevel.warn && !perLevel.error) return new NoopAlertNotifier();

  const routed = new RoutedAlertNotifier(fallback, perLevel);
  return new GuardedAlertNotifier(routed, {
    dedupWindowMs: parsePositiveInt(process.env['ARENA_ALERT_DEDUP_WINDOW_MS'], 60_000),
    rateLimitWindowMs: parsePositiveInt(process.env['ARENA_ALERT_RATE_LIMIT_WINDOW_MS'], 60_000),
    rateLimitMax: parsePositiveInt(process.env['ARENA_ALERT_RATE_LIMIT_MAX'], 20),
  });
}
