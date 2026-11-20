import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { z } from 'zod';

import { formatClock, formatDistance } from '../shared/geo';
import { LoopModeSchema, type SessionState } from '../shared/schema';
import { listDevices } from './drivers';
import { errorMessage } from './exec';
import { createAppServer } from './http';
import { computeRoute } from './routing';
import { readScenarioFile, ScenarioStore } from './scenarios';
import { SessionManager } from './sessions';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const HELP = `gps-sim — simula o GPS de um aparelho se movendo

Uso:
  gps-sim [serve]                Abre a interface web (http://127.0.0.1:4600)
      --port <n>                 Porta (padrão 4600)
      --scenarios <pasta>        Onde ficam os cenários salvos (padrão ./scenarios do projeto)
      --no-open                  Não abrir o navegador
  gps-sim devices                Lista aparelhos e se estão prontos
  gps-sim run <cenario.json>     Roda um cenário sem interface (útil em testes automatizados)
      --device <id>              Aparelho (obrigatório se houver mais de um)
      --speed <km/h>             Sobrescreve a velocidade
      --scale <x>                Acelera o tempo (ex.: 5)
      --loop off|restart|pingpong
  gps-sim reset <id>             Devolve o GPS real a um aparelho que ficou simulado

Variáveis: GPS_SIM_ADB, GPS_SIM_OSRM_URL, GPS_SIM_NOMINATIM_URL`;

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    // `pnpm dev -- --flag` repassa um "--" solto; sem isso ele encerraria as opções.
    args: process.argv.slice(2).filter((arg) => arg !== '--'),
    allowPositionals: true,
    options: {
      port: { type: 'string' },
      host: { type: 'string' },
      scenarios: { type: 'string' },
      dev: { type: 'boolean' },
      'no-open': { type: 'boolean' },
      device: { type: 'string' },
      speed: { type: 'string' },
      scale: { type: 'string' },
      loop: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  const [command = 'serve', ...rest] = positionals;
  if (values.help || command === 'help') {
    console.log(HELP);
    return;
  }

  switch (command) {
    case 'serve':
      return serve({
        port: z.coerce.number().int().min(1).max(65_535).parse(values.port ?? '4600'),
        host: values.host ?? '127.0.0.1',
        scenariosDir: resolve(values.scenarios ?? join(PROJECT_ROOT, 'scenarios')),
        dev: values.dev ?? false,
        open: !(values['no-open'] ?? false),
      });
    case 'devices':
      return printDevices();
    case 'run': {
      const file = rest[0];
      if (!file) throw new Error('Informe o arquivo do cenário: gps-sim run cenario.json');
      return runHeadless(resolve(file), {
        device: values.device,
        speed: values.speed === undefined ? undefined : z.coerce.number().positive().parse(values.speed),
        scale: values.scale === undefined ? undefined : z.coerce.number().positive().parse(values.scale),
        loop: values.loop === undefined ? undefined : LoopModeSchema.parse(values.loop),
      });
    }
    case 'reset': {
      const id = rest[0];
      if (!id) throw new Error('Informe o aparelho: gps-sim reset <id> (veja "gps-sim devices")');
      await new SessionManager().reset(id);
      console.log(`GPS real devolvido a ${id}`);
      return;
    }
    default:
      throw new Error(`Comando desconhecido "${command}".\n\n${HELP}`);
  }
}

interface ServeOptions {
  port: number;
  host: string;
  scenariosDir: string;
  dev: boolean;
  open: boolean;
}

async function serve(options: ServeOptions): Promise<void> {
  const sessions = new SessionManager();
  const scenarios = new ScenarioStore(options.scenariosDir);

  let devMiddleware: Parameters<typeof createAppServer>[0]['devMiddleware'];
  let closeVite: (() => Promise<void>) | undefined;
  if (options.dev) {
    const { createServer: createVite } = await import('vite');
    const vite = await createVite({
      configFile: join(PROJECT_ROOT, 'vite.config.ts'),
      server: { middlewareMode: true },
      appType: 'spa',
    });
    devMiddleware = (req, res, next) => vite.middlewares(req, res, next);
    closeVite = () => vite.close();
  }

  const server = createAppServer({
    host: options.host,
    port: options.port,
    sessions,
    scenarios,
    staticDir: join(PROJECT_ROOT, 'dist', 'web'),
    devMiddleware,
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => resolveListen());
  });

  const url = `http://${options.host === '0.0.0.0' ? '127.0.0.1' : options.host}:${options.port}`;
  console.log(`gps-sim rodando em ${url}`);
  console.log(`cenários em ${options.scenariosDir}`);
  if (options.open) openBrowser(url);

  onShutdown(async () => {
    console.log('\nDevolvendo o GPS real aos aparelhos…');
    await sessions.stopAll();
    await closeVite?.();
    server.close();
  });
}

async function printDevices(): Promise<void> {
  const { devices, tools } = await listDevices();
  if (!tools.adb) console.log('adb não encontrado (instale o Android SDK platform-tools ou defina GPS_SIM_ADB).');
  if (devices.length === 0) {
    console.log('Nenhum aparelho conectado.');
    return;
  }
  for (const d of devices) {
    console.log(`${d.unavailableReason ? '✗' : '✓'} ${d.id.padEnd(24)} ${d.label}${d.unavailableReason ? ` — ${d.unavailableReason}` : ''}`);
  }
}

interface RunOptions {
  device: string | undefined;
  speed: number | undefined;
  scale: number | undefined;
  loop: z.infer<typeof LoopModeSchema> | undefined;
}

async function runHeadless(file: string, options: RunOptions): Promise<void> {
  const loaded = await readScenarioFile(file);
  const scenario = {
    ...loaded,
    motion: {
      ...loaded.motion,
      ...(options.speed !== undefined && { speedKmh: options.speed }),
      ...(options.scale !== undefined && { timeScale: options.scale }),
      ...(options.loop !== undefined && { loop: options.loop }),
    },
  };

  const deviceId = options.device ?? (await pickOnlyDevice());
  const route = await computeRoute({ waypoints: scenario.waypoints, mode: scenario.mode, profile: scenario.profile });
  console.log(`${scenario.name}: ${formatDistance(route.distanceM)} a ${scenario.motion.speedKmh} km/h em ${deviceId}`);

  const sessions = new SessionManager();
  let last = '';
  const done = new Promise<void>((resolveDone) => {
    sessions.subscribe((event) => {
      if (event.type !== 'tick') return;
      const line = describe(event.state);
      if (line !== last && process.stdout.isTTY) process.stdout.write(`\r${line.padEnd(80)}`);
      last = line;
      if (event.state.status === 'finished') resolveDone();
    });
  });

  await sessions.startRoute(deviceId, scenario, route);
  onShutdown(() => sessions.stopAll());
  await done;
  console.log('\nChegou ao destino. Devolvendo o GPS real…');
  await sessions.stopAll();
}

function describe(s: SessionState): string {
  const pct = s.totalM > 0 ? Math.round((s.traveledM / s.totalM) * 100) : 100;
  if (s.status === 'dwelling') return `parado no ponto ${s.stopIndex + 1} — falta ${formatClock(s.dwellRemainingSec)}`;
  return `${pct}%  ${formatDistance(s.traveledM)} / ${formatDistance(s.totalM)}  ${Math.round(s.speedKmh)} km/h${s.lastError ? `  erro: ${s.lastError}` : ''}`;
}

async function pickOnlyDevice(): Promise<string> {
  const ready = (await listDevices()).devices.filter((d) => !d.unavailableReason);
  const only = ready[0];
  if (ready.length === 1 && only) return only.id;
  throw new Error(
    ready.length === 0
      ? 'Nenhum aparelho pronto. Veja "gps-sim devices".'
      : `Mais de um aparelho: escolha com --device (${ready.map((d) => d.id).join(', ')})`,
  );
}

function onShutdown(cleanup: () => Promise<void>): void {
  let closing = false;
  const handler = () => {
    if (closing) process.exit(1);
    closing = true;
    void cleanup().finally(() => process.exit(0));
  };
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
}

function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => undefined).unref();
  } catch {
    // Sem navegador disponível: a URL já foi impressa.
  }
}

main().catch((error: unknown) => {
  console.error(`gps-sim: ${errorMessage(error)}`);
  process.exit(1);
});
