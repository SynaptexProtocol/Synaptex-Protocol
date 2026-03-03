import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';

export type WsEventType =
  | 'cycle_complete'
  | 'leaderboard'
  | 'season_start'
  | 'season_end'
  | 'task_funded'
  | 'task_delivered'
  | 'task_released'
  | 'task_refunded';

export interface WsEvent {
  type: WsEventType;
  timestamp: string;
  data: unknown;
}

interface WsBroadcasterConfig {
  authToken?: string;
}

export class WsBroadcaster {
  private wss: WebSocketServer;
  private readonly authToken?: string;

  constructor(server: Server, config: WsBroadcasterConfig = {}) {
    this.authToken = config.authToken;
    this.wss = new WebSocketServer({ server, path: '/ws' });

    this.wss.on('connection', (ws, req) => {
      if (!this.isAuthorized(req.url ?? '')) {
        ws.close(1008, 'Unauthorized');
        return;
      }
      ws.on('error', () => {});
      // Send current time as ping to confirm connection
      ws.send(JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() }));
    });
  }

  broadcast(type: WsEventType, data: unknown): void {
    const msg = JSON.stringify({ type, timestamp: new Date().toISOString(), data });
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(msg);
      }
    }
  }

  get clientCount(): number {
    return this.wss.clients.size;
  }

  private isAuthorized(rawUrl: string): boolean {
    if (!this.authToken) return true;
    try {
      const url = new URL(rawUrl, 'http://localhost');
      const token = url.searchParams.get('token');
      return token === this.authToken;
    } catch {
      return false;
    }
  }
}
