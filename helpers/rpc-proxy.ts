import http from 'http';
import { RpcPool } from './rpc-pool';
import { logger } from './logger';

export interface RpcProxyHandle {
  url: string;
  port: number;
  close: () => Promise<void>;
}

/**
 * Local HTTP JSON-RPC proxy that round-robins upstream Helius/RPC keys.
 * Stream WebSockets still connect directly to per-key WSS endpoints;
 * this proxy only spreads HTTP (getTransaction, getSlot, sends, etc.).
 */
export async function startRpcProxy(pool: RpcPool, preferredPort = 18789): Promise<RpcProxyHandle> {
  const maxAttempts = 5;
  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const port = preferredPort + attempt;
    try {
      const handle = await listen(pool, port);
      return handle;
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code !== 'EADDRINUSE') {
        throw error;
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Failed to bind RPC proxy');
}

function listen(pool: RpcPool, port: number): Promise<RpcProxyHandle> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      void handleRequest(pool, req, res);
    });

    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      const url = `http://127.0.0.1:${port}`;
      logger.info({ url, upstreams: pool.size }, 'RPC load-balancer proxy listening');
      resolve({
        url,
        port,
        close: () =>
          new Promise((resClose, rejClose) => {
            server.close((err) => (err ? rejClose(err) : resClose()));
          }),
      });
    });
  });
}

async function handleRequest(
  pool: RpcPool,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, upstreams: pool.size }));
    return;
  }

  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'POST only' }));
    return;
  }

  let body: Buffer;
  try {
    body = await readBody(req);
  } catch {
    res.writeHead(400);
    res.end('bad body');
    return;
  }

  const maxRetries = Math.min(8, Math.max(3, Math.ceil(pool.size / 10)));
  let lastStatus = 502;
  let lastBody = Buffer.from('{"error":"upstream failed"}');

  for (let i = 0; i < maxRetries; i++) {
    const upstream = pool.nextHttp();
    try {
      const result = await forward(upstream.http, body, req.headers['content-type']);
      if (result.status === 429) {
        pool.markRateLimited(upstream.http);
        lastStatus = 429;
        lastBody = result.body;
        continue;
      }
      res.writeHead(result.status, {
        'Content-Type': result.contentType || 'application/json',
        'X-Upstream-Label': upstream.label,
      });
      res.end(result.body);
      return;
    } catch {
      pool.markRateLimited(upstream.http);
    }
  }

  res.writeHead(lastStatus, { 'Content-Type': 'application/json' });
  res.end(lastBody);
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function forward(
  url: string,
  body: Buffer,
  contentType?: string,
): Promise<{ status: number; body: Buffer; contentType?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': contentType || 'application/json',
      },
      body,
      signal: controller.signal,
    });
    const buf = Buffer.from(await response.arrayBuffer());
    return {
      status: response.status,
      body: buf,
      contentType: response.headers.get('content-type') || undefined,
    };
  } finally {
    clearTimeout(timer);
  }
}
