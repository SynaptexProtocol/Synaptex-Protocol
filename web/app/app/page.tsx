'use client';
import { useEffect, useState, useRef, useCallback } from 'react';
import { useI18n, LangToggle } from '../../lib/i18n';

// ── Types ──────────────────────────────────────────────────────────────────

type LeaderboardEntry = {
  rank: number;
  agent_id: string;
  agent_name: string;
  roi: number;
  total_value_usd: number;
  signal_count: number;
  trade_count: number;
  is_valid: boolean;
  settlement_weight: number;
  agent_type?: string;
  owner?: string;
  strategy_tags?: string[];
};

type HealthData = {
  ok: boolean;
  season: string;
  ws_clients: number;
  timestamp: string;
};

type VaultConfig = {
  vault_address: string | null;
  token_address: string | null;
  chain_id: number;
  rpc_url: string | null;
};

type AgentStakeInfo = {
  agent_key: string;
  agent_name: string;
  user_stake_wei: string;
  total_stake_wei: string;
  weight_wad: string;
  claimable_wei: string;
  agent_claimed: boolean;
};

type UserVaultData = {
  season_key: string;
  user: string;
  settled: boolean;
  claimed: boolean;
  total_pool_wei: string;
  total_claimable_wei: string;
  agents: AgentStakeInfo[];
};

type TaskStatus = 'FUNDED' | 'DONE' | 'RELEASED' | 'REFUNDED';

type TaskRecord = {
  id: number;
  poster: string;
  taker: string;
  agent_id: string;
  agent_name: string;
  amount_wei: string;
  task_description: string;
  result_content: string | null;
  result_hash: string | null;
  deadline: number;
  release_after: number | null;
  status: TaskStatus;
  created_at: number;
  delivered_at: number | null;
  released_at: number | null;
};

type FeedEvent = {
  id: string;
  type: 'funded' | 'working' | 'done' | 'released' | 'refunded';
  text: string;
  time: string;
};

// ── Constants ──────────────────────────────────────────────────────────────

const API_BASE =
  typeof window !== 'undefined'
    ? (process.env.NEXT_PUBLIC_ARENA_API_URL ?? 'http://127.0.0.1:3000')
    : 'http://127.0.0.1:3000';

// Derive WS URL directly from NEXT_PUBLIC_ARENA_API_URL (not API_BASE which uses window check)
const WS_URL = (process.env.NEXT_PUBLIC_ARENA_API_URL ?? 'http://127.0.0.1:3000')
  .replace(/^https/, 'wss').replace(/^http(?!s)/, 'ws') + '/ws';

const WAD = 10n ** 18n;

const SEL = {
  approve:      '0x095ea7b3',
  stake:        '0x7acb7757',
  claimRewards: '0x372500ab',
};

// ── Helpers ────────────────────────────────────────────────────────────────

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

function formatEther(wei: string): string {
  try {
    const n = BigInt(wei);
    const whole = n / WAD;
    const frac = ((n % WAD) * 10000n) / WAD;
    return `${whole}.${frac.toString().padStart(4, '0')}`;
  } catch {
    return '0.0000';
  }
}

function parseEther(val: string): bigint {
  const [whole = '0', frac = ''] = val.split('.');
  const fracPadded = frac.slice(0, 18).padEnd(18, '0');
  return BigInt(whole) * WAD + BigInt(fracPadded);
}

function pad32(hex: string): string {
  return hex.replace(/^0x/i, '').toLowerCase().padStart(64, '0');
}

function encodeApprove(spender: string, amount: bigint): string {
  return SEL.approve + pad32(spender) + pad32(amount.toString(16));
}

function encodeStake(seasonKey: string, agentKey: string, amount: bigint): string {
  return SEL.stake + pad32(seasonKey) + pad32(agentKey) + pad32(amount.toString(16));
}

function encodeClaimRewards(seasonKey: string, agentKeys: string[]): string {
  const offset = pad32('40');
  const length = pad32(agentKeys.length.toString(16));
  const keys = agentKeys.map((k) => pad32(k)).join('');
  return SEL.claimRewards + pad32(seasonKey) + offset + length + keys;
}

let _activeProvider: Eip1193Provider | null = null;

async function sendTx(from: string, to: string, data: string): Promise<string | null> {
  try {
    const eth = _activeProvider ?? (window as unknown as { ethereum?: Eip1193Provider }).ethereum;
    if (!eth) return null;
    const txHash = await eth.request({
      method: 'eth_sendTransaction',
      params: [{ from, to, data, gas: '0x55730' }],
    }) as string;
    return txHash;
  } catch {
    return null;
  }
}

async function fetchKeyHash(id: string): Promise<string | null> {
  const res = await fetchJson<{ ok: boolean; key: string }>(`${API_BASE}/api/v1/vault/keyhash?id=${encodeURIComponent(id)}`);
  return res?.ok ? res.key : null;
}

// ── Wallet provider detection ──────────────────────────────────────────────

type Eip1193Provider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  on?: (event: string, handler: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, handler: (...args: unknown[]) => void) => void;
  isBinanceChain?: boolean;
  isOkxWallet?: boolean;
  isRainbow?: boolean;
  providers?: Eip1193Provider[];
};

type WalletId = 'binance' | 'okx' | 'rainbow';

const WALLET_OPTIONS: { id: WalletId; label: string; icon: string; hint: string }[] = [
  { id: 'binance', label: '币安钱包',    icon: '🟡', hint: 'Binance Web3 Wallet' },
  { id: 'okx',     label: 'OKX Wallet', icon: '⬛', hint: 'OKX Web3 Wallet' },
  { id: 'rainbow', label: 'Rainbow',    icon: '🌈', hint: 'Rainbow Wallet Extension' },
];

function getProvider(id: WalletId): Eip1193Provider | null {
  const w = window as unknown as {
    ethereum?: Eip1193Provider;
    BinanceChain?: Eip1193Provider;
    okxwallet?: Eip1193Provider;
  };
  if (id === 'binance') {
    if (w.BinanceChain) return w.BinanceChain;
    if (w.ethereum?.isBinanceChain) return w.ethereum;
    return w.ethereum?.providers?.find(p => p.isBinanceChain) ?? null;
  }
  if (id === 'okx') {
    if (w.okxwallet) return w.okxwallet;
    if (w.ethereum?.isOkxWallet) return w.ethereum;
    return w.ethereum?.providers?.find(p => p.isOkxWallet) ?? null;
  }
  if (id === 'rainbow') {
    if (w.ethereum?.isRainbow) return w.ethereum;
    return w.ethereum?.providers?.find(p => p.isRainbow) ?? null;
  }
  return null;
}

// ── Sub-components ─────────────────────────────────────────────────────────

function RankBadge({ rank }: { rank: number }) {
  const labels: Record<number, string> = { 1: '1st', 2: '2nd', 3: '3rd' };
  const label = labels[rank] ?? `#${rank}`;
  const cls = rank === 1 ? 'rank-1' : rank === 2 ? 'rank-2' : rank === 3 ? 'rank-3' : 'rank-n';
  return <span className={`rank-badge ${cls}`}>{label}</span>;
}

function RoiCell({ roi }: { roi: number }) {
  const pct = (roi * 100).toFixed(2);
  const cls = roi > 0 ? 'roi-pos' : roi < 0 ? 'roi-neg' : 'roi-neu';
  return <span className={cls}>{roi > 0 ? '+' : ''}{pct}%</span>;
}

const AGENTS = [
  { id: 'thunder', name: 'Thunder (Claude)' },
  { id: 'frost',   name: 'Frost (GPT-4o)' },
  { id: 'aurora',  name: 'Aurora (Gemini)' },
];

const TASK_TEMPLATES = [
  { labelKey: 'task_tpl1' as const, descKey: 'task_tpl1_desc' as const, amount: 5,  hours: 4 },
  { labelKey: 'task_tpl2' as const, descKey: 'task_tpl2_desc' as const, amount: 8,  hours: 2 },
  { labelKey: 'task_tpl3' as const, descKey: 'task_tpl3_desc' as const, amount: 15, hours: 6 },
  { labelKey: 'task_tpl4' as const, descKey: 'task_tpl4_desc' as const, amount: 25, hours: 8 },
];

function TaskStatusBadge({ status }: { status: TaskStatus }) {
  const { t } = useI18n();
  const map: Record<TaskStatus, { cls: string; label: string }> = {
    FUNDED:   { cls: 'tag tag-blue',         label: t('task_status_active') },
    DONE:     { cls: 'tag tag-green',        label: t('task_status_pending') },
    RELEASED: { cls: 'task-badge-released',  label: t('task_status_done') },
    REFUNDED: { cls: 'task-badge-refunded',  label: t('task_status_refund') },
  };
  const m = map[status];
  return <span className={m.cls}>{m.label}</span>;
}

function ResultDisplay({ content }: { content: string }) {
  try {
    const obj = JSON.parse(content) as Record<string, unknown>;
    return (
      <div className="result-display">
        {Object.entries(obj).map(([k, v]) => (
          <div key={k} className="result-row">
            <span className="result-key">{k}</span>
            <span className="result-val">{String(v)}</span>
          </div>
        ))}
      </div>
    );
  } catch {
    return <div className="result-display result-text">{content}</div>;
  }
}

function TaskPipelineBar({ tasks }: { tasks: TaskRecord[] }) {
  const { t } = useI18n();
  const funded   = tasks.filter(tk => tk.status === 'FUNDED').length;
  const done     = tasks.filter(tk => tk.status === 'DONE').length;
  const released = tasks.filter(tk => tk.status === 'RELEASED').length;
  const refunded = tasks.filter(tk => tk.status === 'REFUNDED').length;

  type Stage = { label: string; sublabel: string; count: number; cls: 'active' | 'done' | 'idle'; icon: string; countCls?: string };
  const stages: Stage[] = [
    { label: t('task_pipeline_funded'),   sublabel: t('task_pipeline_waiting'),   count: funded,   cls: funded > 0   ? 'active' : 'idle', icon: '⚡', countCls: 'gold' },
    { label: t('task_pipeline_working'),  sublabel: t('task_pipeline_analyzing'), count: funded,   cls: funded > 0   ? 'active' : 'idle', icon: '🤖' },
    { label: t('task_pipeline_done'),     sublabel: t('task_pipeline_done_sub'),  count: done,     cls: done > 0     ? 'active' : 'idle', icon: '📋' },
    { label: t('task_pipeline_complete'), sublabel: `+${released} / ${refunded}`, count: released, cls: released > 0 ? 'done'   : 'idle', icon: '✓', countCls: 'green' },
  ];

  return (
    <div className="task-pipeline">
      {stages.map((stage, i) => (
        <div key={stage.label} style={{ display: 'flex', alignItems: 'center', flex: i < stages.length - 1 ? 1 : undefined }}>
          <div className="pipeline-node">
            <div className={`pipeline-dot ${stage.cls}`}>
              {stage.cls === 'active' && (i === 0 || i === 1)
                ? <span className="ai-spinner" style={{ width: 12, height: 12, borderWidth: 2 }} />
                : <span style={{ fontSize: 12 }}>{stage.icon}</span>
              }
              {stage.count > 0 && (
                <span className={`pipeline-count${stage.countCls ? ` ${stage.countCls}` : ''}`}>{stage.count}</span>
              )}
            </div>
            <span className={`pipeline-label ${stage.cls}`}>{stage.label}</span>
            <span style={{ fontSize: 9, color: 'var(--muted)', textAlign: 'center', whiteSpace: 'nowrap' }}>{stage.sublabel}</span>
          </div>
          {i < stages.length - 1 && <span className="pipeline-arrow">→</span>}
        </div>
      ))}
    </div>
  );
}

function ActivityFeed({ events }: { events: FeedEvent[] }) {
  const { t } = useI18n();
  const feedRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (feedRef.current) feedRef.current.scrollTop = feedRef.current.scrollHeight;
  }, [events]);
  return (
    <div className="task-feed-wrap">
      <div className="task-feed-title">{t('task_feed_title')}</div>
      <div className="task-feed" ref={feedRef}>
        {events.length === 0
          ? <span className="feed-empty">{t('task_feed_empty')}</span>
          : events.map(ev => (
            <div key={ev.id} className="feed-item">
              <span className={`feed-dot ${ev.type}`} />
              <span className="feed-text">{ev.text}</span>
              <span className="feed-time">{ev.time}</span>
            </div>
          ))
        }
      </div>
    </div>
  );
}

function AnimatedTaskCard({
  task, wallet, releaseLoading, onRelease, prevStatus,
}: {
  task: TaskRecord;
  wallet: string | null;
  releaseLoading: number | null;
  onRelease: (id: number) => void;
  prevStatus: TaskStatus | undefined;
}) {
  const { t } = useI18n();
  const [animClass, setAnimClass] = useState('');

  useEffect(() => {
    let cls = '';
    if (prevStatus === undefined) cls = 'just-created';
    else if (prevStatus !== task.status) {
      if (task.status === 'DONE')     cls = 'just-done';
      if (task.status === 'RELEASED') cls = 'just-released';
    }
    if (!cls) return;
    setAnimClass(cls);
    const tk = setTimeout(() => setAnimClass(''), 1600);
    return () => clearTimeout(tk);
  }, [task.status, prevStatus]);

  const isWorking = task.status === 'FUNDED';
  const canRelease = task.status === 'DONE' && wallet && task.poster.toLowerCase() === wallet.toLowerCase();

  return (
    <div className={`task-card ${animClass}`}>
      <div className="task-card-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span className="task-card-id">#{task.id}</span>
          <span style={{ fontSize: 11, color: 'var(--muted)' }}>{task.agent_name}</span>
        </div>
        <TaskStatusBadge status={task.status} />
      </div>
      <div className="task-card-desc">{task.task_description}</div>
      {isWorking && <div className="ai-working-badge"><span className="ai-spinner" />{t('task_ai_working')}</div>}
      <div className="task-card-meta">
        <span>{formatEther(task.amount_wei)} SYNPTX</span>
        <span>{new Date(task.created_at * 1000).toLocaleTimeString()}</span>
      </div>
      {task.result_content && (
        <div className="result-reveal" style={{ marginTop: 8 }}>
          <div className="task-result-label" style={{ marginBottom: 4 }}>{t('task_result_label')}</div>
          <ResultDisplay content={task.result_content} />
        </div>
      )}
      {canRelease && (
        <button className="btn-claim" style={{ marginTop: 8 }} onClick={() => onRelease(task.id)} disabled={releaseLoading === task.id}>
          {releaseLoading === task.id ? t('task_confirming') : `✓ ${t('task_confirm_btn')} ${formatEther(task.amount_wei)} SYNPTX`}
        </button>
      )}
      {task.status === 'DONE' && task.release_after && (
        <div className="task-auto-release">
          {Date.now() / 1000 < task.release_after
            ? `⏱ ${t('task_auto_release')} ${new Date(task.release_after * 1000).toLocaleTimeString()}`
            : t('task_can_release')}
        </div>
      )}
    </div>
  );
}

function TaskMarketPanel({ wallet, agents, onTaskCreated }: { wallet: string | null; agents: LeaderboardEntry[]; onTaskCreated: () => void; }) {
  const { t } = useI18n();
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [selectedAgent, setSelectedAgent] = useState('thunder');
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('5');
  const [deadlineHours, setDeadlineHours] = useState('4');
  const [submitting, setSubmitting] = useState(false);
  const [releaseLoading, setReleaseLoading] = useState<number | null>(null);
  const [msg, setMsg] = useState('');
  const [feedEvents, setFeedEvents] = useState<FeedEvent[]>([]);
  const prevTasksRef = useRef<Map<number, TaskStatus>>(new Map());

  const pushFeed = useCallback((type: FeedEvent['type'], text: string) => {
    const ev: FeedEvent = { id: `${Date.now()}-${Math.random()}`, type, text, time: new Date().toLocaleTimeString() };
    setFeedEvents(prev => [...prev.slice(-49), ev]);
  }, []);

  const loadTasks = useCallback(async () => {
    const res = await fetchJson<{ ok: boolean; data: TaskRecord[] }>(`${API_BASE}/api/v1/tasks`);
    if (res?.ok) setTasks(res.data.slice().reverse());
  }, []);

  useEffect(() => { void loadTasks(); }, [loadTasks]);

  useEffect(() => {
    const wsUrl = WS_URL;
    if (wsUrl) {
      let ws: WebSocket;
      try {
        ws = new WebSocket(wsUrl);
        ws.onmessage = (evt) => {
          try {
            const m = JSON.parse(evt.data as string) as { type: string; data: TaskRecord };
            if (m.type === 'task_funded')    { setTasks(p => [m.data, ...p.filter(tk => tk.id !== m.data.id)]); pushFeed('funded',   `${t('task_feed_funded')} ${m.data.agent_name}`); }
            else if (m.type === 'task_delivered') { setTasks(p => p.map(tk => tk.id === m.data.id ? m.data : tk)); pushFeed('done',     `#${m.data.id} ${t('task_feed_done')}`); }
            else if (m.type === 'task_released')  { setTasks(p => p.map(tk => tk.id === m.data.id ? m.data : tk)); pushFeed('released', `#${m.data.id} ${t('task_feed_released')}`); }
            else if (m.type === 'task_refunded')  { setTasks(p => p.map(tk => tk.id === m.data.id ? m.data : tk)); pushFeed('refunded', `#${m.data.id} ${t('task_feed_refunded')}`); }
          } catch {}
        };
        ws.onerror = () => {};
      } catch {}
      return () => { try { ws?.close(); } catch {} };
    } else {
      const iv = setInterval(() => void loadTasks(), 8000);
      return () => clearInterval(iv);
    }
  }, [loadTasks, pushFeed]);

  useEffect(() => { tasks.forEach(tk => prevTasksRef.current.set(tk.id, tk.status)); }, [tasks]);

  const applyTemplate = (tpl: typeof TASK_TEMPLATES[0]) => {
    setDescription(t(tpl.descKey));
    setAmount(String(tpl.amount));
    setDeadlineHours(String(tpl.hours));
  };

  const handlePost = async () => {
    if (!description || !amount || !selectedAgent) return;
    setSubmitting(true); setMsg('');
    try {
      const res = await fetch(`${API_BASE}/api/v1/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ poster: wallet ?? '0x0000000000000000000000000000000000000001', agent_id: selectedAgent, task_description: description, amount_arena: Number(amount), deadline_hours: Number(deadlineHours) }),
      });
      const data = await res.json() as { ok: boolean; error?: string };
      if (data.ok) {
        setMsg(t('task_success'));
        pushFeed('funded', `${t('task_feed_funded')} ${selectedAgent} — ${description.slice(0, 30)}…`);
        setDescription('');
        void loadTasks();
        onTaskCreated();
      } else {
        setMsg(`${t('task_post_fail')} ${data.error ?? 'unknown error'}`);
      }
    } catch (e) {
      setMsg(`${t('task_net_err')} ${String(e)}`);
    } finally {
      setSubmitting(false);
    }
  };

  const handleRelease = async (taskId: number) => {
    setReleaseLoading(taskId);
    try {
      const res = await fetch(`${API_BASE}/api/v1/tasks/${taskId}/release`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ poster: wallet }) });
      const data = await res.json() as { ok: boolean; error?: string };
      if (data.ok) void loadTasks();
      else setMsg(`${t('task_release_fail')} ${data.error ?? ''}`);
    } finally {
      setReleaseLoading(null);
    }
  };

  const fundedCount   = tasks.filter(t => t.status === 'FUNDED').length;
  const doneCount     = tasks.filter(t => t.status === 'DONE').length;
  const releasedCount = tasks.filter(t => t.status === 'RELEASED').length;

  return (
    <div className="task-market">
      <TaskPipelineBar tasks={tasks} />
      <div className="task-stats">
        <div className="task-stat"><span className="task-stat-val accent">{fundedCount}</span><span className="task-stat-lbl">{t('task_stat_active')}</span></div>
        <div className="task-stat"><span className="task-stat-val green">{doneCount}</span><span className="task-stat-lbl">{t('task_stat_pending')}</span></div>
        <div className="task-stat"><span className="task-stat-val gold">{releasedCount}</span><span className="task-stat-lbl">{t('task_stat_done')}</span></div>
        <div className="task-stat"><span className="task-stat-val">{tasks.length}</span><span className="task-stat-lbl">{t('task_stat_total')}</span></div>
      </div>
      <ActivityFeed events={feedEvents} />
      <div className="task-layout">
        <div className="task-post-panel">
          <div className="stake-panel-title">{t('task_post_title')}</div>
          <div className="stake-panel-sub">{t('task_post_sub')}</div>
          <div>
            <div className="task-field-label">{t('task_templates')}</div>
            <div className="task-templates">
              {TASK_TEMPLATES.map(tpl => <button key={tpl.labelKey} className="task-tpl-btn" onClick={() => applyTemplate(tpl)}>{t(tpl.labelKey)}</button>)}
            </div>
          </div>
          <div className="stake-field">
            <label>{t('task_agent_lbl')}</label>
            <select value={selectedAgent} onChange={e => setSelectedAgent(e.target.value)} disabled={submitting}>
              {AGENTS.map(a => {
                const entry = agents.find(r => r.agent_id === a.id);
                const roi = entry ? ` · ROI ${(entry.roi * 100).toFixed(1)}%` : '';
                return <option key={a.id} value={a.id}>{a.name}{roi}</option>;
              })}
            </select>
          </div>
          <div className="stake-field">
            <label>{t('task_desc_lbl')}</label>
            <textarea className="task-textarea" placeholder={t('task_desc_ph')} value={description} onChange={e => setDescription(e.target.value)} disabled={submitting} rows={3} />
          </div>
          <div className="task-row-fields">
            <div className="stake-field" style={{ flex: 1 }}>
              <label>{t('task_reward_lbl')}</label>
              <input type="number" min="1" max="10000" value={amount} onChange={e => setAmount(e.target.value)} disabled={submitting} />
            </div>
            <div className="stake-field" style={{ flex: 1 }}>
              <label>{t('task_deadline_lbl')}</label>
              <input type="number" min="1" max="168" value={deadlineHours} onChange={e => setDeadlineHours(e.target.value)} disabled={submitting} />
            </div>
          </div>
          {!wallet && <div className="stake-notice">{t('task_no_wallet')}</div>}
          <button className="btn-stake" onClick={() => void handlePost()} disabled={submitting || !description || !amount}>
            {submitting ? t('task_submitting') : t('task_submit')}
          </button>
          {msg && <div className={msg.includes('成功') ? 'stake-success' : 'stake-error'}>{msg}</div>}
        </div>
        <div className="task-list-panel">
          <div className="stake-panel-title">{t('task_list_title')}</div>
          {tasks.length === 0
            ? <div className="stake-notice">{t('task_list_empty')}</div>
            : <div className="task-list">
                {tasks.map(task => (
                  <AnimatedTaskCard key={task.id} task={task} wallet={wallet} releaseLoading={releaseLoading} onRelease={id => void handleRelease(id)} prevStatus={prevTasksRef.current.get(task.id)} />
                ))}
              </div>
          }
        </div>
      </div>
    </div>
  );
}

function WalletBar({ wallet, onConnect, onDisconnect }: { wallet: string | null; onConnect: (id: WalletId) => void; onDisconnect: () => void; }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  if (wallet) {
    return (
      <div className="wallet-bar">
        <span className="wallet-addr">{wallet.slice(0, 6)}…{wallet.slice(-4)}</span>
        <button className="btn-disconnect" onClick={onDisconnect}>{t('wallet_disco')}</button>
      </div>
    );
  }
  return (
    <div className="wallet-selector-wrap">
      <button className="btn-connect" onClick={() => setOpen(o => !o)}>{t('wallet_connect')}</button>
      {open && (
        <div className="wallet-dropdown">
          {WALLET_OPTIONS.map(opt => (
            <button key={opt.id} className="wallet-option" onClick={() => { setOpen(false); onConnect(opt.id); }}>
              <span className="wallet-option-icon">{opt.icon}</span>
              <span className="wallet-option-label">{opt.label}</span>
              <span className="wallet-option-hint">{opt.hint}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function StakePanel({ wallet, vaultCfg, agents, seasonId }: { wallet: string | null; vaultCfg: VaultConfig | null; agents: LeaderboardEntry[]; seasonId: string; }) {
  const { t } = useI18n();
  const [selectedAgent, setSelectedAgent] = useState('');
  const [amount, setAmount] = useState('');
  const [status, setStatus] = useState<'idle' | 'approving' | 'staking' | 'done' | 'error'>('idle');
  const [txHash, setTxHash] = useState<string | null>(null);
  const [errMsg, setErrMsg] = useState('');

  const handleStake = useCallback(async () => {
    if (!wallet || !vaultCfg?.vault_address || !vaultCfg.token_address) return;
    if (!selectedAgent || !amount) return;
    setStatus('approving'); setErrMsg('');
    const amountWei = parseEther(amount);
    const approveTx = await sendTx(wallet, vaultCfg.token_address, encodeApprove(vaultCfg.vault_address, amountWei));
    if (!approveTx) { setStatus('error'); setErrMsg('Approve cancelled or failed'); return; }
    setStatus('staking');
    const [seasonKey, agentKey] = await Promise.all([fetchKeyHash(seasonId), fetchKeyHash(selectedAgent)]);
    if (!seasonKey || !agentKey) { setStatus('error'); setErrMsg('Could not compute season/agent keys'); return; }
    const stakeTx = await sendTx(wallet, vaultCfg.vault_address, encodeStake(seasonKey, agentKey, amountWei));
    if (!stakeTx) { setStatus('error'); setErrMsg('Stake cancelled or failed'); return; }
    setTxHash(stakeTx); setStatus('done');
  }, [wallet, vaultCfg, selectedAgent, amount, seasonId]);

  const vaultAvailable = !!(vaultCfg?.vault_address && vaultCfg.token_address);
  return (
    <div className="stake-panel">
      <div className="stake-panel-title">{t('stake_title')}</div>
      <div className="stake-panel-sub">{t('stake_sub')}</div>
      {!vaultAvailable && <div className="stake-notice">{t('stake_no_vault')}</div>}
      {vaultAvailable && (
        <>
          <div className="stake-field">
            <label>{t('stake_agent')}</label>
            <select value={selectedAgent} onChange={e => setSelectedAgent(e.target.value)} disabled={!wallet || status === 'approving' || status === 'staking'}>
              <option value="">{t('stake_select')}</option>
              {agents.map(a => <option key={a.agent_id} value={a.agent_id}>{a.agent_name} ({a.agent_id})</option>)}
            </select>
          </div>
          <div className="stake-field">
            <label>{t('stake_amount')}</label>
            <input type="number" min="0" step="0.01" placeholder="e.g. 100" value={amount} onChange={e => setAmount(e.target.value)} disabled={!wallet || status === 'approving' || status === 'staking'} />
          </div>
          {!wallet
            ? <div className="stake-notice">{t('stake_no_wallet')}</div>
            : <button className="btn-stake" onClick={() => void handleStake()} disabled={!selectedAgent || !amount || status === 'approving' || status === 'staking'}>
                {status === 'approving' ? t('stake_approving') : status === 'staking' ? t('stake_staking') : t('stake_btn')}
              </button>
          }
          {status === 'done' && txHash && <div className="stake-success">Staked! Tx: <code>{txHash.slice(0, 14)}…</code></div>}
          {status === 'error' && <div className="stake-error">{errMsg}</div>}
        </>
      )}
    </div>
  );
}

function ClaimPanel({ wallet, vaultCfg, userVaultData, seasonId, agents, onRefresh }: { wallet: string | null; vaultCfg: VaultConfig | null; userVaultData: UserVaultData | null; seasonId: string; agents: LeaderboardEntry[]; onRefresh: () => void; }) {
  const { t } = useI18n();
  const [claiming, setClaiming] = useState(false);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [errMsg, setErrMsg] = useState('');

  const handleClaimAll = useCallback(async () => {
    if (!wallet || !vaultCfg?.vault_address || !userVaultData) return;
    const claimable = userVaultData.agents.filter(a => BigInt(a.claimable_wei) > 0n && !a.agent_claimed);
    if (claimable.length === 0) return;
    setClaiming(true); setErrMsg('');
    const seasonKey = await fetchKeyHash(seasonId);
    if (!seasonKey) { setClaiming(false); setErrMsg('Could not compute season key'); return; }
    const tx = await sendTx(wallet, vaultCfg.vault_address, encodeClaimRewards(seasonKey, claimable.map(a => a.agent_key)));
    setClaiming(false);
    if (!tx) { setErrMsg('Claim cancelled or failed'); return; }
    setTxHash(tx); onRefresh();
  }, [wallet, vaultCfg, userVaultData, seasonId, onRefresh]);

  const vaultAvailable = !!(vaultCfg?.vault_address);
  const totalClaimable = userVaultData ? BigInt(userVaultData.total_claimable_wei) : 0n;

  return (
    <div className="claim-panel">
      <div className="stake-panel-title">{t('claim_title')}</div>
      <div className="stake-panel-sub">{t('claim_sub')}</div>
      {!vaultAvailable && <div className="stake-notice">{t('claim_no_vault')}</div>}
      {vaultAvailable && !wallet && <div className="stake-notice">{t('claim_no_wallet')}</div>}
      {vaultAvailable && wallet && !userVaultData && <div className="stake-notice">{t('claim_no_stake')}</div>}
      {vaultAvailable && wallet && userVaultData && (
        <>
          <div className="claim-summary">
            <div className="claim-row"><span className="claim-label">{t('claim_pool')}</span><span className="claim-value">{formatEther(userVaultData.total_pool_wei)} SYNPTX</span></div>
            <div className="claim-row"><span className="claim-label">{t('claim_settled')}</span><span className={`claim-value ${userVaultData.settled ? 'green' : ''}`}>{userVaultData.settled ? t('claim_yes') : t('claim_no')}</span></div>
            <div className="claim-row"><span className="claim-label">{t('claim_claimable')}</span><span className="claim-value gold">{formatEther(userVaultData.total_claimable_wei)} SYNPTX</span></div>
          </div>
          {userVaultData.agents.length > 0 && (
            <div className="agent-claim-list">
              {userVaultData.agents.map(a => {
                const name = agents.find(e => e.agent_id === a.agent_key)?.agent_name ?? a.agent_key.slice(0, 10) + '…';
                const claimableWei = BigInt(a.claimable_wei);
                return (
                  <div key={a.agent_key} className="agent-claim-row">
                    <div>
                      <div className="agent-name">{name}</div>
                      <div className="agent-model">{t('claim_staked')} {formatEther(a.user_stake_wei)} · {t('claim_weight_lbl')} {(Number(BigInt(a.weight_wad) * 10000n / WAD) / 100).toFixed(2)}%</div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div className={claimableWei > 0n ? 'roi-pos' : 'roi-neu'}>{formatEther(a.claimable_wei)} SYNPTX</div>
                      {a.agent_claimed && <span className="tag tag-green" style={{ fontSize: 10 }}>{t('claim_yes')}</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {totalClaimable > 0n && !userVaultData.claimed && (
            <button className="btn-claim" onClick={() => void handleClaimAll()} disabled={claiming}>
              {claiming ? t('claim_ing') : `Claim All (${formatEther(userVaultData.total_claimable_wei)} SYNPTX)`}
            </button>
          )}
          {userVaultData.claimed && <div className="stake-success">{t('claim_all_done')}</div>}
          {txHash && <div className="stake-success">Claimed! Tx: <code>{txHash.slice(0, 14)}…</code></div>}
          {errMsg && <div className="stake-error">{errMsg}</div>}
        </>
      )}
    </div>
  );
}

// ── Register Agent Panel ─────────────────────────────────────────────────────

type StoredAgent = {
  id: string;
  name: string;
  owner: string;
  agent_type: 'webhook' | 'prompt';
  webhook_url: string;
  webhook_secret: string;
  strategy_prompt?: string;
  registered_at: string;
};

const MAX_AGENTS_PER_WALLET = 2;

function RegisterAgentPanel({ wallet }: { wallet: string | null }) {
  const { t } = useI18n();
  const [agents, setAgents] = useState<StoredAgent[]>([]);
  const [agentType, setAgentType] = useState<'webhook' | 'prompt'>('webhook');
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [webhookUrl, setWebhookUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [strategyPrompt, setStrategyPrompt] = useState('');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');

  const loadAgents = useCallback(async () => {
    const res = await fetchJson<{ ok: boolean; data: StoredAgent[] }>(`${API_BASE}/api/v1/webhook-agents`);
    if (res?.ok) setAgents(res.data);
  }, []);

  useEffect(() => { void loadAgents(); }, [loadAgents]);

  const myAgents = wallet ? agents.filter(a => a.owner === wallet.toLowerCase()) : [];
  const atLimit = myAgents.length >= MAX_AGENTS_PER_WALLET;

  const genSecret = () => {
    const arr = new Uint8Array(24);
    crypto.getRandomValues(arr);
    setSecret(Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join(''));
  };

  const handleRegister = async () => {
    setErr(''); setOk('');
    if (!id || !name) { setErr(t('reg_fill_all')); return; }
    if (agentType === 'webhook' && (!webhookUrl || !secret)) { setErr(t('reg_fill_all')); return; }
    if (agentType === 'prompt' && strategyPrompt.trim().length < 20) { setErr(t('reg_fill_all')); return; }
    setLoading(true);
    try {
      const body: Record<string, string> = {
        id, name,
        owner: wallet ?? 'anonymous',
        agent_type: agentType,
        webhook_url: webhookUrl,
        webhook_secret: secret,
        strategy_prompt: strategyPrompt,
      };
      const res = await fetch(`${API_BASE}/api/v1/webhook-agents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json() as { ok: boolean; error?: string };
      if (!data.ok) { setErr(data.error ?? 'Registration failed'); return; }
      setOk(t('reg_success'));
      setId(''); setName(''); setWebhookUrl(''); setSecret(''); setStrategyPrompt('');
      void loadAgents();
    } catch (e) {
      setErr(String(e));
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (agentId: string) => {
    if (!confirm(`${t('reg_unregister_confirm')} "${agentId}"?`)) return;
    await fetch(`${API_BASE}/api/v1/webhook-agents/${agentId}`, { method: 'DELETE' });
    void loadAgents();
  };

  // Not connected
  if (!wallet) {
    return (
      <div className="register-agent-root">
        <div className="card" style={{ textAlign: 'center', padding: '48px 24px' }}>
          <div style={{ fontSize: 36, marginBottom: 12 }}>🔒</div>
          <div className="feature-title" style={{ marginBottom: 8 }}>{t('reg_wallet_req')}</div>
          <div style={{ color: 'var(--muted)', fontSize: 14 }}>{t('reg_wallet_req_sub')}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="register-agent-root">
      {/* Webhook API guide — only shown in webhook mode */}
      {agentType === 'webhook' && (
        <div className="card register-guide">
          <div className="register-guide-title">{t('reg_guide_title')}</div>
          <p style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 12 }}>{t('reg_guide_sub')}</p>
          <div className="register-code-grid">
            <div>
              <div className="register-code-label">{t('reg_guide_req')}</div>
              <pre className="register-code">{`{
  "agent_id": "your-agent",
  "snapshot": {
    "tokens": {
      "BNB":  { "price": 600.5, "change24h": 0.02 },
      "BTCB": { "price": 95000, "change24h": -0.01 }
    }
  },
  "portfolio": {
    "cash_usd": 8500,
    "total_value_usd": 10200,
    "roi": 0.02
  }
}`}</pre>
            </div>
            <div>
              <div className="register-code-label">{t('reg_guide_res')}</div>
              <pre className="register-code">{`{
  "signals": [
    {
      "token": "BNB",
      "action": "BUY",
      "amount_usd": 500,
      "confidence": 0.8,
      "reason": "momentum breakout"
    }
  ]
}
// Tokens: BNB | BTCB | USDT
// Actions: BUY | SELL | HOLD`}</pre>
            </div>
          </div>
        </div>
      )}

      {/* Registration form */}
      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div className="feature-title">{t('reg_title')}</div>
          <div style={{ color: 'var(--muted)', fontSize: 13 }}>
            {myAgents.length}/{MAX_AGENTS_PER_WALLET} {t('reg_count')}
          </div>
        </div>

        {atLimit ? (
          <div className="stake-error">{t('reg_limit')}</div>
        ) : (
          <>
            {/* Agent type toggle */}
            <div style={{ marginBottom: 16 }}>
              <div className="register-label" style={{ marginBottom: 8 }}>{t('reg_mode_label')}</div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  className={agentType === 'webhook' ? 'register-btn' : 'register-gen-btn'}
                  onClick={() => setAgentType('webhook')}
                  type="button"
                  style={{ flex: 1, padding: '8px 0' }}
                >
                  {t('reg_webhook_mode')}
                </button>
                <button
                  className={agentType === 'prompt' ? 'register-btn' : 'register-gen-btn'}
                  onClick={() => setAgentType('prompt')}
                  type="button"
                  style={{ flex: 1, padding: '8px 0' }}
                >
                  {t('reg_prompt_mode')}
                </button>
              </div>
            </div>

            <div className="register-form">
              <label className="register-label">
                {t('reg_id_label')} <span className="register-hint">({t('reg_id_hint')})</span>
                <input className="register-input" placeholder="my-agent" value={id} onChange={e => setId(e.target.value)} />
              </label>
              <label className="register-label">
                {t('reg_name_label')}
                <input className="register-input" placeholder={t('reg_name_ph')} value={name} onChange={e => setName(e.target.value)} />
              </label>

              {agentType === 'webhook' ? (
                <>
                  <label className="register-label">
                    {t('reg_url_label')}
                    <input className="register-input" placeholder={t('reg_url_ph')} value={webhookUrl} onChange={e => setWebhookUrl(e.target.value)} />
                  </label>
                  <label className="register-label">
                    {t('reg_secret_label')} <span className="register-hint">({t('reg_secret_hint')})</span>
                    <div className="register-secret-row">
                      <input className="register-input" type="password" placeholder={t('reg_secret_ph')} value={secret} onChange={e => setSecret(e.target.value)} />
                      <button className="register-gen-btn" onClick={genSecret} type="button">{t('reg_secret_gen')}</button>
                    </div>
                    {secret && (
                      <div className="register-secret-preview">
                        <code>{secret}</code>
                        <span style={{ color: 'var(--muted)', fontSize: 11 }}> {t('reg_secret_copy')}</span>
                      </div>
                    )}
                  </label>
                </>
              ) : (
                <label className="register-label">
                  {t('reg_prompt_label')}
                  <textarea
                    className="register-input"
                    rows={5}
                    placeholder={t('reg_prompt_ph')}
                    value={strategyPrompt}
                    onChange={e => setStrategyPrompt(e.target.value)}
                    style={{ resize: 'vertical', fontFamily: 'var(--font-mono)', fontSize: 13 }}
                  />
                  <span className="register-hint" style={{ marginTop: 4, display: 'block' }}>{t('reg_prompt_hint')}</span>
                </label>
              )}

              <label className="register-label">
                {t('reg_owner_label')}
                <input className="register-input" value={wallet} readOnly style={{ opacity: 0.6, cursor: 'not-allowed' }} />
              </label>
            </div>

            {err && <div className="stake-error" style={{ marginTop: 12 }}>{err}</div>}
            {ok && <div className="stake-success" style={{ marginTop: 12 }}>{ok}</div>}
            <button className="register-btn" onClick={() => void handleRegister()} disabled={loading} style={{ marginTop: 16 }}>
              {loading ? t('reg_submitting') : t('reg_submit')}
            </button>
          </>
        )}
      </div>

      {/* My agents */}
      {myAgents.length > 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="feature-title" style={{ marginBottom: 12 }}>{t('reg_list_my')}</div>
          <div className="register-agent-list">
            {myAgents.map(a => (
              <div className="register-agent-item" key={a.id}>
                <div>
                  <div className="register-agent-name">
                    {a.name}
                    <span className="task-badge" style={{ marginLeft: 8, fontSize: 10 }}>
                      {a.agent_type === 'prompt' ? t('reg_type_prompt') : t('reg_type_webhook')}
                    </span>
                  </div>
                  <div className="register-agent-meta">
                    <code>{a.id}</code>
                    {a.agent_type === 'webhook' && <> · <span style={{ color: 'var(--muted)' }}>{a.webhook_url}</span></>}
                  </div>
                  <div className="register-agent-date">{new Date(a.registered_at).toLocaleString()}</div>
                </div>
                <button className="register-del-btn" onClick={() => void handleDelete(a.id)}>{t('reg_unregister')}</button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* All agents (read-only view) */}
      {agents.length > 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="feature-title" style={{ marginBottom: 12 }}>{t('reg_list_all')}</div>
          <div className="register-agent-list">
            {agents.map(a => (
              <div className="register-agent-item" key={a.id}>
                <div>
                  <div className="register-agent-name">
                    {a.name}
                    <span className="task-badge" style={{ marginLeft: 8, fontSize: 10 }}>
                      {a.agent_type === 'prompt' ? t('reg_type_prompt') : t('reg_type_webhook')}
                    </span>
                  </div>
                  <div className="register-agent-meta">
                    <code>{a.id}</code> · {a.owner !== 'anonymous' ? a.owner.slice(0, 14) + '…' : 'anon'}
                    {a.agent_type === 'webhook' && <> · <span style={{ color: 'var(--muted)' }}>{a.webhook_url}</span></>}
                  </div>
                  <div className="register-agent-date">{new Date(a.registered_at).toLocaleString()}</div>
                </div>
                {a.owner === wallet?.toLowerCase() && (
                  <button className="register-del-btn" onClick={() => void handleDelete(a.id)}>{t('reg_unregister')}</button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── App Page ────────────────────────────────────────────────────────────────

export default function AppPage() {
  const { t } = useI18n();
  const [health, setHealth] = useState<HealthData | null>(null);
  const [rows, setRows] = useState<LeaderboardEntry[]>([]);
  const [activeTab, setActiveTab] = useState<'leaderboard' | 'registry' | 'stake' | 'tasks' | 'register'>('leaderboard');
  const [lastUpdated, setLastUpdated] = useState<string>('');
  const [wallet, setWallet] = useState<string | null>(null);
  const [vaultCfg, setVaultCfg] = useState<VaultConfig | null>(null);
  const [userVaultData, setUserVaultData] = useState<UserVaultData | null>(null);
  const [seasonId, setSeasonId] = useState<string>('season-1');
  const wsRef = useRef<WebSocket | null>(null);
  const activeProviderRef = useRef<Eip1193Provider | null>(null);

  const connectWallet = async (id: WalletId) => {
    const provider = getProvider(id);
    const INSTALL_LINKS: Record<WalletId, string> = {
      binance: 'https://www.binance.com/en/web3wallet',
      okx:     'https://www.okx.com/web3',
      rainbow: 'https://rainbow.me',
    };
    if (!provider) {
      const name = WALLET_OPTIONS.find(o => o.id === id)?.label ?? id;
      alert(`${name} 未检测到，请先安装：${INSTALL_LINKS[id]}`);
      return;
    }
    try {
      const accounts = await provider.request({ method: 'eth_requestAccounts' }) as string[];
      if (accounts[0]) {
        setWallet(accounts[0]);
        activeProviderRef.current = provider;
        _activeProvider = provider;
      }
    } catch {}
  };

  const disconnectWallet = () => {
    activeProviderRef.current = null;
    _activeProvider = null;
    setWallet(null);
  };

  const refresh = async () => {
    const [h, lb] = await Promise.all([
      fetchJson<HealthData>(`${API_BASE}/health`),
      fetchJson<{ ok: boolean; data: LeaderboardEntry[] }>(`${API_BASE}/api/v1/agents`),
    ]);
    setHealth(h);
    setRows(lb?.data ?? []);
    setLastUpdated(new Date().toLocaleTimeString());
    if (h?.season && h.season !== 'none') setSeasonId(h.season);
  };

  const refreshVault = useCallback(async () => {
    const cfg = await fetchJson<{ ok: boolean; data: VaultConfig }>(`${API_BASE}/api/v1/vault/config`);
    if (cfg?.ok) setVaultCfg(cfg.data);
    if (wallet && cfg?.data.vault_address) {
      const agentIds = rows.map(r => r.agent_id);
      if (agentIds.length === 0) return;
      const seasonKey = await fetchKeyHash(seasonId);
      if (!seasonKey) return;
      const agentKeys = await Promise.all(agentIds.map(id => fetchKeyHash(id)));
      const validAgentKeys = agentKeys.filter((k): k is string => k !== null);
      if (validAgentKeys.length === 0) return;
      const uvd = await fetchJson<{ ok: boolean; data: UserVaultData }>(
        `${API_BASE}/api/v1/vault/season/${seasonKey}/user/${wallet}?agents=${validAgentKeys.join(',')}`,
      );
      if (uvd?.ok) {
        const merged = uvd.data.agents.map((a, i) => ({ ...a, agent_name: rows[i]?.agent_name ?? a.agent_key.slice(0, 8) }));
        setUserVaultData({ ...uvd.data, agents: merged });
      }
    }
  }, [wallet, rows, seasonId]);

  useEffect(() => {
    void refresh();
    const interval = setInterval(() => void refresh(), 15_000);
    const wsUrl = WS_URL;
    if (wsUrl) {
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;
      ws.onmessage = (evt) => {
        try {
          const msg = JSON.parse(evt.data as string) as { type: string; data: unknown };
          if (msg.type === 'leaderboard') { setRows(msg.data as LeaderboardEntry[]); setLastUpdated(new Date().toLocaleTimeString()); }
        } catch {}
      };
    }
    return () => { clearInterval(interval); wsRef.current?.close(); };
  }, []);

  useEffect(() => {
    if (activeTab === 'stake') void refreshVault();
  }, [activeTab, wallet, refreshVault]);

  useEffect(() => {
    const handler = (accounts: unknown) => {
      const list = accounts as string[];
      setWallet(list[0] ?? null);
      if (!list[0]) activeProviderRef.current = null;
    };
    const provider = activeProviderRef.current;
    if (!provider) return;
    provider.on?.('accountsChanged', handler);
    return () => { provider.removeListener?.('accountsChanged', handler); };
  }, [wallet]);

  const totalValue  = rows.reduce((s, r) => s + r.total_value_usd, 0);
  const totalTrades = rows.reduce((s, r) => s + r.trade_count, 0);
  const topRoi      = rows.length > 0 ? Math.max(...rows.map(r => r.roi)) : 0;

  return (
    <>
      {/* CRT Effects */}
      <div className="crt-overlay" />
      <div className="scanline" />

      <header className="app-header">
        <div className="app-header-inner">
          <div className="app-header-left">
            <a href="/" className="app-header-brand">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <div className="app-header-s-box"><img src="/logo.png" alt="Synaptex" style={{ width: '80%', height: '80%', objectFit: 'contain' }} /></div>
              <span className="app-header-brand-text">SYNAPTEX</span>
            </a>
            <div className="app-header-sep" />
            <div className="app-header-status">
              <div className={`app-status-dot${health?.ok ? ' active' : ''}`} />
              <div>
                <div className="app-status-label">Status</div>
                <div className={`app-status-text${health?.ok ? ' active' : ''}`}>
                  {health?.ok ? 'Mainnet_Active' : 'Connecting...'}
                </div>
              </div>
            </div>
          </div>
          <div className="app-header-right">
            <div className="app-header-metrics">
              <div className="app-metric">
                <span className="app-metric-label">SEASON</span>
                <span className="app-metric-value">{health?.season ?? '—'}</span>
              </div>
              <div className="app-metric">
                <span className="app-metric-label">OBSERVERS</span>
                <span className="app-metric-value">{health?.ws_clients ?? 0}</span>
              </div>
            </div>
            <LangToggle />
            <WalletBar wallet={wallet} onConnect={connectWallet} onDisconnect={disconnectWallet} />
          </div>
        </div>
      </header>

      {/* ── Full-width stats bar ── */}
      <div className="app-stats-bar">
        <div className="stat-card">
          <div className="stat-label">{t('app_season')}</div>
          <div className={`stat-value ${health?.ok ? 'green' : 'accent'}`}>{health?.ok ? t('app_live') : t('app_offline')}</div>
          <div className="stat-sub">{health?.season ?? t('app_waiting')}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">{t('app_agents')}</div>
          <div className="stat-value accent">{rows.length}</div>
          <div className="stat-sub">{t('app_competing')}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">{t('app_toproi')}</div>
          <div className={`stat-value ${topRoi >= 0 ? 'green' : ''}`}>{topRoi >= 0 ? '+' : ''}{(topRoi * 100).toFixed(2)}%</div>
          <div className="stat-sub">{t('app_bestperf')}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">{t('app_trades')}</div>
          <div className="stat-value gold">{totalTrades}</div>
          <div className="stat-sub">${totalValue.toLocaleString(undefined, { maximumFractionDigits: 0 })} AUM</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">{t('app_watchers')}</div>
          <div className="stat-value accent">{health?.ws_clients ?? 0}</div>
          <div className="stat-sub">{t('app_live_obs')}</div>
        </div>
      </div>

      <div className="app-root">

      {/* ── Tabs ── */}
      <div style={{ marginTop: 24 }}>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
          <span className="section-badge">{lastUpdated ? `${t('app_updated')} ${lastUpdated}` : t('app_loading')}</span>
        </div>
        <div className="tabs-container">
          {(['leaderboard', 'registry', 'stake', 'tasks', 'register'] as const).map(tab => (
            <button key={tab} className={`tab-btn${activeTab === tab ? ' tab-active' : ''}`} onClick={() => setActiveTab(tab)}>
              {{ leaderboard: t('tab_leaderboard'), registry: t('tab_registry'), stake: t('tab_stake'), tasks: t('tab_tasks'), register: t('tab_register') }[tab]}
            </button>
          ))}
        </div>

        {activeTab === 'leaderboard' && (
          <div className="card">
            <table>
              <thead>
                <tr>
                  <th>{t('col_rank')}</th><th>{t('col_agent')}</th><th>{t('col_roi')}</th>
                  <th>{t('col_value')}</th><th>{t('col_signals')}</th><th>{t('col_trades')}</th>
                  <th>{t('col_valid')}</th><th>{t('col_weight')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0
                  ? <tr><td colSpan={8} style={{ textAlign: 'center', color: 'var(--muted)', padding: '32px 0' }}>{t('app_no_season')}</td></tr>
                  : rows.map(r => (
                    <tr key={r.agent_id} className={r.rank === 1 ? 'row-gold' : r.rank === 2 ? 'row-silver' : r.rank === 3 ? 'row-bronze' : r.rank % 2 === 0 ? 'row-even' : ''}>
                      <td><RankBadge rank={r.rank} /></td>
                      <td><div className="agent-name">{r.agent_name}</div><div className="agent-model">{r.agent_id}</div></td>
                      <td><RoiCell roi={r.roi} /></td>
                      <td>${r.total_value_usd.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                      <td>{r.signal_count}</td>
                      <td>{r.trade_count}</td>
                      <td>{r.is_valid ? <span className="valid-yes">✓ valid</span> : <span className="valid-no">–</span>}</td>
                      <td style={{ color: 'var(--muted)' }}>{(r.settlement_weight * 100).toFixed(1)}%</td>
                    </tr>
                  ))
                }
              </tbody>
            </table>
          </div>
        )}

        {activeTab === 'registry' && (
          <div className="feature-grid">
            {rows.length === 0
              ? <div className="card" style={{ textAlign: 'center', color: 'var(--muted)', padding: '40px' }}>{t('app_no_agents')}</div>
              : rows.map(r => (
                <div className="feature-card" key={r.agent_id}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
                    <RankBadge rank={r.rank} />
                    <span className={`tag ${r.is_valid ? 'tag-green' : 'tag-blue'}`}>{r.is_valid ? t('col_qualified') : t('col_warming')}</span>
                  </div>
                  <div className="feature-title">{r.agent_name}</div>
                  <div className="agent-model" style={{ marginBottom: 10 }}>
                    {r.agent_type ?? 'internal'} · {r.owner ? r.owner.slice(0, 12) + '…' : 'arena-internal'}
                  </div>
                  <div style={{ marginBottom: 12 }}>
                    <RoiCell roi={r.roi} />
                    <span style={{ color: 'var(--muted)', fontSize: 12, marginLeft: 8 }}>${r.total_value_usd.toLocaleString(undefined, { maximumFractionDigits: 0 })} {t('col_portfolio')}</span>
                  </div>
                  {r.strategy_tags && r.strategy_tags.length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                      {r.strategy_tags.map(tag => <code key={tag}>{tag}</code>)}
                    </div>
                  )}
                </div>
              ))
            }
          </div>
        )}

        {activeTab === 'stake' && (
          <div className="stake-claim-grid">
            <StakePanel wallet={wallet} vaultCfg={vaultCfg} agents={rows} seasonId={seasonId} />
            <ClaimPanel wallet={wallet} vaultCfg={vaultCfg} userVaultData={userVaultData} seasonId={seasonId} agents={rows} onRefresh={() => void refreshVault()} />
          </div>
        )}

        {activeTab === 'tasks' && (
          <TaskMarketPanel wallet={wallet} agents={rows} onTaskCreated={() => void refresh()} />
        )}

        {activeTab === 'register' && (
          <RegisterAgentPanel wallet={wallet} />
        )}
      </div>
    </div>
    </>
  );
}
