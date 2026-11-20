import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';

import { type ZodType, z } from 'zod';

import {
  DeviceIdSchema,
  MotionPatchSchema,
  RouteRequestSchema,
  ScenarioSchema,
  ScenarioSlugSchema,
  SeekRequestSchema,
  SignalRequestSchema,
  StartRequestSchema,
  TeleportRequestSchema,
  WifiConnectRequestSchema,
  WifiPairRequestSchema,
} from '../shared/schema';
import { adbConnect, adbPair, discoverWifi, switchToWifi } from './drivers/android';
import { listDevices } from './drivers';
import { errorMessage } from './exec';
import { geocode } from './geocode';
import { computeRoute } from './routing';
import type { ScenarioStore } from './scenarios';
import { NotFoundError, type SessionEvent, type SessionManager } from './sessions';

const MAX_BODY_BYTES = 1024 * 1024;
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface Context {
  req: IncomingMessage;
  res: ServerResponse;
  params: string[];
  url: URL;
}

type Handler = (ctx: Context) => Promise<unknown>;

interface RouteDef {
  method: string;
  pattern: RegExp;
  handler: Handler;
}

export interface ServerOptions {
  host: string;
  port: number;
  sessions: SessionManager;
  scenarios: ScenarioStore;
  /** Pasta com o front já compilado (modo normal). */
  staticDir: string;
  /** Middleware do Vite (modo dev, com recarga automática). */
  devMiddleware?: (req: IncomingMessage, res: ServerResponse, next: () => void) => void;
}

export function createAppServer(options: ServerOptions): Server {
  const { sessions, scenarios } = options;
  const routes: RouteDef[] = [];
  const on = (method: string, path: string, handler: Handler) => {
    const pattern = new RegExp(`^${path.replace(/:\w+/g, '([^/]+)')}$`);
    routes.push({ method, pattern, handler });
  };

  const deviceParam = (ctx: Context) => parse(DeviceIdSchema, decodeURIComponent(ctx.params[0] ?? ''));
  const slugParam = (ctx: Context) => parse(ScenarioSlugSchema, decodeURIComponent(ctx.params[0] ?? ''));
  const ok = { ok: true } as const;

  on('GET', '/api/devices', () => listDevices());

  on('GET', '/api/wifi/discover', async () => ({ services: await discoverWifi() }));
  on('POST', '/api/wifi/pair', async (ctx) => {
    const body = parse(WifiPairRequestSchema, await readJson(ctx.req));
    return { message: await adbPair(body.host, body.port, body.code) };
  });
  on('POST', '/api/wifi/connect', async (ctx) => {
    const body = parse(WifiConnectRequestSchema, await readJson(ctx.req));
    return { message: await adbConnect(body.host, body.port) };
  });
  on('POST', '/api/devices/:id/wifi', async (ctx) => ({ message: await switchToWifi(deviceParam(ctx)) }));

  on('POST', '/api/route', async (ctx) => computeRoute(parse(RouteRequestSchema, await readJson(ctx.req))));

  on('GET', '/api/geocode', async (ctx) => {
    const q = parse(z.string().trim().min(3).max(200), ctx.url.searchParams.get('q') ?? '');
    return { results: await geocode(q) };
  });

  on('GET', '/api/scenarios', async () => ({ scenarios: await scenarios.list() }));
  on('GET', '/api/scenarios/:slug', (ctx) => scenarios.read(slugParam(ctx)));
  on('PUT', '/api/scenarios/:slug', async (ctx) => {
    await scenarios.write(slugParam(ctx), parse(ScenarioSchema, await readJson(ctx.req)));
    return ok;
  });
  on('DELETE', '/api/scenarios/:slug', async (ctx) => {
    await scenarios.remove(slugParam(ctx));
    return ok;
  });

  on('GET', '/api/sessions', async () => ({ sessions: sessions.list() }));

  on('POST', '/api/devices/:id/reset', async (ctx) => {
    await sessions.reset(deviceParam(ctx));
    return ok;
  });

  on('POST', '/api/sim/:id/start', async (ctx) => {
    const body = parse(StartRequestSchema, await readJson(ctx.req));
    return sessions.startRoute(deviceParam(ctx), body.scenario, body.route);
  });
  on('POST', '/api/sim/:id/teleport', async (ctx) => {
    const body = parse(TeleportRequestSchema, await readJson(ctx.req));
    return sessions.teleport(
      deviceParam(ctx),
      { lat: body.lat, lng: body.lng },
      { speedKmh: 1, timeScale: 1, accuracyM: body.accuracyM, jitterM: 0, tickMs: 1000, loop: 'off' },
    );
  });
  on('POST', '/api/sim/:id/stop', async (ctx) => {
    await sessions.stop(deviceParam(ctx));
    return ok;
  });

  const control = (action: string, apply: (ctx: Context, sim: ReturnType<SessionManager['get']>) => Promise<void>) =>
    on('POST', `/api/sim/:id/${action}`, async (ctx) => {
      const sim = sessions.get(deviceParam(ctx));
      await apply(ctx, sim);
      return sim.detail();
    });
  control('pause', async (_ctx, sim) => sim.pause());
  control('resume', async (_ctx, sim) => sim.resume());
  control('restart', async (_ctx, sim) => sim.restart());
  control('seek', async (ctx, sim) => sim.seek(parse(SeekRequestSchema, await readJson(ctx.req)).fraction));
  control('motion', async (ctx, sim) => sim.setMotion(parse(MotionPatchSchema, await readJson(ctx.req))));
  control('signal', async (ctx, sim) => sim.setSignalLost(parse(SignalRequestSchema, await readJson(ctx.req)).lost));

  return createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      if (!res.headersSent) sendJson(res, 500, { error: errorMessage(error) });
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Proteção contra DNS rebinding: só aceita Host local.
    const host = req.headers.host ?? '';
    const hostname = host.replace(/:\d+$/, '');
    if (!LOCAL_HOSTNAMES.has(hostname) && hostname !== options.host) {
      sendJson(res, 403, { error: 'Host não permitido' });
      return;
    }
    const url = new URL(req.url ?? '/', `http://${host}`);

    if (!url.pathname.startsWith('/api/')) {
      if (options.devMiddleware) {
        options.devMiddleware(req, res, () => sendJson(res, 404, { error: 'Não encontrado' }));
        return;
      }
      serveStatic(options.staticDir, url.pathname, res);
      return;
    }

    const method = req.method ?? 'GET';
    if (method !== 'GET') {
      // Um site qualquer aberto no navegador não pode mandar comandos para cá:
      // JSON força preflight de CORS (que não respondemos) e a origem tem que ser esta.
      const origin = req.headers.origin;
      if (origin !== undefined && origin !== `http://${host}`) {
        sendJson(res, 403, { error: 'Origem não permitida' });
        return;
      }
      if (!(req.headers['content-type'] ?? '').startsWith('application/json')) {
        sendJson(res, 415, { error: 'Envie Content-Type: application/json' });
        return;
      }
    }

    if (method === 'GET' && url.pathname === '/api/events') {
      openEventStream(req, res, sessions);
      return;
    }

    for (const route of routes) {
      if (route.method !== method) continue;
      const match = route.pattern.exec(url.pathname);
      if (!match) continue;
      try {
        const result = await route.handler({ req, res, url, params: match.slice(1) });
        sendJson(res, 200, result);
      } catch (error) {
        const status =
          error instanceof HttpError ? error.status : error instanceof NotFoundError ? 404 : 422;
        sendJson(res, status, { error: errorMessage(error) });
      }
      return;
    }
    sendJson(res, 404, { error: 'Rota não encontrada' });
  }
}

function parse<T>(schema: ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const where = issue?.path.length ? `${issue.path.join('.')}: ` : '';
  throw new HttpError(400, `Dados inválidos — ${where}${issue?.message ?? 'formato inesperado'}`);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Corpo da requisição grande demais');
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch {
    throw new HttpError(400, 'JSON inválido');
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(text);
}

function openEventStream(req: IncomingMessage, res: ServerResponse, sessions: SessionManager): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
  });
  const send = (event: SessionEvent) => {
    const data = event.type === 'tick' ? event.state : { sessions: event.sessions };
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  send({ type: 'sessions', sessions: sessions.list() });
  const unsubscribe = sessions.subscribe(send);
  const keepAlive = setInterval(() => res.write(': ping\n\n'), 20_000);
  req.on('close', () => {
    clearInterval(keepAlive);
    unsubscribe();
  });
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

function serveStatic(root: string, pathname: string, res: ServerResponse): void {
  const index = join(root, 'index.html');
  if (!existsSync(index)) {
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Interface não compilada. Rode "pnpm build" ou use "pnpm dev".');
    return;
  }
  const safe = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
  let file = join(root, safe);
  if (!file.startsWith(root + sep) || !existsSync(file) || statSync(file).isDirectory()) file = index;
  res.writeHead(200, {
    'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
    'Cache-Control': file === index ? 'no-store' : 'public, max-age=31536000, immutable',
  });
  createReadStream(file).pipe(res);
}
