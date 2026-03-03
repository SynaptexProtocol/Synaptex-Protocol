type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const configuredLevel = (process.env['LOG_LEVEL'] ?? 'info') as LogLevel;

function log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
  if (LEVELS[level] < LEVELS[configuredLevel]) return;
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...(data ? { data } : {}),
  };
  const line = JSON.stringify(entry);
  if (level === 'error') {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }
}

export const logger = {
  debug: (msg: string, data?: Record<string, unknown>) => log('debug', msg, data),
  info: (msg: string, data?: Record<string, unknown>) => log('info', msg, data),
  warn: (msg: string, data?: Record<string, unknown>) => log('warn', msg, data),
  error: (msg: string, data?: Record<string, unknown>) => log('error', msg, data),
};
