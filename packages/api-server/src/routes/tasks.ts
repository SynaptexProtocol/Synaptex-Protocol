import { Router, Request, Response } from 'express';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { keccak_256 } from '@noble/hashes/sha3.js';
import type { WsEventType } from '../ws/broadcaster.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export type TaskStatus = 'FUNDED' | 'DONE' | 'RELEASED' | 'REFUNDED';

export interface TaskRecord {
  id: number;
  poster: string;           // address
  taker: string;            // address (agent account or EOA)
  agent_id: string;         // human-readable agent id (e.g. "thunder")
  agent_name: string;       // display name
  amount_wei: string;       // bigint as string
  task_hash: string;        // 0x hex
  task_description: string; // plain text stored off-chain
  result_hash: string | null;
  result_content: string | null; // actual AI output
  deadline: number;         // unix timestamp
  release_after: number | null;
  status: TaskStatus;
  created_at: number;
  delivered_at: number | null;
  released_at: number | null;
}

// ── ABI encoding helpers (no viem) ───────────────────────────────────────────

function pad32(hex: string): string {
  return hex.replace(/^0x/i, '').toLowerCase().padStart(64, '0');
}

function keccakHex(data: string): string {
  const bytes = new TextEncoder().encode(data);
  return '0x' + Buffer.from(keccak_256(bytes)).toString('hex');
}

function keccakBytes(data: Uint8Array): string {
  return '0x' + Buffer.from(keccak_256(data)).toString('hex');
}

// fund(address taker, uint256 amount, uint64 deadline, bytes32 taskHash)
// selector = keccak256("fund(address,uint256,uint64,bytes32)")[0:4]
const SEL_FUND    = '0x5d7b3bbe';
const SEL_DELIVER = '0x0d74d2d7';
const SEL_RELEASE = '0x86d1a69f';
const SEL_REFUND  = '0x7249fbb6';

function encodeFund(taker: string, amountWei: bigint, deadline: number, taskHash: string): string {
  return (
    SEL_FUND +
    pad32(taker) +
    pad32(amountWei.toString(16)) +
    pad32(deadline.toString(16)) +
    pad32(taskHash)
  );
}

function encodeDeliver(taskId: number, resultHash: string): string {
  return SEL_DELIVER + pad32(taskId.toString(16)) + pad32(resultHash);
}

function encodeRelease(taskId: number): string {
  return SEL_RELEASE + pad32(taskId.toString(16));
}

function encodeRefund(taskId: number): string {
  return SEL_REFUND + pad32(taskId.toString(16));
}

// ── Persistent store (JSON file — upgrade to SQLite/Postgres later) ───────────

function getStorePath(stateDir: string): string {
  return join(stateDir, 'tasks.json');
}

function loadTasks(stateDir: string): TaskRecord[] {
  const path = getStorePath(stateDir);
  if (!existsSync(path)) return [];
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as TaskRecord[];
  } catch {
    return [];
  }
}

function saveTasks(stateDir: string, tasks: TaskRecord[]): void {
  const path = getStorePath(stateDir);
  const dir = join(stateDir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(tasks, null, 2));
}

function nextId(tasks: TaskRecord[]): number {
  return tasks.length === 0 ? 1 : Math.max(...tasks.map((t) => t.id)) + 1;
}

// ── Known agents (mirrors arena.yaml, used for display) ─────────────────────

const KNOWN_AGENTS: Record<string, { name: string; account: string }> = {
  thunder: { name: 'Thunder',  account: process.env['THUNDER_ACCOUNT'] ?? '' },
  frost:   { name: 'Frost',    account: process.env['FROST_ACCOUNT']   ?? '' },
  aurora:  { name: 'Aurora',   account: process.env['AURORA_ACCOUNT']  ?? '' },
};

// ── Router factory ────────────────────────────────────────────────────────────

export function createTasksRouter(
  stateDir: string,
  broadcaster?: { broadcast: (type: WsEventType, data: unknown) => void },
): Router {
  const router = Router();
  const escrowAddress = process.env['TASK_ESCROW_ADDRESS'] ?? '';
  const tokenAddress  = process.env['SYNAPTEX_TOKEN_ADDRESS'] ?? '';

  // ── GET /tasks — list tasks (filterable by status, poster, taker) ──────────
  router.get('/', (req: Request, res: Response) => {
    const tasks = loadTasks(stateDir);
    let filtered = tasks;

    if (req.query['status']) {
      filtered = filtered.filter((t) => t.status === req.query['status']);
    }
    if (req.query['poster']) {
      const p = String(req.query['poster']).toLowerCase();
      filtered = filtered.filter((t) => t.poster.toLowerCase() === p);
    }
    if (req.query['taker']) {
      const ta = String(req.query['taker']).toLowerCase();
      filtered = filtered.filter((t) => t.taker.toLowerCase() === ta);
    }
    if (req.query['agent_id']) {
      filtered = filtered.filter((t) => t.agent_id === req.query['agent_id']);
    }

    res.json({ ok: true, data: filtered });
  });

  // ── GET /tasks/:id — single task ──────────────────────────────────────────
  router.get('/:id', (req: Request, res: Response) => {
    const tasks = loadTasks(stateDir);
    const id = Number(req.params['id']);
    const task = tasks.find((t) => t.id === id);
    if (!task) { res.status(404).json({ ok: false, error: 'task not found' }); return; }
    res.json({ ok: true, data: task });
  });

  // ── POST /tasks — create task (poster side) ───────────────────────────────
  // Body: { poster, agent_id, task_description, amount_arena, deadline_hours }
  // Returns: task record + calldata for on-chain fund()
  router.post('/', (req: Request, res: Response) => {
    const { poster, agent_id, task_description, amount_arena, deadline_hours } = req.body as {
      poster: string;
      agent_id: string;
      task_description: string;
      amount_arena: number;
      deadline_hours: number;
    };

    if (!poster || !agent_id || !task_description || !amount_arena || !deadline_hours) {
      res.status(400).json({ ok: false, error: 'Missing required fields: poster, agent_id, task_description, amount_arena, deadline_hours' });
      return;
    }

    const agent = KNOWN_AGENTS[agent_id];
    if (!agent) {
      res.status(400).json({ ok: false, error: `Unknown agent_id: ${agent_id}. Known: ${Object.keys(KNOWN_AGENTS).join(', ')}` });
      return;
    }
    // Account address only required in on-chain mode (when escrow contract is configured)
    if (!agent.account && escrowAddress) {
      res.status(400).json({ ok: false, error: `Agent account address not configured for ${agent_id}. Set ${agent_id.toUpperCase()}_ACCOUNT env.` });
      return;
    }

    const WAD = 10n ** 18n;
    const amountWei = BigInt(Math.round(amount_arena * 1e6)) * (WAD / 1_000_000n);
    const deadlineTs = Math.floor(Date.now() / 1000) + deadline_hours * 3600;
    const taskHash = keccakHex(task_description);

    const tasks = loadTasks(stateDir);
    const id = nextId(tasks);

    const takerAddress = agent.account || '0x0000000000000000000000000000000000000000';
    const record: TaskRecord = {
      id,
      poster: poster.toLowerCase(),
      taker: takerAddress.toLowerCase(),
      agent_id,
      agent_name: agent.name,
      amount_wei: amountWei.toString(),
      task_hash: taskHash,
      task_description,
      result_hash: null,
      result_content: null,
      deadline: deadlineTs,
      release_after: null,
      status: 'FUNDED',
      created_at: Math.floor(Date.now() / 1000),
      delivered_at: null,
      released_at: null,
    };

    tasks.push(record);
    saveTasks(stateDir, tasks);
    broadcaster?.broadcast('task_funded', record);

    // Generate calldata for two on-chain transactions the UI must send:
    // 1. token.approve(escrow, amount)
    // 2. escrow.fund(taker, amount, deadline, taskHash)
    const approveCalldata = tokenAddress
      ? '0x095ea7b3' + pad32(escrowAddress) + pad32(amountWei.toString(16))
      : null;

    const fundCalldata = escrowAddress && agent.account
      ? encodeFund(agent.account, amountWei, deadlineTs, taskHash)
      : null;

    res.status(201).json({
      ok: true,
      data: record,
      calldata: {
        approve: approveCalldata
          ? { to: tokenAddress, data: approveCalldata }
          : null,
        fund: fundCalldata
          ? { to: escrowAddress, data: fundCalldata }
          : null,
        note: escrowAddress ? undefined : 'TASK_ESCROW_ADDRESS not set — off-chain simulation mode',
      },
    });
  });

  // ── POST /tasks/:id/deliver — AI delivers result ───────────────────────────
  // Body: { taker, result_content }
  // Returns: updated task + calldata for on-chain deliver()
  router.post('/:id/deliver', (req: Request, res: Response) => {
    const id = Number(req.params['id']);
    const { taker, result_content } = req.body as { taker: string; result_content: string };

    if (!result_content) {
      res.status(400).json({ ok: false, error: 'Missing result_content' });
      return;
    }

    const tasks = loadTasks(stateDir);
    const idx = tasks.findIndex((t) => t.id === id);
    if (idx === -1) { res.status(404).json({ ok: false, error: 'task not found' }); return; }

    const task = tasks[idx]!;
    if (task.status !== 'FUNDED') {
      res.status(400).json({ ok: false, error: `Task status is ${task.status}, expected FUNDED` });
      return;
    }
    if (taker && task.taker.toLowerCase() !== taker.toLowerCase()) {
      res.status(403).json({ ok: false, error: 'Not the designated taker' });
      return;
    }

    const resultHash = keccakHex(result_content);
    const now = Math.floor(Date.now() / 1000);

    task.result_hash    = resultHash;
    task.result_content = result_content;
    task.status         = 'DONE';
    task.delivered_at   = now;
    task.release_after  = now + 2 * 3600; // 2h dispute window

    saveTasks(stateDir, tasks);
    broadcaster?.broadcast('task_delivered', task);

    const deliverCalldata = escrowAddress
      ? encodeDeliver(id, resultHash)
      : null;

    res.json({
      ok: true,
      data: task,
      calldata: deliverCalldata
        ? { deliver: { to: escrowAddress, data: deliverCalldata } }
        : null,
    });
  });

  // ── POST /tasks/:id/release — poster confirms or auto-release ─────────────
  // Body: { poster } (optional — anyone can trigger after dispute window)
  router.post('/:id/release', (req: Request, res: Response) => {
    const id = Number(req.params['id']);
    const tasks = loadTasks(stateDir);
    const idx = tasks.findIndex((t) => t.id === id);
    if (idx === -1) { res.status(404).json({ ok: false, error: 'task not found' }); return; }

    const task = tasks[idx]!;
    if (task.status !== 'DONE') {
      res.status(400).json({ ok: false, error: `Task status is ${task.status}, expected DONE` });
      return;
    }

    const caller = String(req.body['poster'] ?? '').toLowerCase();
    const now    = Math.floor(Date.now() / 1000);
    const isPoster   = caller && caller === task.poster;
    const isTimedOut = task.release_after != null && now >= task.release_after;

    if (!isPoster && !isTimedOut) {
      res.status(403).json({
        ok: false,
        error: 'Only poster can release now. Auto-release available after dispute window.',
        release_after: task.release_after,
      });
      return;
    }

    task.status      = 'RELEASED';
    task.released_at = now;
    saveTasks(stateDir, tasks);
    broadcaster?.broadcast('task_released', task);

    const releaseCalldata = escrowAddress ? encodeRelease(id) : null;

    res.json({
      ok: true,
      data: task,
      calldata: releaseCalldata
        ? { release: { to: escrowAddress, data: releaseCalldata } }
        : null,
    });
  });

  // ── POST /tasks/:id/refund — poster reclaims if taker missed deadline ──────
  router.post('/:id/refund', (req: Request, res: Response) => {
    const id = Number(req.params['id']);
    const tasks = loadTasks(stateDir);
    const idx = tasks.findIndex((t) => t.id === id);
    if (idx === -1) { res.status(404).json({ ok: false, error: 'task not found' }); return; }

    const task = tasks[idx]!;
    if (task.status !== 'FUNDED') {
      res.status(400).json({ ok: false, error: `Task status is ${task.status}, expected FUNDED` });
      return;
    }
    const now = Math.floor(Date.now() / 1000);
    if (now <= task.deadline) {
      res.status(400).json({ ok: false, error: 'Deadline has not passed yet', deadline: task.deadline });
      return;
    }

    task.status = 'REFUNDED';
    saveTasks(stateDir, tasks);
    broadcaster?.broadcast('task_refunded', task);

    const refundCalldata = escrowAddress ? encodeRefund(id) : null;

    res.json({
      ok: true,
      data: task,
      calldata: refundCalldata
        ? { refund: { to: escrowAddress, data: refundCalldata } }
        : null,
    });
  });

  return router;
}
