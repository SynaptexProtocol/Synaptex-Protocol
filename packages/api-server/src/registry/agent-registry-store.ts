import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';

export type AgentConnectionType = 'webhook' | 'sdk' | 'stdio';

export interface AgentRegistration {
  agent_id: string;
  owner_address: string;
  display_name: string;
  connection_type: AgentConnectionType;
  endpoint: string;
  secret_ref?: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

interface StoreFileShape {
  agents: AgentRegistration[];
}

function nowIso(): string {
  return new Date().toISOString();
}

export class AgentRegistryStore {
  private cache: StoreFileShape;

  constructor(private readonly filePath: string) {
    this.cache = this.read();
  }

  list(): AgentRegistration[] {
    return [...this.cache.agents];
  }

  getById(agentId: string): AgentRegistration | null {
    return this.cache.agents.find((a) => a.agent_id === agentId) ?? null;
  }

  upsert(input: Omit<AgentRegistration, 'created_at' | 'updated_at'>): AgentRegistration {
    const now = nowIso();
    const existing = this.cache.agents.find((a) => a.agent_id === input.agent_id);
    if (existing) {
      existing.owner_address = input.owner_address;
      existing.display_name = input.display_name;
      existing.connection_type = input.connection_type;
      existing.endpoint = input.endpoint;
      existing.secret_ref = input.secret_ref;
      existing.enabled = input.enabled;
      existing.updated_at = now;
      this.write();
      return existing;
    }

    const created: AgentRegistration = {
      ...input,
      created_at: now,
      updated_at: now,
    };
    this.cache.agents.push(created);
    this.write();
    return created;
  }

  setEnabled(agentId: string, enabled: boolean): AgentRegistration | null {
    const now = nowIso();
    const found = this.cache.agents.find((a) => a.agent_id === agentId);
    if (!found) return null;
    found.enabled = enabled;
    found.updated_at = now;
    this.write();
    return found;
  }

  remove(agentId: string): boolean {
    const before = this.cache.agents.length;
    this.cache.agents = this.cache.agents.filter((a) => a.agent_id !== agentId);
    const changed = this.cache.agents.length !== before;
    if (changed) this.write();
    return changed;
  }

  private read(): StoreFileShape {
    if (!existsSync(this.filePath)) {
      return { agents: [] };
    }
    try {
      return JSON.parse(readFileSync(this.filePath, 'utf-8')) as StoreFileShape;
    } catch {
      return { agents: [] };
    }
  }

  private write(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(this.cache, null, 2), 'utf-8');
  }
}
