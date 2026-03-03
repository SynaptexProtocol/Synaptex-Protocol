import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { resolve } from 'path';
import { spawnSync } from 'child_process';
import yaml from 'yaml';
import { Command } from 'commander';
import {
  ArenaEngine,
  SeasonManager,
  InternalAgent,
  ProcessAgent,
  SdkAgent,
  WebhookAgent,
} from '@synaptex/arena-coordinator';
import type { InternalAgentConfig, ProcessAgentConfig, SdkAgentConfig, WebhookAgentConfig } from '@synaptex/arena-coordinator';
import { IpcClient } from '@synaptex/ipc-bridge';
import { createApiServer } from '@synaptex/api-server';
import { readJsonOrDefault } from '@synaptex/core/utils/file-state.js';
import type { LeaderboardEntry } from '@synaptex/arena-coordinator';
import { createSeasonSubmitter } from '../arena/season-submitter.js';
import { createLearningRootSubmitter } from '../arena/learning-root-submitter.js';
import { createAgentIdentityRegistrar } from '../arena/agent-identity-registrar.js';
import { createAlertNotifier } from '../ops/alert-notifier.js';

interface ArenaAgentYaml {
  id: string;
  name: string;
  enabled: boolean;
  owner: string;
  type: 'internal' | 'webhook';
  llm?: { provider: string; model: string; max_tokens?: number };
  strategy_weights?: Record<string, number>;
  webhook_url?: string;
  webhook_secret?: string;
}

interface ArenaYaml {
  arena: {
    /** Preset name — takes priority over numeric fields */
    season_preset?: 'micro' | 'hourly' | 'daily' | 'weekly' | 'custom';
    /** Used only when season_preset = 'custom' */
    season_duration_minutes?: number;
    /** Legacy field (days) — falls back if neither preset nor minutes set */
    season_duration_days?: number;
    starting_virtual_usd: number;
    cycle_interval_minutes: number;
    min_agents_to_start: number;
    min_signals_to_qualify: number;
    min_trades_to_qualify: number;
    webhook_timeout_seconds: number;
    webhook_max_signals_per_cycle?: number;
    webhook_max_reason_length?: number;
    stdio_timeout_seconds?: number;
    stdio_max_stdout_bytes?: number;
    sdk_timeout_seconds?: number;
    state_dir: string;
    market_symbols?: string[];
  };
  settlement: { algorithm: string; temperature: number };
  agents: ArenaAgentYaml[];
}

interface RegistryAgentRecord {
  agent_id: string;
  owner_address: string;
  display_name: string;
  connection_type: 'webhook' | 'sdk' | 'stdio';
  endpoint: string;
  secret_ref?: string;
  enabled: boolean;
}

function resolveRegistrySecret(secretRef?: string): string {
  const ref = String(secretRef ?? '').trim();
  if (!ref) return '';
  if (ref.startsWith('env://')) {
    const key = ref.slice('env://'.length).trim();
    return process.env[key] ?? '';
  }
  if (ref.startsWith('env:')) {
    const key = ref.slice('env:'.length).trim();
    return process.env[key] ?? '';
  }
  return '';
}

function loadArenaConfig(configPath: string): ArenaYaml {
  const raw = readFileSync(configPath, 'utf-8');
  const interpolated = raw.replace(/\$\{(\w+)\}/g, (_, k) => process.env[k] ?? '');
  return yaml.parse(interpolated) as ArenaYaml;
}

interface PreflightIssue {
  level: 'error' | 'warn';
  message: string;
}

function resolveStateDir(arenaPath: string, cfg: ArenaYaml): string {
  const projectRoot = resolve(arenaPath, '../..');
  return resolve(projectRoot, cfg.arena.state_dir ?? 'state/arena');
}

function isHexAddress(v: string | undefined): boolean {
  return !!v && /^0x[a-fA-F0-9]{40}$/.test(v);
}

function collectPreflightIssues(cfg: ArenaYaml): PreflightIssue[] {
  const issues: PreflightIssue[] = [];
  const settlementMode = (process.env['SYNAPTEX_SETTLEMENT_MODE'] ?? '').trim().toLowerCase();
  const onchain = settlementMode === 'onchain';
  const registrationEnabled = (process.env['ARENA_ENABLE_AGENT_ONCHAIN_REGISTRATION'] ?? '').trim() === '1';
  const rpcUrl = process.env['SYNAPTEX_CHAIN_RPC_URL']?.trim() || process.env['BASE_RPC_URL']?.trim();
  const unlocked = (process.env['ARENA_CAST_USE_UNLOCKED'] ?? '').trim() === '1';
  const hasKeystore = !!process.env['SYNAPTEX_SIGNER_KEYSTORE']?.trim();
  const hasPrivateKey = !!(process.env['SYNAPTEX_SIGNER_PRIVATE_KEY']?.trim()
    || process.env['ARENA_SETTLER_PRIVATE_KEY']?.trim());
  const allowInsecure = (process.env['SYNAPTEX_ALLOW_INSECURE_PRIVATE_KEY'] ?? '').trim() === '1';
  const hasUnlockedFrom = !!(process.env['ARENA_CAST_FROM']?.trim() || process.env['ETH_FROM']?.trim());
  const hasSignerConfig = hasKeystore || hasPrivateKey || (unlocked && hasUnlockedFrom);
  const siweStrict = (process.env['SYNAPTEX_SIWE_ENFORCE_SIGNATURE_VERIFY'] ?? '').trim() === '1';
  const siweVerifyCommand = process.env['SYNAPTEX_SIWE_VERIFY_COMMAND']?.trim() || '';
  const databaseUrl = process.env['SYNAPTEX_DATABASE_URL']?.trim();

  if (onchain) {
    if (!rpcUrl) issues.push({ level: 'error', message: 'Missing SYNAPTEX_CHAIN_RPC_URL (or BASE_RPC_URL) for on-chain mode.' });
    if (!hasSignerConfig) issues.push({ level: 'error', message: 'Missing signer config (keystore/private-key/unlocked mode).' });
    if (!isHexAddress(process.env['SYNAPTEX_SETTLER_CONTRACT']?.trim())) {
      issues.push({ level: 'error', message: 'SYNAPTEX_SETTLER_CONTRACT is missing or invalid (must be 0x...40 hex).' });
    }
    if (!isHexAddress(process.env['LEARNING_ROOT_ORACLE']?.trim())) {
      issues.push({ level: 'error', message: 'LEARNING_ROOT_ORACLE is missing or invalid (must be 0x...40 hex).' });
    }
    if (hasPrivateKey && !hasKeystore && !unlocked && !allowInsecure) {
      issues.push({
        level: 'error',
        message: 'Raw private-key signer blocked. Set SYNAPTEX_SIGNER_KEYSTORE, or unlocked mode, or SYNAPTEX_ALLOW_INSECURE_PRIVATE_KEY=1.',
      });
    }
    const keystorePath = process.env['SYNAPTEX_SIGNER_KEYSTORE']?.trim();
    if (keystorePath && !existsSync(keystorePath)) {
      issues.push({ level: 'error', message: `SYNAPTEX_SIGNER_KEYSTORE file not found: ${keystorePath}` });
    }
    const castBin = process.env['ARENA_CAST_BIN']?.trim() || 'cast';
    const castCheck = spawnSync(castBin, ['--version'], { stdio: 'ignore' });
    if (castCheck.status !== 0) {
      issues.push({ level: 'error', message: `cast binary unavailable (${castBin}). Set ARENA_CAST_BIN or fix PATH.` });
    }
  }

  if (registrationEnabled) {
    if (!rpcUrl) issues.push({ level: 'error', message: 'Agent registration enabled but SYNAPTEX_CHAIN_RPC_URL/BASE_RPC_URL missing.' });
    if (!hasSignerConfig) issues.push({ level: 'error', message: 'Agent registration enabled but signer config is missing.' });
    if (!isHexAddress(process.env['AGENT_NFA_CONTRACT']?.trim())) {
      issues.push({ level: 'error', message: 'AGENT_NFA_CONTRACT is missing or invalid (must be 0x...40 hex).' });
    }
    if (!isHexAddress(process.env['AGENT_ACCOUNT_REGISTRY']?.trim())) {
      issues.push({ level: 'error', message: 'AGENT_ACCOUNT_REGISTRY is missing or invalid (must be 0x...40 hex).' });
    }
    if (!isHexAddress(process.env['ARENA_AGENT_NFA_MINT_TO']?.trim())) {
      const hasNonAddressOwner = cfg.agents.some((a) => a.enabled && !isHexAddress(a.owner));
      if (hasNonAddressOwner) {
        issues.push({ level: 'error', message: 'ARENA_AGENT_NFA_MINT_TO missing/invalid while agent.owner is non-address.' });
      }
    }
  }

  if (!process.env['ARENA_ALERT_WEBHOOK_URL']?.trim()
      && !process.env['ARENA_ALERT_WEBHOOK_URL_WARN']?.trim()
      && !process.env['ARENA_ALERT_WEBHOOK_URL_ERROR']?.trim()) {
    issues.push({ level: 'warn', message: 'No alert webhook configured (ARENA_ALERT_WEBHOOK_URL*).' });
  }
  if (!process.env['SYNAPTEX_WS_AUTH_TOKEN']?.trim()) {
    issues.push({ level: 'warn', message: 'SYNAPTEX_WS_AUTH_TOKEN not set (WebSocket will be unauthenticated unless api config enforces it).' });
  }
  if (hasPrivateKey && !hasKeystore && !unlocked) {
    issues.push({ level: 'warn', message: 'Using raw private key env; keystore signer is safer for long-running production.' });
  }
  if (!databaseUrl) {
    issues.push({ level: 'warn', message: 'SYNAPTEX_DATABASE_URL not set (Phase 1 registry/auth currently running on local JSON store).' });
  }
  if (siweStrict) {
    if (siweVerifyCommand) {
      issues.push({ level: 'warn', message: 'SIWE strict mode uses custom SYNAPTEX_SIWE_VERIFY_COMMAND; ensure it returns exit code 0 on valid signatures.' });
    } else {
      const castBin = process.env['ARENA_CAST_BIN']?.trim() || 'cast';
      const castCheck = spawnSync(castBin, ['wallet', 'verify', '--help'], { stdio: 'ignore' });
      if (castCheck.status !== 0) {
        issues.push({ level: 'error', message: `SIWE strict mode enabled but cast verify unavailable (${castBin}).` });
      }
    }
  }
  return issues;
}

function printPreflight(issues: PreflightIssue[]): void {
  console.log('[Arena] preflight check');
  if (issues.length === 0) {
    console.log('[Arena] preflight passed');
    return;
  }
  for (const issue of issues) {
    console.log(`[Arena][${issue.level.toUpperCase()}] ${issue.message}`);
  }
}

export function registerArenaCommands(program: Command): void {
  const arena = program.command('arena').description('Arena Protocol multi-agent competition');

  arena
    .command('preflight')
    .description('Validate runtime prerequisites and config consistency')
    .option('--config <path>', 'Path to arena.yaml', 'config/arena.yaml')
    .action((opts) => {
      const arenaPath = resolve(opts.config);
      const cfg = loadArenaConfig(arenaPath);
      const issues = collectPreflightIssues(cfg);
      printPreflight(issues);
      if (issues.some((i) => i.level === 'error')) process.exitCode = 1;
    });

  // ── arena start ────────────────────────────────────────────────────────────
  arena
    .command('start')
    .description('Start the Arena engine with all configured agents')
    .option('--config <path>', 'Path to arena.yaml', 'config/arena.yaml')
    .option('--agent-config <path>', 'Path to agent.yaml (for IPC config)', 'config/agent.yaml')
    .action(async (opts) => {
      const arenaPath = resolve(opts.config);
      const agentPath = resolve(opts.agentConfig);
      const cfg = loadArenaConfig(arenaPath);
      const preflightIssues = collectPreflightIssues(cfg);
      printPreflight(preflightIssues);
      if (preflightIssues.some((i) => i.level === 'error')) {
        throw new Error('Preflight failed. Fix errors above before arena start.');
      }
      const agentCfg = yaml.parse(
        readFileSync(agentPath, 'utf-8').replace(/\$\{(\w+)\}/g, (_, k) => process.env[k] ?? ''),
      ) as Record<string, any>;

      const stateDir = resolveStateDir(arenaPath, cfg);
      const settlementSubmitter = createSeasonSubmitter(
        process.env['ARENA_SETTLEMENT_ENDPOINT'],
        process.env['ARENA_SETTLEMENT_AUTH_TOKEN'],
      );
      const learningRootSubmitter = createLearningRootSubmitter();
      const agentIdentityRegistrar = createAgentIdentityRegistrar();
      const alertNotifier = createAlertNotifier();

      const seasonDurationMinutes = (() => {
        const preset = cfg.arena.season_preset;
        if (preset && preset !== 'custom') return SeasonManager.minutesFromPreset(preset);
        if (cfg.arena.season_duration_minutes) return cfg.arena.season_duration_minutes;
        return (cfg.arena.season_duration_days ?? 7) * 24 * 60;
      })();

      const engine = new ArenaEngine({
        startingVirtualUsd: cfg.arena.starting_virtual_usd,
        cycleIntervalMinutes: cfg.arena.cycle_interval_minutes,
        seasonDurationMinutes,
        seasonPreset: cfg.arena.season_preset,
        minAgentsToStart: cfg.arena.min_agents_to_start,
        minSignalsToQualify: cfg.arena.min_signals_to_qualify,
        minTradesToQualify: cfg.arena.min_trades_to_qualify,
        webhookTimeoutSeconds: cfg.arena.webhook_timeout_seconds,
        settlement: cfg.settlement,
        stateDir,
        marketSymbols: cfg.arena.market_symbols ?? ['ETH', 'cbBTC', 'USDC'],
      });

      // One shared IPC client (all internal agents share the Python engine)
      const ipcCfg = {
        host: agentCfg.ipc?.host ?? '127.0.0.1',
        port: agentCfg.ipc?.port ?? 7890,
        timeoutMs: agentCfg.ipc?.timeout_ms ?? 5000,
      };
      const sharedIpc = new IpcClient(ipcCfg);

      let ipcConnected = false;
      try {
        await sharedIpc.connect();
        ipcConnected = true;
        console.log('[Arena] IPC connected to Python engine');
      } catch {
        console.warn('[Arena] Python IPC not available — internal agents will return no signals');
      }

      // Register agents from YAML
      const registeredAgentIds = new Set<string>();
      for (const agentYaml of cfg.agents) {
        if (!agentYaml.enabled) continue;
        registeredAgentIds.add(agentYaml.id);
        await agentIdentityRegistrar.ensureAgent(agentYaml.id, agentYaml.owner);

        if (agentYaml.type === 'internal') {
          if (!ipcConnected) {
            console.warn(`[Arena] Skipping internal agent ${agentYaml.id} (IPC offline)`);
            continue;
          }
          const agentConfig: InternalAgentConfig = {
            id: agentYaml.id,
            name: agentYaml.name,
            owner: agentYaml.owner,
            strategyWeights: agentYaml.strategy_weights ?? {},
            ipc: sharedIpc,
            decisionGateConfig: {
              approvalThresholdUsd: agentCfg.ai?.approval_threshold_usd ?? 200,
              confidenceThreshold: agentCfg.ai?.confidence_threshold ?? 0.65,
              provider: agentYaml.llm ?? agentCfg.ai?.provider,
              fallbackProvider: agentCfg.ai?.fallback_provider,
            },
          };
          engine.registerAgent(new InternalAgent(agentConfig));
          console.log(`[Arena] Registered internal agent: ${agentYaml.name} (${agentYaml.id})`);
        } else if (agentYaml.type === 'webhook') {
          const webhookConfig: WebhookAgentConfig = {
            id: agentYaml.id,
            name: agentYaml.name,
            owner: agentYaml.owner,
            webhookUrl: agentYaml.webhook_url!,
            webhookSecret: agentYaml.webhook_secret ?? '',
            timeoutMs: (cfg.arena.webhook_timeout_seconds ?? 5) * 1000,
            maxSignalsPerCycle: cfg.arena.webhook_max_signals_per_cycle ?? 20,
            maxReasonLength: cfg.arena.webhook_max_reason_length ?? 280,
          };
          engine.registerAgent(new WebhookAgent(webhookConfig));
          console.log(`[Arena] Registered webhook agent: ${agentYaml.name} (${agentYaml.id})`);
        }
      }

      // Register dynamic external agents from state/arena/agent_registry.json (Phase 1 scaffold)
      const registryPath = resolve(stateDir, 'agent_registry.json');
      const registryData = readJsonOrDefault<{ agents?: RegistryAgentRecord[] }>(registryPath, { agents: [] });
      for (const row of (registryData.agents ?? [])) {
        if (!row.enabled) continue;
        if (registeredAgentIds.has(row.agent_id)) continue;

        await agentIdentityRegistrar.ensureAgent(row.agent_id, row.owner_address);
        if (row.connection_type === 'webhook') {
          const webhookSecret = resolveRegistrySecret(row.secret_ref);
          if (row.secret_ref && !webhookSecret) {
            console.warn(`[Arena] Registry agent ${row.agent_id} secret_ref unresolved: ${row.secret_ref}`);
          }
          const webhookConfig: WebhookAgentConfig = {
            id: row.agent_id,
            name: row.display_name,
            owner: row.owner_address,
            webhookUrl: row.endpoint,
            webhookSecret,
            timeoutMs: (cfg.arena.webhook_timeout_seconds ?? 5) * 1000,
            maxSignalsPerCycle: cfg.arena.webhook_max_signals_per_cycle ?? 20,
            maxReasonLength: cfg.arena.webhook_max_reason_length ?? 280,
          };
          engine.registerAgent(new WebhookAgent(webhookConfig));
          registeredAgentIds.add(row.agent_id);
          console.log(`[Arena] Registered registry webhook agent: ${row.display_name} (${row.agent_id})`);
          continue;
        }
        if (row.connection_type === 'stdio') {
          const processConfig: ProcessAgentConfig = {
            id: row.agent_id,
            name: row.display_name,
            owner: row.owner_address,
            command: row.endpoint,
            timeoutMs: (cfg.arena.stdio_timeout_seconds ?? 4) * 1000,
            maxStdoutBytes: cfg.arena.stdio_max_stdout_bytes ?? (256 * 1024),
            maxSignalsPerCycle: cfg.arena.webhook_max_signals_per_cycle ?? 20,
          };
          engine.registerAgent(new ProcessAgent(processConfig));
          registeredAgentIds.add(row.agent_id);
          console.log(`[Arena] Registered registry stdio agent: ${row.display_name} (${row.agent_id})`);
          continue;
        }
        if (row.connection_type === 'sdk') {
          const sdkConfig: SdkAgentConfig = {
            id: row.agent_id,
            name: row.display_name,
            owner: row.owner_address,
            modulePath: row.endpoint,
            timeoutMs: (cfg.arena.sdk_timeout_seconds ?? 4) * 1000,
            maxSignalsPerCycle: cfg.arena.webhook_max_signals_per_cycle ?? 20,
          };
          engine.registerAgent(new SdkAgent(sdkConfig));
          registeredAgentIds.add(row.agent_id);
          console.log(`[Arena] Registered registry sdk agent: ${row.display_name} (${row.agent_id})`);
          continue;
        }
        console.warn(`[Arena] Skipping registry agent ${row.agent_id} (unsupported type: ${row.connection_type})`);
      }

      // Start API server
      const apiCfg = agentCfg.api ?? { port: 3000, host: '127.0.0.1' };
      const resolvedPort = Number(
        process.env['PORT']
        ?? process.env['API_PORT']
        ?? apiCfg.port
        ?? 3000,
      ) || 3000;
      const resolvedHost = process.env['SYNAPTEX_API_HOST']?.trim()
        || apiCfg.host
        || '0.0.0.0';
      const api = createApiServer(engine, {
        ...apiCfg,
        port: resolvedPort,
        host: resolvedHost,
        stateDir,
        wsAuthToken: process.env['SYNAPTEX_WS_AUTH_TOKEN'] ?? agentCfg.api?.ws_auth_token,
        corsOrigin: process.env['SYNAPTEX_CORS_ORIGIN']?.trim() || '*',
        siweNonceTtlSeconds: Number(process.env['SYNAPTEX_SIWE_NONCE_TTL_SECONDS'] ?? '300') || 300,
        siweSessionTtlSeconds: Number(process.env['SYNAPTEX_SIWE_SESSION_TTL_SECONDS'] ?? '86400') || 86400,
        siweEnforceSignatureVerify: (process.env['SYNAPTEX_SIWE_ENFORCE_SIGNATURE_VERIFY'] ?? '0').trim() === '1',
      });
      await api.start();

      engine.addHook({
        async onCycleComplete(event) {
          try {
            await learningRootSubmitter.submit(event.seasonId, event.cycleId, event.cycleRoot);
          } catch (err) {
            await alertNotifier.notify({
              level: 'error',
              category: 'learning_root_submit',
              message: 'Failed to submit cycle root',
              context: {
                season_id: event.seasonId,
                cycle_id: event.cycleId,
                cycle_root: event.cycleRoot,
                error: err instanceof Error ? err.message : String(err),
              },
            }).catch(() => {});
            throw err;
          }
        },
        async onSeasonEnd(_season, _leaderboard, settlement) {
          if (!settlement) return;
          try {
            await settlementSubmitter.submit(settlement);
          } catch (err) {
            await alertNotifier.notify({
              level: 'error',
              category: 'season_settlement_submit',
              message: 'Failed to submit season settlement',
              context: {
                season_id: settlement.season_id,
                merkle_root: settlement.merkle_root,
                leaderboard_hash: settlement.leaderboard_hash,
                error: err instanceof Error ? err.message : String(err),
              },
            }).catch(() => {});
            throw err;
          }
        },
        async onAgentError(agentId, error) {
          await alertNotifier.notify({
            level: 'warn',
            category: 'agent_runtime_error',
            message: `Agent cycle error: ${agentId}`,
            context: { agent_id: agentId, error: error.message },
          }).catch(() => {});
        },
      });

      // Start arena engine
      engine.start();

      // Graceful shutdown
      for (const sig of ['SIGINT', 'SIGTERM']) {
        process.on(sig, async () => {
          console.log('\n[Arena] Shutting down...');
          engine.stop();
          await api.stop();
          sharedIpc.disconnect();
          process.exit(0);
        });
      }
    });

  // ── arena status ────────────────────────────────────────────────────────────
  arena
    .command('status')
    .description('Show current Arena season status')
    .option('--config <path>', 'Path to arena.yaml', 'config/arena.yaml')
    .action((opts) => {
      const arenaPath = resolve(opts.config);
      const cfg = loadArenaConfig(arenaPath);
      const stateDir = resolveStateDir(arenaPath, cfg);
      const season = readJsonOrDefault<Record<string, unknown>>(
        resolve(stateDir, 'season_current.json'), {}
      );
      const lb = readJsonOrDefault<{ entries: LeaderboardEntry[] }>(
        resolve(stateDir, 'leaderboard.json'), { entries: [] }
      );

      console.log('\n=== Arena Season Status ===');
      if (!season['id']) {
        console.log('No active season. Run: synaptex arena start');
        return;
      }
      console.log(`Season ID:   ${season['id']}`);
      console.log(`Status:      ${season['status']}`);
      console.log(`Started:     ${season['start_time']}`);
      console.log(`Ends:        ${season['end_time']}`);
      console.log(`Cycles Run:  ${season['cycle_count']}`);
      console.log(`Agents:      ${(season['agent_ids'] as string[])?.join(', ')}`);
      console.log('');
    });

  // ── arena leaderboard ─────────────────────────────────────────────────────
  arena
    .command('leaderboard')
    .description('Print the current leaderboard')
    .option('--config <path>', 'Path to arena.yaml', 'config/arena.yaml')
    .action((opts) => {
      const arenaPath = resolve(opts.config);
      const cfg = loadArenaConfig(arenaPath);
      const stateDir = resolveStateDir(arenaPath, cfg);
      const lb = readJsonOrDefault<{ updated_at: string; entries: LeaderboardEntry[] }>(
        resolve(stateDir, 'leaderboard.json'), { updated_at: '', entries: [] }
      );

      console.log('\n=== Arena Leaderboard ===');
      if (lb.entries.length === 0) {
        console.log('No data yet. Season may not have started or no cycles run.');
        return;
      }
      console.log(`Updated: ${lb.updated_at}\n`);
      console.log('Rank  Agent          ROI         Value (USD)  Signals  Trades  Valid');
      console.log('─'.repeat(72));
      for (const e of lb.entries) {
        const roi = (e.roi * 100).toFixed(2).padStart(7);
        const val = e.total_value_usd.toFixed(2).padStart(11);
        const valid = e.is_valid ? 'yes' : 'no';
        console.log(
          `${String(e.rank).padStart(4)}  ${e.agent_name.padEnd(14)} ${roi}%  $${val}  ${String(e.signal_count).padStart(7)}  ${String(e.trade_count).padStart(6)}  ${valid}`
        );
      }
      console.log('');
    });

  arena
    .command('ops-report')
    .description('Generate a local markdown operations report from state files')
    .option('--config <path>', 'Path to arena.yaml', 'config/arena.yaml')
    .option('--out <path>', 'Output markdown path', '')
    .action((opts) => {
      const arenaPath = resolve(opts.config);
      const cfg = loadArenaConfig(arenaPath);
      const stateDir = resolveStateDir(arenaPath, cfg);
      const outPath = opts.out?.trim()
        ? resolve(opts.out)
        : resolve(stateDir, 'ops_report.md');

      const season = readJsonOrDefault<Record<string, unknown>>(
        resolve(stateDir, 'season_current.json'),
        {},
      );
      const leaderboard = readJsonOrDefault<{ updated_at?: string; entries?: LeaderboardEntry[] }>(
        resolve(stateDir, 'leaderboard.json'),
        {},
      );
      const cursorPath = resolve(
        resolve(arenaPath, '../..'),
        process.env['ARENA_SYNC_LEARNING_CURSOR_PATH'] ?? `${cfg.arena.state_dir ?? 'state/arena'}/sync_learning_cursor.json`,
      );
      const cursor = readJsonOrDefault<Record<string, unknown>>(cursorPath, {});

      const settlementReceipts = countJsonLines(resolve(stateDir, 'settlement_receipts.jsonl'));
      const learningReceipts = countJsonLines(resolve(stateDir, 'learning_root_receipts.jsonl'));
      const settlementDlq = countJsonLines(resolve(stateDir, 'settlement_submit_failures.jsonl'));
      const alertDlq = countJsonLines(resolve(stateDir, 'alert_failures.jsonl'));
      const registry = readJsonOrDefault<{ agents?: Array<{ enabled?: boolean; connection_type?: string }> }>(
        resolve(stateDir, 'agent_registry.json'),
        { agents: [] },
      );
      const siwe = readJsonOrDefault<{ sessions?: unknown[]; nonces?: unknown[] }>(
        resolve(stateDir, 'siwe_sessions.json'),
        { sessions: [], nonces: [] },
      );
      const top = (leaderboard.entries ?? [])[0];
      const byType = (registry.agents ?? []).reduce<Record<string, number>>((acc, row) => {
        const t = String(row.connection_type ?? 'unknown');
        acc[t] = (acc[t] ?? 0) + 1;
        return acc;
      }, {});

      const markdown = [
        '# Arena Ops Report',
        '',
        `Generated: ${new Date().toISOString()}`,
        '',
        '## Season',
        `- id: ${String(season['id'] ?? 'n/a')}`,
        `- status: ${String(season['status'] ?? 'n/a')}`,
        `- cycle_count: ${String(season['cycle_count'] ?? 'n/a')}`,
        `- end_time: ${String(season['end_time'] ?? 'n/a')}`,
        '',
        '## Leaderboard',
        `- updated_at: ${String(leaderboard.updated_at ?? 'n/a')}`,
        `- entries: ${String((leaderboard.entries ?? []).length)}`,
        `- top_agent: ${top ? `${top.agent_id} (${(top.roi * 100).toFixed(2)}%)` : 'n/a'}`,
        '',
        '## Pipeline',
        `- sync_cursor: ${String(cursor['cursor'] ?? 'n/a')}`,
        `- sync_cursor_updated_at: ${String(cursor['updated_at'] ?? 'n/a')}`,
        `- settlement_receipts: ${settlementReceipts}`,
        `- learning_receipts: ${learningReceipts}`,
        '',
        '## Registry/Auth',
        `- registry_total: ${String((registry.agents ?? []).length)}`,
        `- registry_enabled: ${String((registry.agents ?? []).filter((a) => a.enabled).length)}`,
        `- registry_by_type: ${JSON.stringify(byType)}`,
        `- siwe_sessions_cached: ${String((siwe.sessions ?? []).length)}`,
        `- siwe_nonces_cached: ${String((siwe.nonces ?? []).length)}`,
        '',
        '## DLQ',
        `- settlement_submit_failures: ${settlementDlq}`,
        `- alert_failures: ${alertDlq}`,
        '',
      ].join('\n');

      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, markdown, 'utf-8');
      console.log(`[Arena] ops report written: ${outPath}`);
    });

  arena
    .command('bootstrap-onchain')
    .description('Bootstrap all enabled agents to on-chain NFA/TBA without starting Arena')
    .option('--config <path>', 'Path to arena.yaml', 'config/arena.yaml')
    .action(async (opts) => {
      const arenaPath = resolve(opts.config);
      const cfg = loadArenaConfig(arenaPath);
      const registrar = createAgentIdentityRegistrar();

      let count = 0;
      for (const agentYaml of cfg.agents) {
        if (!agentYaml.enabled) continue;
        await registrar.ensureAgent(agentYaml.id, agentYaml.owner);
        count += 1;
        console.log(`[Arena] on-chain identity ensured: ${agentYaml.id}`);
      }
      console.log(`[Arena] bootstrap complete (${count} agents)`);
    });

  arena
    .command('sync-learning')
    .description('Replay local cycle commitments to LearningRootOracle')
    .option('--config <path>', 'Path to arena.yaml', 'config/arena.yaml')
    .option('--limit <n>', 'Max rows to submit', '100')
    .option('--reset-cursor', 'Reset cursor to beginning before sync', false)
    .action(async (opts) => {
      const arenaPath = resolve(opts.config);
      const cfg = loadArenaConfig(arenaPath);
      const projectRoot = resolve(arenaPath, '../..');
      const stateDir = resolve(projectRoot, cfg.arena.state_dir ?? 'state/arena');
      const commitmentsPath = resolve(stateDir, 'cycle_commitments.jsonl');
      const cursorPath = resolve(
        projectRoot,
        process.env['ARENA_SYNC_LEARNING_CURSOR_PATH'] ?? `${cfg.arena.state_dir ?? 'state/arena'}/sync_learning_cursor.json`,
      );
      const submitter = createLearningRootSubmitter();

      if (!existsSync(commitmentsPath)) {
        console.log('[Arena] no cycle_commitments.jsonl found');
        return;
      }

      const limitNum = Math.max(1, Number(opts.limit ?? '100') || 100);
      const rawLines = readFileSync(commitmentsPath, 'utf-8').split('\n');

      if (opts.resetCursor) {
        writeCursor(cursorPath, 0);
      }
      let cursor = readCursor(cursorPath);
      if (cursor < 0) cursor = 0;
      if (cursor > rawLines.length) cursor = rawLines.length;
      const fromCursor = cursor;

      let submitted = 0;
      let skipped = 0;
      let failed = 0;
      let scanned = 0;
      for (let i = cursor; i < rawLines.length && scanned < limitNum; i++) {
        const line = rawLines[i]?.trim() ?? '';
        if (!line) {
          cursor = i + 1;
          scanned += 1;
          continue;
        }
        try {
          const row = JSON.parse(line) as {
            season_id?: string;
            cycle_id?: string;
            cycle_root?: string;
          };
          if (!row.season_id || !row.cycle_id || !row.cycle_root) {
            skipped += 1;
            cursor = i + 1;
            scanned += 1;
            continue;
          }
          const status = await submitter.submit(row.season_id, row.cycle_id, row.cycle_root);
          if (status === 'submitted') submitted += 1;
          else skipped += 1;
          cursor = i + 1;
          scanned += 1;
        } catch {
          failed += 1;
          // keep cursor at failed row for retry
          break;
        }
      }

      writeCursor(cursorPath, cursor);
      console.log(
        `[Arena] learning sync done: submitted=${submitted}, skipped=${skipped}, failed=${failed}, scanned=${scanned}, cursor=${fromCursor}->${cursor}`
      );
    });

  arena
    .command('export-sql')
    .description('Export local state json/jsonl into PostgreSQL upsert SQL script')
    .option('--config <path>', 'Path to arena.yaml', 'config/arena.yaml')
    .option('--out <path>', 'Output .sql file', '')
    .action((opts) => {
      const arenaPath = resolve(opts.config);
      const cfg = loadArenaConfig(arenaPath);
      const projectRoot = resolve(arenaPath, '../..');
      const stateDir = resolve(projectRoot, cfg.arena.state_dir ?? 'state/arena');
      const outPath = opts.out?.trim()
        ? resolve(opts.out)
        : resolve(stateDir, 'phase1_export.sql');

      const sqlRows: string[] = [];
      sqlRows.push('-- generated by: synaptex arena export-sql');
      sqlRows.push(`-- generated_at: ${new Date().toISOString()}`);
      sqlRows.push('BEGIN;');

      const agentRegistryPath = resolve(stateDir, 'agent_registry.json');
      const siwePath = resolve(stateDir, 'siwe_sessions.json');
      const replayPath = resolve(stateDir, 'agent_decision_replay.jsonl');
      const seasonPath = resolve(stateDir, 'season_current.json');
      const commitmentsPath = resolve(stateDir, 'cycle_commitments.jsonl');

      const agentRegistry = readJsonOrDefault<{ agents?: Array<Record<string, unknown>> }>(
        agentRegistryPath,
        { agents: [] },
      );
      for (const row of (agentRegistry.agents ?? [])) {
        sqlRows.push(
          'INSERT INTO agents (agent_id, owner_wallet_address, display_name, connection_type, endpoint, secret_ref, enabled, created_at, updated_at) VALUES '
          + `(${sqlText(row['agent_id'])}, ${sqlText(row['owner_address'])}, ${sqlText(row['display_name'])}, `
          + `${sqlText(row['connection_type'])}, ${sqlText(row['endpoint'])}, ${sqlText(row['secret_ref'])}, `
          + `${sqlBool(row['enabled'])}, ${sqlTs(row['created_at'])}, ${sqlTs(row['updated_at'])}) `
          + 'ON CONFLICT (agent_id) DO UPDATE SET '
          + 'owner_wallet_address=EXCLUDED.owner_wallet_address, display_name=EXCLUDED.display_name, '
          + 'connection_type=EXCLUDED.connection_type, endpoint=EXCLUDED.endpoint, '
          + 'secret_ref=EXCLUDED.secret_ref, enabled=EXCLUDED.enabled, updated_at=EXCLUDED.updated_at;'
        );
      }

      const siwe = readJsonOrDefault<{ nonces?: Array<Record<string, unknown>>; sessions?: Array<Record<string, unknown>> }>(
        siwePath,
        { nonces: [], sessions: [] },
      );
      for (const n of (siwe.nonces ?? [])) {
        sqlRows.push(
          'INSERT INTO siwe_nonces (wallet_address, nonce, issued_at, expires_at, used) VALUES '
          + `(${sqlText(n['address'])}, ${sqlText(n['nonce'])}, ${sqlTs(n['issuedAt'])}, ${sqlTs(n['expiresAt'])}, ${sqlBool(n['used'])});`
        );
      }
      for (const s of (siwe.sessions ?? [])) {
        sqlRows.push(
          'INSERT INTO sessions (wallet_address, session_token, signature_verified, created_at, expires_at) VALUES '
          + `(${sqlText(s['address'])}, ${sqlText(s['token'])}, ${sqlBool(s['signatureVerified'])}, ${sqlTs(s['createdAt'])}, ${sqlTs(s['expiresAt'])}) `
          + 'ON CONFLICT (session_token) DO NOTHING;'
        );
      }

      const season = readJsonOrDefault<Record<string, unknown>>(seasonPath, {});
      if (season['id']) {
        sqlRows.push(
          'INSERT INTO seasons (season_id, status, start_time, end_time, settlement_algorithm, leaderboard_hash) VALUES '
          + `(${sqlText(season['id'])}, ${sqlText(season['status'])}, ${sqlTs(season['start_time'])}, ${sqlTs(season['end_time'])}, `
          + `${sqlText(season['settlement_algorithm'])}, ${sqlText(season['leaderboard_hash'])}) `
          + 'ON CONFLICT (season_id) DO UPDATE SET status=EXCLUDED.status, end_time=EXCLUDED.end_time, leaderboard_hash=EXCLUDED.leaderboard_hash;'
        );
      }

      for (const row of readJsonLines(commitmentsPath)) {
        sqlRows.push(
          'INSERT INTO cycles (season_id, cycle_id, cycle_root, signal_count, trade_count, created_at) VALUES '
          + `(${sqlText(row['season_id'])}, ${sqlText(row['cycle_id'])}, ${sqlText(row['cycle_root'])}, `
          + `${sqlInt(row['signal_count'])}, ${sqlInt(row['trade_count'])}, ${sqlTs(row['timestamp'])}) `
          + 'ON CONFLICT (season_id, cycle_id) DO UPDATE SET cycle_root=EXCLUDED.cycle_root, signal_count=EXCLUDED.signal_count, trade_count=EXCLUDED.trade_count;'
        );
      }

      for (const row of readJsonLines(replayPath)) {
        sqlRows.push(
          'INSERT INTO decision_replay (season_id, cycle_id, agent_id, snapshot_hash, portfolio_before_hash, portfolio_after_hash, '
          + 'signals_hash, signal_count, trade_count, trace_id, idempotency_key, request_hash, response_hash, latency_ms, error, created_at) VALUES '
          + `(${sqlText(row['season_id'])}, ${sqlText(row['cycle_id'])}, ${sqlText(row['agent_id'])}, ${sqlText(row['snapshot_hash'])}, `
          + `${sqlText(row['portfolio_before_hash'])}, ${sqlText(row['portfolio_after_hash'])}, ${sqlText(row['signals_hash'])}, `
          + `${sqlInt(row['signal_count'])}, ${sqlInt(row['trade_count'])}, ${sqlText(row['trace_id'])}, ${sqlText(row['idempotency_key'])}, `
          + `${sqlText(row['request_hash'])}, ${sqlText(row['response_hash'])}, ${sqlInt(row['latency_ms'])}, ${sqlText(row['error'])}, ${sqlTs(row['timestamp'])});`
        );
      }

      sqlRows.push('COMMIT;');
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, `${sqlRows.join('\n')}\n`, 'utf-8');
      console.log(`[Arena] SQL export written: ${outPath}`);
    });

  arena
    .command('db-init')
    .description('Initialize PostgreSQL schema using packages/api-server/db/schema.sql')
    .option('--database-url <url>', 'Override SYNAPTEX_DATABASE_URL', '')
    .option('--schema <path>', 'Override schema.sql path', '')
    .action((opts) => {
      const databaseUrl = String(opts.databaseUrl ?? '').trim() || process.env['SYNAPTEX_DATABASE_URL']?.trim() || '';
      if (!databaseUrl) {
        console.log('[Arena] missing database url. set SYNAPTEX_DATABASE_URL or pass --database-url');
        process.exitCode = 1;
        return;
      }
      const schemaPath = String(opts.schema ?? '').trim()
        ? resolve(String(opts.schema).trim())
        : resolve(process.cwd(), 'packages/api-server/db/schema.sql');
      if (!existsSync(schemaPath)) {
        console.log(`[Arena] schema file not found: ${schemaPath}`);
        process.exitCode = 1;
        return;
      }

      const psql = spawnSync('psql', [databaseUrl, '-f', schemaPath], {
        stdio: 'inherit',
      });
      if (psql.status === 0) {
        console.log('[Arena] db-init complete');
        return;
      }
      console.log('[Arena] failed to run psql automatically. run this manually:');
      console.log(`psql "${databaseUrl}" -f "${schemaPath}"`);
      process.exitCode = 1;
    });
}

function readCursor(path: string): number {
  if (!existsSync(path)) return 0;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { cursor?: number };
    const c = Number(parsed.cursor ?? 0);
    return Number.isFinite(c) ? Math.max(0, Math.floor(c)) : 0;
  } catch {
    return 0;
  }
}

function writeCursor(path: string, cursor: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      cursor: Math.max(0, Math.floor(cursor)),
      updated_at: new Date().toISOString(),
    }, null, 2),
    'utf-8',
  );
}

function countJsonLines(path: string): number {
  if (!existsSync(path)) return 0;
  const rows = readFileSync(path, 'utf-8')
    .split('\n')
    .map((v) => v.trim())
    .filter(Boolean);
  return rows.length;
}

function readJsonLines(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8')
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
    .filter((v): v is Record<string, unknown> => v !== null);
}

function sqlEscape(value: string): string {
  return value.replace(/'/g, "''");
}

function sqlText(value: unknown): string {
  if (value === undefined || value === null || value === '') return 'NULL';
  return `'${sqlEscape(String(value))}'`;
}

function sqlInt(value: unknown): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return '0';
  return String(Math.floor(n));
}

function sqlBool(value: unknown): string {
  return value === true ? 'TRUE' : 'FALSE';
}

function sqlTs(value: unknown): string {
  if (!value) return 'NOW()';
  return sqlText(value);
}
