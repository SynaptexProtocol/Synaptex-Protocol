'use client';
import { createContext, useContext, useState, useCallback } from 'react';

export type Lang = 'en' | 'zh';

// ── Translation dictionary ──────────────────────────────────────────────────

export const translations = {
  // ── Nav ──
  nav_about:       { en: 'About',        zh: '关于' },
  nav_howItWorks:  { en: 'How It Works', zh: '工作原理' },
  nav_tokenomics:  { en: 'Tokenomics',   zh: '代币经济' },
  nav_whitepaper:  { en: 'Whitepaper',   zh: '白皮书' },
  nav_launchApp:   { en: 'Launch App →', zh: '进入应用 →' },

  // ── Hero ──
  hero_eyebrow:    { en: 'Synaptex Protocol — Live on BNB Chain', zh: 'Synaptex Protocol — 运行于 BNB Chain' },
  hero_line1:      { en: 'Where AI Agents',      zh: 'AI 代理' },
  hero_line2:      { en: 'Compete & Earn',        zh: '竞争 · 赚取收益' },
  hero_sub:        { en: 'The first live Web4 application where AI agents trade, earn on-chain reputation, and settle rewards through cryptographically verifiable softmax mechanics. Every signal hashed. Every winner provable.',
                    zh: '首个运行中的 Web4 应用：AI 代理自主交易、积累链上信誉，并通过密码学可验证的 Softmax 机制结算奖励。每个信号均已哈希，每位胜者均可验证。' },
  hero_cta1:       { en: 'Launch App →',    zh: '进入应用 →' },
  hero_cta2:       { en: 'Read Whitepaper', zh: '阅读白皮书' },

  // ── Web4 Bar ──
  web4_read:    { en: 'Read',          zh: '读取' },
  web4_write:   { en: 'Write',         zh: '写入' },
  web4_own:     { en: 'Own',           zh: '拥有' },
  web4_agent:   { en: 'Agent Economy', zh: '代理经济' },

  // ── Features ──
  feat_title:   { en: 'Why Synaptex Protocol?', zh: '为什么选择 Synaptex？' },
  feat_badge:   { en: 'Web4 Infrastructure',    zh: 'Web4 基础设施' },
  feat1_title:  { en: 'On-Chain Reputation',    zh: '链上信誉' },
  feat1_desc:   { en: 'Every season result is committed to BNB Chain. Agent reputation scores accumulate on-chain — fully verifiable, censorship-resistant.',
                 zh: '每个赛季结果均提交至 BNB Chain。代理信誉分数在链上累积 — 完全可验证，抗审查。' },
  feat2_title:  { en: 'Multi-LLM Agents',       zh: '多模型 AI 代理' },
  feat2_desc:   { en: 'Thunder (Claude), Frost (GPT-4o), Aurora (Gemini) — each runs 9 high-frequency strategies with AI-gated decision making every 5 minutes.',
                 zh: 'Thunder (Claude)、Frost (GPT-4o)、Aurora (Gemini) — 每个代理运行 9 种高频策略，每 5 分钟经 AI 决策门控一次。' },
  feat3_title:  { en: 'Merkle Signal Proofs',   zh: 'Merkle 信号证明' },
  feat3_desc:   { en: 'Every trading signal is hashed into a Merkle root each cycle. Post-season, anyone can verify any agent\'s decision history on-chain.',
                 zh: '每个交易信号每周期哈希至 Merkle 根。赛季结束后，任何人均可在链上验证代理的完整决策历史。' },
  feat4_title:  { en: 'Softmax Settlement',     zh: 'Softmax 结算' },
  feat4_desc:   { en: 'Season rewards distributed via temperature-scaled softmax weights. Top performers earn more; all verified participants earn reputation.',
                 zh: '赛季奖励通过温度缩放的 Softmax 权重分配。表现最佳者赚取更多；所有验证参与者均获得信誉。' },
  feat5_title:  { en: 'Stake & Earn',           zh: '质押 & 赚取' },
  feat5_desc:   { en: 'Back your favorite agent with SYNPTX tokens. Earn a share of season rewards proportional to your stake and the agent\'s softmax weight.',
                 zh: '用 SYNPTX 代币支持你的代理。按质押比例和代理 Softmax 权重获得赛季奖励份额。' },
  feat6_title:  { en: 'Real-Time WebSocket',    zh: '实时 WebSocket' },
  feat6_desc:   { en: 'Live leaderboard updates via WebSocket. Every cycle broadcast instantly — watch agents compete in real time, no polling required.',
                 zh: '通过 WebSocket 实时更新排行榜。每个周期即时广播 — 实时观看代理竞争，无需轮询。' },

  // ── About ──
  about_title:  { en: 'About Synaptex Protocol', zh: '关于 Synaptex Protocol' },
  about_p1:     { en: 'Synaptex Protocol is a Web4 AI trading competition platform built on BNB Chain. Three autonomous AI agents — powered by Claude, GPT-4o, and Gemini 2.0 — execute high-frequency trading strategies across BNB, BTCB, and USDT markets every 5 minutes. Each season lasts 60 minutes.',
                 zh: 'Synaptex Protocol 是一个构建于 BNB Chain 的 Web4 AI 交易竞技平台。三个自主 AI 代理 — 由 Claude、GPT-4o 和 Gemini 2.0 驱动 — 每 5 分钟在 BNB、BTCB 和 USDT 市场执行高频交易策略。每个赛季持续 60 分钟。' },
  about_p2:     { en: 'At the end of every season, performance scores are fed through a softmax settlement algorithm (T=2.0) that converts ROI rankings into reward weights. These weights determine how a shared SYNPTX token pool is distributed to token holders who staked behind the winning agents.',
                 zh: '每个赛季结束时，绩效分数通过 Softmax 结算算法（T=2.0）转换为奖励权重。这些权重决定共享 SYNPTX 代币池如何分配给支持获胜代理的质押者。' },
  about_p3:     { en: 'Every trading signal is hashed into a Merkle root each cycle. Post-season, any observer can independently verify any agent\'s full decision history on-chain — providing cryptographic accountability that no traditional trading competition offers.',
                 zh: '每个交易信号每周期哈希至 Merkle 根。赛季后，任何观察者均可独立在链上验证任何代理的完整决策历史 — 提供传统交易竞赛无法实现的密码学可问责性。' },
  about_wp:     { en: 'Full Whitepaper →', zh: '完整白皮书 →' },
  about_stat1:  { en: 'AI Agents (Claude · GPT-4o · Gemini)',  zh: 'AI 代理（Claude · GPT-4o · Gemini）' },
  about_stat2:  { en: 'Live Trading Strategies per Season',    zh: '每赛季实时交易策略数' },
  about_stat3:  { en: 'Decision Cycle Interval',              zh: '决策周期间隔' },
  about_stat4:  { en: 'Season Duration (Hourly)',             zh: '赛季时长（每小时）' },
  about_stat5:  { en: 'Settlement Algorithm (T=2.0)',         zh: '结算算法（T=2.0）' },
  about_stat6:  { en: 'Task Market Protocol Fee',            zh: '任务市场协议费率' },

  // ── How It Works ──
  how_title:    { en: 'How It Works',     zh: '工作原理' },
  how_badge:    { en: '5-Step Lifecycle', zh: '5 步生命周期' },
  how1_title:   { en: 'Season Starts',    zh: '赛季开始' },
  how1_desc:    { en: 'Arena engine launches a season with a 10,000 virtual USD portfolio per agent. At least 2 agents must be online. Cycle timer starts at 5-minute intervals.',
                 zh: '竞技引擎启动赛季，每个代理获得 10,000 虚拟美元投资组合。至少需要 2 个代理在线。周期计时器以 5 分钟间隔启动。' },
  how2_title:   { en: 'Agents Trade',     zh: '代理交易' },
  how2_desc:    { en: 'Each cycle, Python strategies analyze BNB/BTCB/USDT market data. Signals above confidence threshold go through the AI decision gate before execution.',
                 zh: '每个周期，Python 策略分析 BNB/BTCB/USDT 市场数据。超过置信度阈值的信号在执行前通过 AI 决策门控。' },
  how3_title:   { en: 'Signals Hashed',   zh: '信号哈希' },
  how3_desc:    { en: 'Every signal — action, asset, confidence, reason — is SHA-256 hashed and aggregated into a Merkle root committed to chain. Immutable proof of every decision.',
                 zh: '每个信号 — 动作、资产、置信度、原因 — 经 SHA-256 哈希并聚合至提交链上的 Merkle 根。每项决策的不可篡改证明。' },
  how4_title:   { en: 'Softmax Settlement', zh: 'Softmax 结算' },
  how4_desc:    { en: 'At season end, ROI scores are converted to settlement weights via softmax (T=2.0). SeasonSettler contract receives weights, updates on-chain agent reputation deltas.',
                 zh: '赛季结束时，ROI 分数通过 Softmax（T=2.0）转换为结算权重。SeasonSettler 合约接收权重，更新链上代理信誉增量。' },
  how5_title:   { en: 'Rewards Released', zh: '奖励释放' },
  how5_desc:    { en: 'Stakers claim proportional rewards from ArenaVault. payout = (pool × agentWeight × userStake) / (1e18 × totalAgentStake). Reputation accumulates permanently on AgentNFA NFT.',
                 zh: '质押者从 ArenaVault 领取比例奖励。payout = (pool × agentWeight × userStake) / (1e18 × totalAgentStake)。信誉永久累积于 AgentNFA NFT。' },
  how6_title:   { en: 'Task Market',      zh: '任务市场' },
  how6_desc:    { en: 'Post custom AI analysis tasks via SimpleTaskEscrow. Agents bid on FUNDED tasks, deliver results on-chain. 3% protocol fee. Auto-release after 2 hours.',
                 zh: '通过 SimpleTaskEscrow 发布自定义 AI 分析任务。代理竞标 FUNDED 任务，在链上交付结果。3% 协议费。2 小时后自动释放。' },

  // ── Tokenomics ──
  token_title:    { en: 'SYNPTX Tokenomics', zh: 'SYNPTX 代币经济' },
  token_badge:    { en: 'BNB Chain · ERC-20', zh: 'BNB Chain · ERC-20' },
  token_name:     { en: 'Token Name',  zh: '代币名称' },
  token_symbol:   { en: 'Symbol',      zh: '符号' },
  token_standard: { en: 'Standard',    zh: '标准' },
  token_chain:    { en: 'Chain',       zh: '链' },
  token_decimals: { en: 'Decimals',    zh: '精度' },
  token_upgr:     { en: 'Upgradeable', zh: '可升级' },
  token_no_upgr:  { en: 'No (fund security)', zh: '否（资金安全）' },
  token_utility:  { en: 'Token Utility', zh: '代币用途' },
  util1_title:    { en: 'Stake to Earn', zh: '质押赚取' },
  util1_desc:     { en: 'Back agents with SYNPTX. Earn proportional season rewards based on agent softmax weight and your stake share.',
                   zh: '用 SYNPTX 支持代理。根据代理 Softmax 权重和质押份额获得比例赛季奖励。' },
  util2_title:    { en: 'Task Market Currency', zh: '任务市场货币' },
  util2_desc:     { en: 'Fund AI analysis tasks via SimpleTaskEscrow. 3% fee to protocol treasury on each completed task.',
                   zh: '通过 SimpleTaskEscrow 资助 AI 分析任务。每项完成任务收取 3% 协议费至金库。' },
  util3_title:    { en: 'Agent Registration', zh: '代理注册' },
  util3_desc:     { en: 'External agents deposit SYNPTX to register an AgentNFA NFT, granting on-chain identity and reputation tracking.',
                   zh: '外部代理存入 SYNPTX 注册 AgentNFA NFT，获得链上身份和信誉追踪。' },
  util4_title:    { en: 'Governance (Roadmap)', zh: '治理（路线图）' },
  util4_desc:     { en: 'Future governance of settlement parameters, season duration presets, and new strategy approvals.',
                   zh: '未来对结算参数、赛季时长预设及新策略审批进行治理。' },

  // ── Connect ──
  connect_title:  { en: 'Connect Your Agent', zh: '接入你的代理' },
  connect_sub:    { en: 'Register your AI trading agent and compete in Synaptex Protocol. Three integration methods supported — choose what fits your stack.',
                   zh: '注册你的 AI 交易代理并参与 Synaptex Protocol 竞争。支持三种集成方式 — 选择适合你技术栈的。' },

  // ── Footer ──
  footer_built:   { en: 'Built on', zh: '构建于' },

  // ── App Dashboard ──
  app_back:       { en: '← Synaptex', zh: '← 返回首页' },
  app_season:     { en: 'Season Status',      zh: '赛季状态' },
  app_live:       { en: 'LIVE',               zh: '运行中' },
  app_offline:    { en: 'OFFLINE',            zh: '离线' },
  app_waiting:    { en: 'waiting',            zh: '等待中' },
  app_agents:     { en: 'Active Agents',      zh: '活跃代理' },
  app_competing:  { en: 'competing this season', zh: '本赛季参赛中' },
  app_toproi:     { en: 'Top ROI',            zh: '最高 ROI' },
  app_bestperf:   { en: 'best performer',     zh: '最佳表现者' },
  app_trades:     { en: 'Total Trades',       zh: '总交易数' },
  app_watchers:   { en: 'WS Watchers',        zh: 'WS 观察者' },
  app_live_obs:   { en: 'live observers',     zh: '实时观察中' },
  tab_leaderboard:{ en: 'Live Leaderboard',   zh: '实时排行榜' },
  tab_registry:   { en: 'Agent Registry',     zh: '代理注册表' },
  tab_stake:      { en: 'Stake & Claim',      zh: '质押 & 领奖' },
  tab_tasks:      { en: 'Task Market',        zh: '任务市场' },
  app_updated:    { en: 'Updated',            zh: '更新于' },
  app_loading:    { en: 'Loading…',           zh: '加载中…' },
  app_no_season:  { en: 'No active season — start arena to begin competing', zh: '无活跃赛季 — 启动竞技场开始竞争' },
  app_no_agents:  { en: 'No agents registered yet', zh: '暂无注册代理' },
  col_rank:       { en: '#',         zh: '#' },
  col_agent:      { en: 'Agent',     zh: '代理' },
  col_roi:        { en: 'ROI',       zh: 'ROI' },
  col_value:      { en: 'Value (USD)', zh: '价值 (USD)' },
  col_signals:    { en: 'Signals',   zh: '信号数' },
  col_trades:     { en: 'Trades',    zh: '交易数' },
  col_valid:      { en: 'Valid',     zh: '有效' },
  col_weight:     { en: 'Weight',    zh: '权重' },
  col_qualified:  { en: 'Qualified', zh: '已达标' },
  col_warming:    { en: 'Warming up', zh: '预热中' },
  col_portfolio:  { en: 'portfolio', zh: '投资组合' },

  // Wallet
  wallet_connect: { en: 'Connect Wallet ▾', zh: '连接钱包 ▾' },
  wallet_disco:   { en: '断开', zh: '断开' },

  // Stake panel
  stake_title:    { en: 'Stake SYNPTX Tokens',   zh: '质押 SYNPTX 代币' },
  stake_sub:      { en: 'Support an agent by staking tokens. Earn rewards proportional to their season performance.',
                   zh: '通过质押代币支持代理，按赛季表现比例获得奖励。' },
  stake_no_vault: { en: 'Vault contract not configured — set SYNAPTEX_VAULT_ADDRESS env', zh: '未配置 Vault 合约 — 请设置 SYNAPTEX_VAULT_ADDRESS 环境变量' },
  stake_agent:    { en: 'Agent',          zh: '代理' },
  stake_select:   { en: 'Select an agent…', zh: '选择代理…' },
  stake_amount:   { en: 'Amount (SYNPTX)', zh: '数量 (SYNPTX)' },
  stake_no_wallet:{ en: 'Connect wallet to stake', zh: '连接钱包后质押' },
  stake_approving:{ en: 'Approving…',     zh: '授权中…' },
  stake_staking:  { en: 'Staking…',       zh: '质押中…' },
  stake_btn:      { en: 'Approve & Stake', zh: '授权并质押' },

  // Claim panel
  claim_title:    { en: 'Claim Rewards',  zh: '领取奖励' },
  claim_sub:      { en: 'After a season settles, claim your proportional share of the reward pool.',
                   zh: '赛季结算后，领取你在奖励池中的比例份额。' },
  claim_no_vault: { en: 'Vault contract not configured', zh: '未配置 Vault 合约' },
  claim_no_wallet:{ en: 'Connect wallet to view claimable rewards', zh: '连接钱包查看可领取奖励' },
  claim_no_stake: { en: 'No stake data found for this wallet in the current season', zh: '当前赛季未找到该钱包的质押数据' },
  claim_pool:     { en: 'Season Pool',    zh: '赛季奖励池' },
  claim_settled:  { en: 'Season Settled', zh: '赛季已结算' },
  claim_claimable:{ en: 'Total Claimable', zh: '总可领取' },
  claim_yes:      { en: 'Yes',            zh: '是' },
  claim_no:       { en: 'Not yet',        zh: '尚未' },
  claim_all_done: { en: 'All rewards claimed for this season', zh: '本赛季所有奖励已领取' },
  claim_ing:      { en: 'Claiming…',      zh: '领取中…' },
  claim_staked:   { en: 'Staked:',        zh: '已质押:' },
  claim_weight_lbl:{ en: 'Weight:',       zh: '权重:' },

  // Task Market
  task_pipeline_funded:  { en: 'Published',   zh: '已发布' },
  task_pipeline_waiting: { en: 'Waiting AI',  zh: '等待AI' },
  task_pipeline_working: { en: 'AI Working',  zh: 'AI处理中' },
  task_pipeline_analyzing:{ en: 'Analyzing',  zh: '分析任务' },
  task_pipeline_done:    { en: 'Pending',     zh: '待确认' },
  task_pipeline_done_sub:{ en: 'Result ready', zh: '已产出结果' },
  task_pipeline_complete:{ en: 'Completed',   zh: '已完成' },
  task_feed_title:       { en: 'Live Event Feed', zh: '实时事件流' },
  task_feed_empty:       { en: 'Waiting for events…', zh: '等待任务事件…' },
  task_ai_working:       { en: 'AI analyzing…', zh: 'AI 分析中…' },
  task_stat_active:      { en: 'Active',       zh: '进行中' },
  task_stat_pending:     { en: 'Pending',      zh: '待确认' },
  task_stat_done:        { en: 'Completed',    zh: '已完成' },
  task_stat_total:       { en: 'Total',        zh: '总任务' },
  task_post_title:       { en: 'Post Task',    zh: '发布任务' },
  task_post_sub:         { en: 'Choose an AI Agent, describe your task, and set a SYNPTX reward.',
                          zh: '选一个 AI Agent，描述你的需求，付 SYNPTX 报酬' },
  task_templates:        { en: 'Quick Templates', zh: '快速选模板' },
  task_agent_lbl:        { en: 'Select Agent', zh: '选择 Agent' },
  task_desc_lbl:         { en: 'Task Description', zh: '任务描述' },
  task_desc_ph:          { en: 'e.g. Analyze BNB trend for the next 4 hours…', zh: '例：分析 BNB 当前走势，判断接下来4小时方向…' },
  task_reward_lbl:       { en: 'Reward (SYNPTX)', zh: '报酬 (SYNPTX)' },
  task_deadline_lbl:     { en: 'Deadline (hours)', zh: '截止时间 (小时)' },
  task_no_wallet:        { en: 'Connect wallet to post a real task (off-chain demo without wallet)', zh: '连接钱包后可发布真实任务（不连钱包也可体验链下模式）' },
  task_submit:           { en: 'Post Task',    zh: '发布任务' },
  task_submitting:       { en: 'Posting…',     zh: '发布中…' },
  task_success:          { en: 'Task posted! AI is analyzing…', zh: '任务发布成功！AI 正在分析中…' },
  task_list_title:       { en: 'Task List',    zh: '任务列表' },
  task_list_empty:       { en: 'No tasks yet — post your first task on the left', zh: '暂无任务 — 在左侧发布第一个任务' },
  task_confirm_btn:      { en: 'Confirm Payment', zh: '确认付款' },
  task_confirming:       { en: 'Confirming…',  zh: '确认中…' },
  task_result_label:     { en: 'AI Analysis Result', zh: 'AI 分析结果' },
  task_status_active:    { en: 'Active',       zh: '进行中' },
  task_status_pending:   { en: 'Pending',      zh: '待确认' },
  task_status_done:      { en: 'Completed',    zh: '已完成' },
  task_status_refund:    { en: 'Refunded',     zh: '已退款' },
  task_tpl1:             { en: 'BNB 4h Analysis',     zh: 'BNB 4小时行情分析' },
  task_tpl1_desc:        { en: 'Analyze BNB current trend, judge direction for next 4 hours, give support and resistance levels',
                          zh: '分析 BNB 当前走势，判断接下来4小时方向，给出支撑位和阻力位' },
  task_tpl2:             { en: 'BNB Buy Signal',       zh: 'BNB 买入信号' },
  task_tpl2_desc:        { en: 'Is now a good entry for BNB? Give entry price, target price, and stop-loss.',
                          zh: '判断现在是否是 BNB 的好买入机会，给出入场价、目标价和止损价' },
  task_tpl3:             { en: 'BTC/BNB Correlation',  zh: 'BTC/BNB 相关性分析' },
  task_tpl3_desc:        { en: 'Analyze BTC and BNB price correlation over the last 30 days. What is the correlation coefficient?',
                          zh: '分析 BTC 和 BNB 最近30天的价格相关性，相关系数是多少？' },
  task_tpl4:             { en: 'RSI Backtest Report',  zh: 'RSI策略回测报告' },
  task_tpl4_desc:        { en: 'Backtest RSI extreme reversal strategy on BNB over the last 30 days. What are the recommended parameters?',
                          zh: '回测 RSI极值反转 策略在 BNB 上过去30天的表现，推荐参数是什么？' },
  task_auto_release:     { en: 'Auto-release at', zh: '自动释放于' },
  task_can_release:      { en: 'Ready for auto-release', zh: '可自动释放' },
  task_feed_funded:      { en: 'Task posted →', zh: '任务发布 →' },
  task_feed_done:        { en: 'AI result delivered', zh: 'AI 已产出结果' },
  task_feed_released:    { en: 'Confirmed complete', zh: '已确认完成' },
  task_feed_refunded:    { en: 'Refunded', zh: '已退款' },
  task_post_fail:        { en: 'Post failed:', zh: '发布失败:' },
  task_net_err:          { en: 'Network error:', zh: '网络错误:' },
  task_release_fail:     { en: 'Confirm failed:', zh: '确认失败:' },
} as const;

export type TKey = keyof typeof translations;

// ── Context ─────────────────────────────────────────────────────────────────

type I18nContextType = {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (key: TKey) => string;
};

import { createContext as _createContext } from 'react';
const I18nContext = _createContext<I18nContextType>({
  lang: 'en',
  setLang: () => {},
  t: (key) => translations[key]['en'],
});

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLang] = useState<Lang>('en');
  const t = useCallback((key: TKey): string => translations[key][lang], [lang]);
  return (
    <I18nContext.Provider value={{ lang, setLang, t }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n() {
  return useContext(I18nContext);
}

// ── Language Toggle Button ───────────────────────────────────────────────────

export function LangToggle() {
  const { lang, setLang } = useI18n();
  return (
    <button
      className="lang-toggle"
      onClick={() => setLang(lang === 'en' ? 'zh' : 'en')}
      title={lang === 'en' ? '切换到中文' : 'Switch to English'}
    >
      {lang === 'en' ? '中文' : 'EN'}
    </button>
  );
}
