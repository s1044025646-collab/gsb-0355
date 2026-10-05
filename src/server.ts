import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { AuditService } from './service.js';
import { DomainError } from './domain.js';

interface RouteContext {
  service: AuditService;
  params: Record<string, string>;
  body: unknown;
  query: URL;
}

type Handler = (ctx: RouteContext) => unknown | Promise<unknown>;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

function route(method: string, path: string, handler: Handler): Route {
  const keys: string[] = [];
  const pattern = new RegExp(
    '^' +
      path.replace(/:([A-Za-z]+)/g, (_, key: string) => {
        keys.push(key);
        return '([^/]+)';
      }) +
      '$',
  );
  return { method, pattern, keys, handler };
}

const ROUTES: Route[] = [
  route('GET', '/health', () => ({ ok: true })),
  route('POST', '/api/pairs', (ctx) => {
    const b = ctx.body as { pairId?: string; clientLabel?: string; serverLabel?: string };
    return ctx.service.createClockPair(b?.pairId, String(b?.clientLabel ?? ''), String(b?.serverLabel ?? ''));
  }),
  route('GET', '/api/pairs', (ctx) => ctx.service.store.listClockPairs()),
  route('GET', '/api/pairs/:pairId', (ctx) => {
    const pair = ctx.service.store.getClockPair(ctx.params.pairId!);
    if (!pair) throw new DomainError('PAIR_NOT_FOUND', `时钟对不存在: ${ctx.params.pairId}`);
    return pair;
  }),
  route('POST', '/api/pairs/:pairId/batches', (ctx) => {
    const b = ctx.body as { records?: unknown[]; batchId?: string; sourceNote?: string };
    return ctx.service.importBatch(ctx.params.pairId!, b?.records ?? [], {
      batchId: b?.batchId,
      sourceNote: b?.sourceNote ?? null,
    });
  }),
  route('GET', '/api/batches', (ctx) => ctx.service.store.listBatches(ctx.query.searchParams.get('pairId') ?? undefined)),
  route('GET', '/api/batches/:batchId', (ctx) => ctx.service.getReport(ctx.params.batchId!)),
  route('POST', '/api/compare', (ctx) => {
    const b = ctx.body as { batchIds?: string[] };
    return ctx.service.compareBatches(b?.batchIds ?? []);
  }),
];

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload, (_key, value) =>
    typeof value === 'bigint' ? value.toString() : value,
  );
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(text);
}

const ERROR_STATUS: Record<string, number> = {
  VALIDATION_ERROR: 400,
  LIMIT_EXCEEDED: 400,
  PAIR_EXISTS: 409,
  BATCH_EXISTS: 409,
  PAIR_NOT_FOUND: 404,
  BATCH_NOT_FOUND: 404,
  PAIR_MISMATCH: 409,
};

export function createApp(service: AuditService): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res, service);
  });
}

async function handle(req: IncomingMessage, res: ServerResponse, service: AuditService): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    let body: unknown = null;
    if (chunks.length > 0) {
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.trim()) {
        try {
          body = JSON.parse(text);
        } catch {
 throw new DomainError('VALIDATION_ERROR', '请求体不是合法 JSON');
        }
      }
    }

    for (const route of ROUTES) {
      if (route.method !== req.method) continue;
      const match = route.pattern.exec(url.pathname);
      if (!match) continue;
      const params: Record<string, string> = {};
      route.keys.forEach((key, i) => {
        params[key] = decodeURIComponent(match[i + 1]!);
      });
      const result = await route.handler({ service, params, body, query: url });
      sendJson(res, 200, result);
      return;
    }
    sendJson(res, 404, { error: { code: 'NOT_FOUND', message: `无此路由: ${req.method} ${url.pathname}` } });
  } catch (err) {
    if (err instanceof DomainError) {
      sendJson(res, ERROR_STATUS[err.code] ?? 400, { error: { code: err.code, message: err.message, details: err.details } });
    } else {
      sendJson(res, 500, { error: { code: 'INTERNAL', message: (err as Error).message } });
    }
  }
}

export interface ListenResult {
  port: number;
  close: () => Promise<void>;
}

/** 启动服务；port 省略或为 0 时由操作系统分配空闲端口。 */
export function listen(server: Server, port = 0, host = '127.0.0.1'): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}
