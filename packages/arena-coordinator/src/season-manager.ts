import { randomUUID } from 'crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import type { Season, SeasonStatus, SeasonPreset } from './types/season.js';
import { SEASON_PRESET_MINUTES } from './types/season.js';

export class SeasonManager {
  private season: Season | null = null;
  private readonly stateDir: string;

  constructor(stateDir = 'state/arena') {
    this.stateDir = stateDir;
    this.ensureDir();
    this.load();
  }

  private ensureDir(): void {
    mkdirSync(join(this.stateDir, 'seasons'), { recursive: true });
  }

  private load(): void {
    const path = join(this.stateDir, 'season_current.json');
    if (existsSync(path)) {
      try {
        const raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<Season>;
        // Backwards-compat: old seasons only have duration_days
        if (raw.duration_days !== undefined && raw.duration_minutes === undefined) {
          raw.duration_minutes = (raw.duration_days ?? 1) * 24 * 60;
        }
        this.season = raw as Season;
      } catch {
        this.season = null;
      }
    }
  }

  private save(): void {
    if (!this.season) return;
    writeFileSync(
      join(this.stateDir, 'season_current.json'),
      JSON.stringify(this.season, null, 2),
    );
  }

  getCurrent(): Season | null {
    return this.season;
  }

  isActive(): boolean {
    return this.season?.status === 'active';
  }

  /**
   * Start a new season.
   *
   * @param durationMinutes - total season length in minutes
   * @param agentIds
   * @param algorithm
   * @param preset - optional label ('micro' | 'hourly' | 'daily' | 'weekly' | 'custom')
   */
  startNewSeason(
    durationMinutes: number,
    agentIds: string[],
    algorithm: string,
    preset?: SeasonPreset,
  ): Season {
    const now = new Date();
    const end = new Date(now.getTime() + durationMinutes * 60 * 1000);

    this.season = {
      id: `season-${randomUUID().slice(0, 8)}`,
      status: 'active',
      start_time: now.toISOString(),
      end_time: end.toISOString(),
      duration_minutes: durationMinutes,
      duration_days: durationMinutes / 1440,
      preset: preset ?? this.inferPreset(durationMinutes),
      cycle_count: 0,
      agent_ids: agentIds,
      settlement_algorithm: algorithm,
    };

    this.save();
    return this.season;
  }

  incrementCycle(): void {
    if (this.season) {
      this.season.cycle_count++;
      this.save();
    }
  }

  transitionTo(status: SeasonStatus, extra?: Partial<Season>): Season {
    if (!this.season) throw new Error('No active season');
    this.season = { ...this.season, ...extra, status };
    if (status === 'settled') {
      this.season.settled_at = new Date().toISOString();
    }
    this.save();

    if (status === 'settled') {
      writeFileSync(
        join(this.stateDir, 'seasons', `${this.season.id}.json`),
        JSON.stringify(this.season, null, 2),
      );
    }

    return this.season;
  }

  isExpired(): boolean {
    if (!this.season || this.season.status !== 'active') return false;
    return new Date() >= new Date(this.season.end_time);
  }

  /** Return a human-readable remaining time string, e.g. "47m 12s" or "2h 3m" */
  remainingLabel(): string {
    if (!this.season || this.season.status !== 'active') return '—';
    const remainMs = new Date(this.season.end_time).getTime() - Date.now();
    if (remainMs <= 0) return 'expired';
    const totalSec = Math.floor(remainMs / 1000);
    const hours   = Math.floor(totalSec / 3600);
    const minutes = Math.floor((totalSec % 3600) / 60);
    const seconds = totalSec % 60;
    if (hours > 0) return `${hours}h ${minutes}m`;
    if (minutes > 0) return `${minutes}m ${seconds}s`;
    return `${seconds}s`;
  }

  private inferPreset(minutes: number): SeasonPreset {
    if (minutes <= 15)       return 'micro';
    if (minutes <= 60)       return 'hourly';
    if (minutes <= 60 * 24)  return 'daily';
    if (minutes <= 60 * 24 * 7) return 'weekly';
    return 'custom';
  }

  /** Helper: create duration in minutes from a preset name */
  static minutesFromPreset(preset: SeasonPreset, customMinutes?: number): number {
    if (preset === 'custom') {
      if (!customMinutes || customMinutes < 1) throw new Error('custom preset requires customMinutes');
      return customMinutes;
    }
    return SEASON_PRESET_MINUTES[preset];
  }
}
