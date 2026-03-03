/**
 * task-worker.ts — Background task processor
 *
 * Polls for FUNDED tasks and calls Claude API to deliver AI analysis.
 * Runs entirely within the Node.js API server — no Python required.
 * Interval: every 30 seconds.
 */

import type { WsBroadcaster } from '../ws/broadcaster.js';

const POLL_INTERVAL_MS = 30_000;

interface TaskRecord {
  id: number;
  agent_id: string;
  taker: string;
  task_description: string;
  status: string;
}

interface AnthropicContent { type: string; text: string; }
interface AnthropicResponse { content?: AnthropicContent[]; }

function detectTaskType(description: string): string {
  const d = description.toLowerCase();
  if (/走势|分析|analysis|行情|方向/.test(d)) return 'market_analysis';
  if (/信号|signal|买入|卖出|入场/.test(d)) return 'signal_request';
  if (/回测|backtest|历史|策略测试/.test(d)) return 'backtest_report';
  if (/相关|correlation|关联/.test(d)) return 'correlation';
  return 'general';
}

function buildPrompt(type: string, description: string): string {
  const base = `You are an AI trading agent on the Synaptex Protocol.
Task: ${description}

`;
  switch (type) {
    case 'market_analysis':
      return base + `Provide a structured market analysis. Format as JSON:
{"trend":"Bullish|Bearish|Sideways","support":0,"resistance":0,"outlook":"...","confidence":0,"summary":"..."}`;
    case 'signal_request':
      return base + `Generate a trading signal. Format as JSON:
{"action":"BUY|SELL|HOLD","entry_low":0,"entry_high":0,"target":0,"stop_loss":0,"confidence":0,"reasoning":"..."}`;
    case 'backtest_report':
      return base + `Generate a backtest report. Format as JSON:
{"strategy":"...","win_rate":0,"avg_profit_pct":0,"max_drawdown_pct":0,"verdict":"RECOMMENDED|NEUTRAL|AVOID","notes":"..."}`;
    case 'correlation':
      return base + `Analyze asset correlation. Format as JSON:
{"assets":[],"correlation":0,"r_squared":0,"trend":"MOVING_TOGETHER|DIVERGING|UNCORRELATED","implication":"..."}`;
    default:
      return base + `Answer clearly and concisely. Format as JSON: {"result":"..."}`;
  }
}

async function callClaude(apiKey: string, prompt: string): Promise<string> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  const data = await res.json() as AnthropicResponse;
  return data.content?.[0]?.text ?? '{"result":"No response"}';
}

function mockResponse(type: string): string {
  switch (type) {
    case 'market_analysis':
      return JSON.stringify({ trend: 'Bullish', support: 570, resistance: 620, outlook: 'Short-term upward pressure', confidence: 68, summary: 'Market showing bullish signals with moderate conviction.' });
    case 'signal_request':
      return JSON.stringify({ action: 'BUY', entry_low: 575, entry_high: 585, target: 615, stop_loss: 558, confidence: 62, reasoning: 'RSI recovering from oversold. Price above key MA.' });
    case 'correlation':
      return JSON.stringify({ assets: ['BTC', 'BNB'], correlation: 0.87, r_squared: 0.76, trend: 'MOVING_TOGETHER', implication: 'BNB closely tracks BTC; use BTC as leading indicator.' });
    default:
      return JSON.stringify({ result: 'Task analysis complete. Mock response (set ANTHROPIC_API_KEY for real AI).' });
  }
}

export function startTaskWorker(
  apiBase: string,
  broadcaster?: WsBroadcaster,
): void {
  const apiKey = process.env['ANTHROPIC_API_KEY'];

  async function processPendingTasks(): Promise<void> {
    try {
      const res = await fetch(`${apiBase}/api/v1/tasks?status=FUNDED`);
      if (!res.ok) return;
      const body = await res.json() as { ok: boolean; data: TaskRecord[] };
      if (!body.ok || !body.data.length) return;

      for (const task of body.data.slice(0, 3)) {
        try {
          const type = detectTaskType(task.task_description);
          const prompt = buildPrompt(type, task.task_description);

          let result: string;
          if (apiKey) {
            result = await callClaude(apiKey, prompt);
          } else {
            result = mockResponse(type);
          }

          const deliverRes = await fetch(`${apiBase}/api/v1/tasks/${task.id}/deliver`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ taker: task.taker, result_content: result }),
          });

          if (deliverRes.ok) {
            console.log(`[TaskWorker] Delivered task #${task.id} (${type}) via ${apiKey ? 'Claude' : 'mock'}`);
          }
        } catch (err) {
          console.error(`[TaskWorker] Error processing task #${task.id}:`, err);
        }
      }
    } catch (err) {
      console.error('[TaskWorker] Poll error:', err);
    }
  }

  // Run immediately on startup, then every 30s
  void processPendingTasks();
  setInterval(() => void processPendingTasks(), POLL_INTERVAL_MS);
  console.log(`[TaskWorker] Started (poll every ${POLL_INTERVAL_MS / 1000}s, AI: ${apiKey ? 'Claude' : 'mock'})`);
}
