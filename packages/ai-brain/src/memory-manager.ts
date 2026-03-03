import type { AgentMemoryEntry } from '@synaptex/core';
import { readJsonOrDefault, writeJsonAtomic } from '@synaptex/core/utils/file-state.js';

export class MemoryManager {
  constructor(
    private readonly filePath: string,
    private readonly maxEntries: number = 20,
  ) {}

  load(): AgentMemoryEntry[] {
    return readJsonOrDefault<AgentMemoryEntry[]>(this.filePath, []);
  }

  append(entry: Omit<AgentMemoryEntry, 'timestamp'>): void {
    const memory = this.load();
    memory.push({ ...entry, timestamp: new Date().toISOString() });
    writeJsonAtomic(this.filePath, memory.slice(-this.maxEntries));
  }

  getRecent(n: number): AgentMemoryEntry[] {
    return this.load().slice(-n);
  }
}
