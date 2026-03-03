import { Router } from 'express';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import type { ArenaEngine } from '@synaptex/arena-coordinator';

interface SeasonHistoryItem {
  id: string;
  status: string;
  start_time: string;
  end_time: string;
  duration_days: number;
  cycle_count: number;
  agent_ids: string[];
  settlement_algorithm: string;
  leaderboard_hash?: string;
}

function parseLimit(raw: string | undefined): number {
  const n = Number(raw ?? '20');
  if (!Number.isFinite(n)) return 20;
  const i = Math.floor(n);
  if (i <= 0) return 20;
  return Math.min(i, 200);
}

function parseOffset(raw: string | undefined): number {
  const n = Number(raw ?? '0');
  if (!Number.isFinite(n)) return 0;
  const i = Math.floor(n);
  if (i < 0) return 0;
  return i;
}

export function createArenaRouter(engine: ArenaEngine, stateDir: string): Router {
  const router = Router();

  // GET /api/v1/leaderboard — current season live leaderboard
  router.get('/leaderboard', (_req, res) => {
    const entries = engine.getLeaderboard();
    res.json({ ok: true, data: entries });
  });

  // GET /api/v1/season/current — current season metadata
  router.get('/season/current', (_req, res) => {
    const season = engine.getSeason();
    if (!season) {
      res.status(404).json({ ok: false, error: 'No active season' });
      return;
    }
    res.json({ ok: true, data: season });
  });

  // GET /api/v1/agents — agent registry with live stats, strategy tags, and type
  router.get('/agents', (_req, res) => {
    const data = engine.getAgentRegistry();
    res.json({ ok: true, data });
  });

  // GET /api/v1/agents/:id — single agent details
  router.get('/agents/:id', (req, res) => {
    const portfolio = engine.getAgentPortfolio(req.params['id']);
    if (!portfolio) {
      res.status(404).json({ ok: false, error: 'Agent not found' });
      return;
    }
    res.json({ ok: true, data: portfolio });
  });

  // GET /api/v1/agents/:id/trades — virtual trade history
  router.get('/agents/:id/trades', (req, res) => {
    const trades = engine.getAgentTrades(req.params['id']);
    res.json({ ok: true, data: trades });
  });

  // GET /api/v1/agents/:id/signals — signal history
  router.get('/agents/:id/signals', (req, res) => {
    const signals = engine.getAgentSignals(req.params['id']);
    res.json({ ok: true, data: signals });
  });

  // GET /api/v1/leaderboard/history?limit=20 鈥?settled season history
  router.get('/leaderboard/history', (req, res) => {
    try {
      const limit = parseLimit(req.query['limit']?.toString());
      const seasonsDir = join(stateDir, 'seasons');
      if (!existsSync(seasonsDir)) {
        res.json({ ok: true, data: [], total: 0, limit });
        return;
      }
      const files = readdirSync(seasonsDir).filter((f) => f.endsWith('.json'));
      const rows: SeasonHistoryItem[] = [];

      for (const file of files) {
        const fullPath = join(seasonsDir, file);
        try {
          const parsed = JSON.parse(readFileSync(fullPath, 'utf-8')) as SeasonHistoryItem;
          rows.push(parsed);
        } catch {
          // Skip broken archive files to keep endpoint resilient
        }
      }

      rows.sort((a, b) => {
        const ta = Date.parse(a.end_time ?? a.start_time ?? '');
        const tb = Date.parse(b.end_time ?? b.start_time ?? '');
        return tb - ta;
      });

      res.json({ ok: true, data: rows.slice(0, limit), total: rows.length, limit });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // GET /api/v1/replay/decisions?limit=100 -- latest deterministic replay rows
  router.get('/replay/decisions', (req, res) => {
    try {
      const limit = parseLimit(req.query['limit']?.toString());
      const offset = parseOffset(req.query['offset']?.toString());
      const agentId = String(req.query['agent_id'] ?? '').trim();
      const seasonId = String(req.query['season_id'] ?? '').trim();
      const replayPath = join(stateDir, 'agent_decision_replay.jsonl');
      if (!existsSync(replayPath)) {
        res.json({ ok: true, data: [], total: 0, limit, offset });
        return;
      }
      const lines = readFileSync(replayPath, 'utf-8')
        .split('\n')
        .map((v) => v.trim())
        .filter(Boolean);
      const all = lines
        .map((line) => {
          try {
            return JSON.parse(line) as Record<string, unknown>;
          } catch {
            return null;
          }
        })
        .filter((v): v is Record<string, unknown> => v !== null)
        .filter((row) => !agentId || String(row['agent_id'] ?? '') === agentId)
        .filter((row) => !seasonId || String(row['season_id'] ?? '') === seasonId);
      const total = all.length;
      const start = Math.max(0, total - offset - limit);
      const end = Math.max(0, total - offset);
      const data = all.slice(start, end);
      res.json({ ok: true, data, total, limit, offset });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // GET /api/v1/audit/logs?limit=100&offset=0&category=auth&action=verify&status=ok
  router.get('/audit/logs', (req, res) => {
    try {
      const limit = parseLimit(req.query['limit']?.toString());
      const offset = parseOffset(req.query['offset']?.toString());
      const category = String(req.query['category'] ?? '').trim();
      const action = String(req.query['action'] ?? '').trim();
      const status = String(req.query['status'] ?? '').trim();
      const actor = String(req.query['actor'] ?? '').trim();

      const path = join(stateDir, 'audit_log.jsonl');
      if (!existsSync(path)) {
        res.json({ ok: true, data: [], total: 0, limit, offset });
        return;
      }

      const all = readFileSync(path, 'utf-8')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line) as Record<string, unknown>;
          } catch {
            return null;
          }
        })
        .filter((v): v is Record<string, unknown> => v !== null)
        .filter((row) => !category || String(row['category'] ?? '') === category)
        .filter((row) => !action || String(row['action'] ?? '') === action)
        .filter((row) => !status || String(row['status'] ?? '') === status)
        .filter((row) => !actor || String(row['actor'] ?? '') === actor);

      const total = all.length;
      const start = Math.max(0, total - offset - limit);
      const end = Math.max(0, total - offset);
      const data = all.slice(start, end);
      res.json({ ok: true, data, total, limit, offset });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  return router;
}
