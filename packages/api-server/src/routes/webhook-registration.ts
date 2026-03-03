import { Router } from 'express';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import type { ArenaEngine } from '@synaptex/arena-coordinator';
import { WebhookAgent, PromptAgent } from '@synaptex/arena-coordinator';

export interface StoredAgent {
  id: string;
  name: string;
  owner: string;           // wallet address (lowercase)
  agent_type: 'webhook' | 'prompt';
  webhook_url: string;     // 'internal://prompt-agent' for prompt agents
  webhook_secret: string;
  strategy_prompt?: string;
  registered_at: string;
}

const MAX_AGENTS_PER_WALLET = 2;

function loadAgents(filePath: string): StoredAgent[] {
  if (!existsSync(filePath)) return [];
  try { return JSON.parse(readFileSync(filePath, 'utf-8')) as StoredAgent[]; }
  catch { return []; }
}

function saveAgents(filePath: string, agents: StoredAgent[]): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(agents, null, 2), 'utf-8');
}

function maskAgent(a: StoredAgent): StoredAgent {
  return { ...a, webhook_secret: '***' };
}

export function createWebhookRegistrationRouter(engine: ArenaEngine, stateDir: string): Router {
  const router = Router();
  const filePath = join(stateDir, 'webhook_agents.json');

  // GET /api/v1/webhook-agents
  router.get('/', (_req, res) => {
    const agents = loadAgents(filePath);
    res.json({ ok: true, data: agents.map(maskAgent) });
  });

  // POST /api/v1/webhook-agents
  router.post('/', (req, res) => {
    const body = req.body as Record<string, string>;
    const { id, name, agent_type, webhook_url, webhook_secret, strategy_prompt } = body;
    const owner = (body['owner'] ?? 'anonymous').toLowerCase();
    const type = (agent_type === 'prompt' ? 'prompt' : 'webhook') as 'webhook' | 'prompt';

    if (!id || !name) {
      res.status(400).json({ ok: false, error: 'Required: id, name' });
      return;
    }
    if (!/^[a-z0-9_-]{3,32}$/.test(id)) {
      res.status(400).json({ ok: false, error: 'id must be 3-32 chars: a-z, 0-9, -, _' });
      return;
    }

    if (type === 'webhook') {
      if (!webhook_url || !webhook_secret) {
        res.status(400).json({ ok: false, error: 'Webhook agent requires: webhook_url, webhook_secret' });
        return;
      }
      if (webhook_secret.length < 16) {
        res.status(400).json({ ok: false, error: 'webhook_secret must be at least 16 chars' });
        return;
      }
    } else {
      if (!strategy_prompt || strategy_prompt.trim().length < 20) {
        res.status(400).json({ ok: false, error: 'Prompt agent requires: strategy_prompt (min 20 chars)' });
        return;
      }
    }

    const agents = loadAgents(filePath);

    if (agents.find(a => a.id === id)) {
      res.status(409).json({ ok: false, error: `Agent ID "${id}" already registered` });
      return;
    }

    // Enforce per-wallet limit (skip for anonymous)
    if (owner !== 'anonymous') {
      const walletCount = agents.filter(a => a.owner === owner).length;
      if (walletCount >= MAX_AGENTS_PER_WALLET) {
        res.status(429).json({
          ok: false,
          error: `Wallet already has ${MAX_AGENTS_PER_WALLET} agents (limit reached)`,
        });
        return;
      }
    }

    const entry: StoredAgent = {
      id,
      name,
      owner,
      agent_type: type,
      webhook_url: type === 'webhook' ? (webhook_url ?? '') : 'internal://prompt-agent',
      webhook_secret: webhook_secret ?? '',
      registered_at: new Date().toISOString(),
    };
    if (type === 'prompt' && strategy_prompt) {
      entry.strategy_prompt = strategy_prompt.trim();
    }

    agents.push(entry);
    saveAgents(filePath, agents);

    if (type === 'webhook') {
      engine.registerAgent(new WebhookAgent({
        id: entry.id,
        name: entry.name,
        owner: entry.owner,
        webhookUrl: entry.webhook_url,
        webhookSecret: entry.webhook_secret,
        timeoutMs: 5000,
      }));
    } else {
      engine.registerAgent(new PromptAgent({
        id: entry.id,
        name: entry.name,
        owner: entry.owner,
        strategyPrompt: entry.strategy_prompt ?? '',
      }));
    }

    res.json({ ok: true, data: maskAgent(entry) });
  });

  // DELETE /api/v1/webhook-agents/:id
  router.delete('/:id', (req, res) => {
    const agents = loadAgents(filePath);
    const idx = agents.findIndex(a => a.id === req.params['id']);
    if (idx === -1) {
      res.status(404).json({ ok: false, error: 'Agent not found' });
      return;
    }
    agents.splice(idx, 1);
    saveAgents(filePath, agents);
    engine.unregisterAgent(req.params['id'] ?? '');
    res.json({ ok: true });
  });

  return router;
}

/** Load persisted agents into engine on startup. */
export function loadPersistedWebhookAgents(engine: ArenaEngine, stateDir: string): void {
  const filePath = join(stateDir, 'webhook_agents.json');
  const agents = loadAgents(filePath);
  let count = 0;
  for (const a of agents) {
    if (a.agent_type === 'prompt') {
      engine.registerAgent(new PromptAgent({
        id: a.id,
        name: a.name,
        owner: a.owner,
        strategyPrompt: a.strategy_prompt ?? '',
      }));
    } else {
      engine.registerAgent(new WebhookAgent({
        id: a.id,
        name: a.name,
        owner: a.owner,
        webhookUrl: a.webhook_url,
        webhookSecret: a.webhook_secret,
        timeoutMs: 5000,
      }));
    }
    count++;
  }
  if (count > 0) {
    console.log(`[Arena] Loaded ${count} persisted agent(s)`);
  }
}
