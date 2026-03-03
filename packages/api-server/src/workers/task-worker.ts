/**
 * task-worker.ts — Background task processor
 *
 * Polls for FUNDED tasks every 30s and delivers AI analysis.
 * Auto-detects which LLM API key is available (priority order):
 *   1. OpenAI       (OPENAI_API_KEY)
 *   2. DeepSeek     (DEEPSEEK_API_KEY)
 *   3. Gemini       (GEMINI_API_KEY)
 *   4. Anthropic    (ANTHROPIC_API_KEY)
 *   5. mock         (no key — deterministic response)
 */

const POLL_INTERVAL_MS = 30_000;

interface TaskRecord {
  id: number;
  agent_id: string;
  taker: string;
  task_description: string;
  status: string;
}

// ── Provider detection ──────────────────────────────────────────────────────

type Provider = 'openai' | 'deepseek' | 'gemini' | 'anthropic' | 'mock';

function detectProvider(): { provider: Provider; apiKey: string } {
  const checks: [string, Provider][] = [
    ['OPENAI_API_KEY',    'openai'],
    ['DEEPSEEK_API_KEY',  'deepseek'],
    ['GEMINI_API_KEY',    'gemini'],
    ['ANTHROPIC_API_KEY', 'anthropic'],
  ];
  for (const [envVar, provider] of checks) {
    const key = process.env[envVar];
    if (key) return { provider, apiKey: key };
  }
  return { provider: 'mock', apiKey: '' };
}

// ── LLM callers (raw fetch, no SDK) ────────────────────────────────────────

async function callOpenAiCompatible(
  apiKey: string,
  baseUrl: string,
  model: string,
  prompt: string,
): Promise<string> {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      max_tokens: 512,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`${baseUrl} ${res.status}: ${await res.text()}`);
  const data = await res.json() as { choices?: { message?: { content?: string } }[] };
  return data.choices?.[0]?.message?.content ?? '{"result":"No response"}';
}

async function callAnthropic(apiKey: string, prompt: string): Promise<string> {
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
  const data = await res.json() as { content?: { type: string; text: string }[] };
  return data.content?.[0]?.text ?? '{"result":"No response"}';
}

async function callGemini(apiKey: string, prompt: string): Promise<string> {
  const model = 'gemini-2.0-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
  const data = await res.json() as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? '{"result":"No response"}';
}

async function callLlm(provider: Provider, apiKey: string, prompt: string): Promise<string> {
  switch (provider) {
    case 'openai':
      return callOpenAiCompatible(apiKey, 'https://api.openai.com/v1', 'gpt-4o-mini', prompt);
    case 'deepseek':
      return callOpenAiCompatible(apiKey, 'https://api.deepseek.com/v1', 'deepseek-chat', prompt);
    case 'gemini':
      return callGemini(apiKey, prompt);
    case 'anthropic':
      return callAnthropic(apiKey, prompt);
    case 'mock':
      return mockResponse(detectTaskType(prompt));
  }
}

// ── Prompt building ─────────────────────────────────────────────────────────

function detectTaskType(text: string): string {
  const d = text.toLowerCase();
  if (/走势|行情|分析|analysis|方向/.test(d)) return 'market_analysis';
  if (/信号|signal|买入|卖出|入场/.test(d)) return 'signal_request';
  if (/回测|backtest|历史|策略测试/.test(d)) return 'backtest_report';
  if (/相关|correlation|关联/.test(d)) return 'correlation';
  return 'general';
}

function buildPrompt(type: string, description: string): string {
  const base = `You are an AI trading agent on the Synaptex Protocol.\nTask: ${description}\n\n`;
  switch (type) {
    case 'market_analysis':
      return base + 'Provide structured market analysis as JSON:\n{"trend":"Bullish|Bearish|Sideways","support":0,"resistance":0,"outlook":"...","confidence":0,"summary":"..."}';
    case 'signal_request':
      return base + 'Generate a trading signal as JSON:\n{"action":"BUY|SELL|HOLD","entry_low":0,"entry_high":0,"target":0,"stop_loss":0,"confidence":0,"reasoning":"..."}';
    case 'backtest_report':
      return base + 'Generate a backtest report as JSON:\n{"strategy":"...","win_rate":0,"avg_profit_pct":0,"max_drawdown_pct":0,"verdict":"RECOMMENDED|NEUTRAL|AVOID","notes":"..."}';
    case 'correlation':
      return base + 'Analyze asset correlation as JSON:\n{"assets":[],"correlation":0,"r_squared":0,"trend":"MOVING_TOGETHER|DIVERGING|UNCORRELATED","implication":"..."}';
    default:
      return base + 'Answer clearly and concisely as JSON: {"result":"..."}';
  }
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
      return JSON.stringify({ result: 'Task analysis complete. Set an AI API key env var for real responses.' });
  }
}

// ── Worker loop ─────────────────────────────────────────────────────────────

export function startTaskWorker(apiBase: string): void {
  const { provider, apiKey } = detectProvider();
  console.log(`[TaskWorker] Started — provider: ${provider}, poll every ${POLL_INTERVAL_MS / 1000}s`);

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
          const result = await callLlm(provider, apiKey, prompt);

          const deliverRes = await fetch(`${apiBase}/api/v1/tasks/${task.id}/deliver`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ taker: task.taker, result_content: result }),
          });

          if (deliverRes.ok) {
            console.log(`[TaskWorker] Delivered #${task.id} (${type}) via ${provider}`);
          }
        } catch (err) {
          console.error(`[TaskWorker] Error on task #${task.id}:`, err);
        }
      }
    } catch (err) {
      console.error('[TaskWorker] Poll error:', err);
    }
  }

  void processPendingTasks();
  setInterval(() => void processPendingTasks(), POLL_INTERVAL_MS);
}
