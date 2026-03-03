import fs from 'fs';
import path from 'path';

// Atomic file write: write to temp then rename to prevent corruption
export function writeJsonAtomic(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

export function readJsonOrDefault<T>(filePath: string, defaultValue: T): T {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return defaultValue;
  }
}

export function appendJsonLine(filePath: string, entry: unknown): void {
  fs.appendFileSync(filePath, JSON.stringify(entry) + '\n', 'utf-8');
}
