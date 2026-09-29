import fs from 'fs';
import path from 'path';
import { logger } from './logger';

export interface RpcEndpoint {
  http: string;
  ws: string;
  /** Redacted label for logs */
  label: string;
}

const HELIUS_HTTP = 'https://mainnet.helius-rpc.com/?api-key=';
const HELIUS_WS = 'wss://mainnet.helius-rpc.com/?api-key=';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function redactUrl(url: string): string {
  return url.replace(/api-key=[^&\s]+/i, 'api-key=***');
}

function httpToWs(httpUrl: string): string {
  if (httpUrl.startsWith('https://')) {
    return `wss://${httpUrl.slice('https://'.length)}`;
  }
  if (httpUrl.startsWith('http://')) {
    return `ws://${httpUrl.slice('http://'.length)}`;
  }
  return httpUrl;
}

function parseLine(line: string): RpcEndpoint | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) {
    return null;
  }

  // Full URL
  if (/^https?:\/\//i.test(trimmed)) {
    return {
      http: trimmed,
      ws: httpToWs(trimmed),
      label: redactUrl(trimmed),
    };
  }

  // Bare Helius API key
  if (UUID_RE.test(trimmed)) {
    return {
      http: `${HELIUS_HTTP}${trimmed}`,
      ws: `${HELIUS_WS}${trimmed}`,
      label: `helius:***${trimmed.slice(-4)}`,
    };
  }

  // api-key=... fragment
  const keyMatch = trimmed.match(/api-key=([0-9a-f-]{36})/i);
  if (keyMatch) {
    const key = keyMatch[1];
    return {
      http: `${HELIUS_HTTP}${key}`,
      ws: `${HELIUS_WS}${key}`,
      label: `helius:***${key.slice(-4)}`,
    };
  }

  return null;
}

/**
 * Round-robin + cooldown pool of RPC endpoints.
 * Spreads HTTP (and sticky WS) load across many Helius keys / RPC URLs.
 */
export class RpcPool {
  private readonly endpoints: RpcEndpoint[];
  private cursor = 0;
  private readonly cooldownUntil = new Map<string, number>();
  private readonly cooldownMs: number;

  constructor(endpoints: RpcEndpoint[], cooldownMs = 15_000) {
    if (endpoints.length === 0) {
      throw new Error('RpcPool requires at least one endpoint');
    }
    // Dedupe by http URL
    const seen = new Set<string>();
    this.endpoints = [];
    for (const ep of endpoints) {
      if (!seen.has(ep.http)) {
        seen.add(ep.http);
        this.endpoints.push(ep);
      }
    }
    this.cooldownMs = cooldownMs;
  }

  get size(): number {
    return this.endpoints.length;
  }

  /** Sticky endpoint for stream preset index (different key per stream). */
  sticky(index: number): RpcEndpoint {
    return this.endpoints[index % this.endpoints.length];
  }

  /** Next healthy endpoint for HTTP (skips cooled-down keys). */
  nextHttp(): RpcEndpoint {
    const now = Date.now();
    for (let i = 0; i < this.endpoints.length; i++) {
      const ep = this.endpoints[this.cursor % this.endpoints.length];
      this.cursor = (this.cursor + 1) % this.endpoints.length;
      const until = this.cooldownUntil.get(ep.http) || 0;
      if (until <= now) {
        return ep;
      }
    }
    // All cooling — return least-recently cooled
    let best = this.endpoints[0];
    let bestUntil = this.cooldownUntil.get(best.http) || 0;
    for (const ep of this.endpoints) {
      const until = this.cooldownUntil.get(ep.http) || 0;
      if (until < bestUntil) {
        best = ep;
        bestUntil = until;
      }
    }
    return best;
  }

  markRateLimited(httpUrl: string) {
    this.cooldownUntil.set(httpUrl, Date.now() + this.cooldownMs);
  }

  summary(): string {
    return `${this.endpoints.length} endpoints`;
  }
}

export function loadRpcEndpointsFromEnv(): RpcEndpoint[] {
  const endpoints: RpcEndpoint[] = [];

  const keysFile = (process.env.RPC_KEYS_FILE || '').trim();
  if (keysFile) {
    const resolved = path.isAbsolute(keysFile) ? keysFile : path.join(process.cwd(), keysFile);
    if (fs.existsSync(resolved)) {
      const lines = fs.readFileSync(resolved, 'utf8').split(/\r?\n/);
      for (const line of lines) {
        const ep = parseLine(line);
        if (ep) {
          endpoints.push(ep);
        }
      }
      logger.info({ file: resolved, count: endpoints.length }, 'Loaded RPC keys file');
    } else {
      logger.warn({ file: resolved }, 'RPC_KEYS_FILE not found');
    }
  }

  const multi = (process.env.RPC_ENDPOINTS || '').trim();
  if (multi) {
    for (const part of multi.split(/[\n,]+/)) {
      const ep = parseLine(part);
      if (ep) {
        endpoints.push(ep);
      }
    }
  }

  // Fallback single endpoint
  if (endpoints.length === 0) {
    const single = (process.env.RPC_ENDPOINT || process.env.MAINNET_ENDPOINT || '').trim();
    if (single) {
      const ep = parseLine(single);
      if (ep) {
        endpoints.push(ep);
      }
    }
  }

  return endpoints;
}

export function createRpcPoolFromEnv(): RpcPool {
  const endpoints = loadRpcEndpointsFromEnv();
  if (endpoints.length === 0) {
    throw new Error('No RPC endpoints configured. Set RPC_KEYS_FILE, RPC_ENDPOINTS, or RPC_ENDPOINT.');
  }
  return new RpcPool(endpoints);
}
