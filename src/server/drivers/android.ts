import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { Device } from '../../shared/schema';
import { CommandError, isMissingBinary, run } from '../exec';
import type { Fix, LocationDriver } from './types';

/** `cmd location providers ... test-provider` existe a partir do Android 12. */
const MIN_SDK_FOR_SHELL_MOCK = 31;
const TEST_PROVIDERS = ['gps', 'network', 'fused'] as const;
const KNOTS_PER_MS = 1.943_844;

function resolveAdb(): string {
  const fromEnv = process.env.GPS_SIM_ADB;
  if (fromEnv) return fromEnv;
  const roots = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    join(homedir(), 'Android', 'Sdk'),
    join(homedir(), 'Library', 'Android', 'sdk'),
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Android', 'Sdk') : undefined,
  ];
  for (const root of roots) {
    if (!root) continue;
    const bin = join(root, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb');
    if (existsSync(bin)) return bin;
  }
  return 'adb';
}

const ADB = resolveAdb();

const adb = (serial: string, args: readonly string[], timeoutMs?: number) =>
  run(ADB, ['-s', serial, ...args], timeoutMs);

/** Roda um comando no shell do aparelho. Os valores vêm sempre formatados por nós (números). */
const adbShell = (serial: string, command: string, timeoutMs?: number) =>
  adb(serial, ['shell', command], timeoutMs);

const coord = (n: number) => n.toFixed(7);

/** `192.168.0.10:5555` (adb tcpip) ou `adb-XXXX._adb-tls-connect._tcp` (depuração por Wi-Fi). */
function isWifiSerial(serial: string): boolean {
  return /^[\d.]+:\d+$/.test(serial) || serial.includes('._adb-tls-connect.');
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Pareamento da "Depuração por Wi-Fi" (Android 11+): IP:porta e código mostrados no celular. */
export async function adbPair(host: string, port: number, code: string): Promise<string> {
  const { stdout } = await run(ADB, ['pair', `${host}:${port}`, code], 20_000).catch((error: unknown) => {
    throw new Error(`Não pareou: ${error instanceof Error ? error.message : String(error)}`);
  });
  if (!/successfully paired/i.test(stdout)) throw new Error(`Não pareou: ${stdout.trim() || 'sem resposta'}`);
  return 'Pareado. Agora conecte usando o IP e a porta da tela principal de Depuração por Wi-Fi.';
}

export async function adbConnect(host: string, port: number): Promise<string> {
  const { stdout } = await run(ADB, ['connect', `${host}:${port}`], 15_000);
  const out = stdout.trim();
  // `adb connect` sai com 0 mesmo quando falha; o resultado está no texto.
  if (/failed|cannot|unable|refused|no route/i.test(out) || !/connected to/i.test(out)) {
    throw new Error(
      `Não conectou em ${host}:${port}. Confira se o celular está na mesma rede e se a porta é a da tela ` +
        `principal (não a do pareamento). Resposta do adb: ${out || 'vazia'}`,
    );
  }
  return `Conectado em ${host}:${port}.`;
}

/** Com o cabo ligado: ativa o adb pela rede na porta 5555 e conecta pelo IP do Wi-Fi do celular. */
export async function switchToWifi(serial: string): Promise<string> {
  const { stdout } = await adbShell(serial, 'ip -f inet addr show wlan0');
  const ip = /inet (\d+\.\d+\.\d+\.\d+)/.exec(stdout)?.[1];
  if (!ip) throw new Error('O celular não está conectado a uma rede Wi-Fi.');
  await adb(serial, ['tcpip', '5555']);
  // O adbd reinicia em modo rede; dá um tempo antes de conectar.
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    await sleep(1200);
    try {
      await adbConnect(ip, 5555);
      return `Conectado pelo Wi-Fi em ${ip}:5555. Pode tirar o cabo.`;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Não conectou pelo Wi-Fi');
}

/** Serviços anunciados na rede pela "Depuração por Wi-Fi" (mDNS). */
export async function discoverWifi(): Promise<{ name: string; kind: 'pairing' | 'connect'; host: string; port: number }[]> {
  const { stdout } = await run(ADB, ['mdns', 'services']).catch(() => ({ stdout: '' }));
  const out: { name: string; kind: 'pairing' | 'connect'; host: string; port: number }[] = [];
  for (const line of stdout.split('\n')) {
    const match = /^(\S+)\s+_adb-tls-(pairing|connect)\._tcp\.?\s+([\d.]+):(\d+)/.exec(line.trim());
    if (!match) continue;
    const [, name, kind, host, port] = match;
    if (!name || !host || !port || (kind !== 'pairing' && kind !== 'connect')) continue;
    out.push({ name, kind, host, port: Number(port) });
  }
  return out;
}

export interface AdbListing {
  available: boolean;
  devices: Device[];
}

export async function listAndroidDevices(): Promise<AdbListing> {
  let stdout: string;
  try {
    ({ stdout } = await run(ADB, ['devices', '-l']));
  } catch (error) {
    if (isMissingBinary(error)) return { available: false, devices: [] };
    throw error;
  }

  const lines = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('List of devices') && !line.startsWith('*'));

  const devices = await Promise.all(
    lines.map(async (line): Promise<Device | null> => {
      const [serial, state, ...rest] = line.split(/\s+/);
      if (!serial || !state) return null;
      const model = rest.find((token) => token.startsWith('model:'))?.slice('model:'.length).replaceAll('_', ' ');
      const emulator = serial.startsWith('emulator-');
      const connection = emulator ? 'local' : isWifiSerial(serial) ? 'wifi' : 'usb';
      const name = model ?? serial;
      const label = emulator ? `Emulador ${name}` : connection === 'wifi' ? `${name} (Wi-Fi)` : name;
      const kind = emulator ? 'android-emulator' : 'android-device';

      if (state === 'unauthorized') {
        return { id: serial, kind, connection, label, unavailableReason: 'Autorize a depuração USB no aparelho' };
      }
      if (state !== 'device') {
        return { id: serial, kind, connection, label, unavailableReason: `Estado do adb: ${state}` };
      }
      if (emulator) return { id: serial, kind, connection, label, unavailableReason: null };

      try {
        const { stdout: sdkOut } = await adbShell(serial, 'getprop ro.build.version.sdk', 5_000);
        const sdk = Number.parseInt(sdkOut.trim(), 10);
        if (!Number.isFinite(sdk) || sdk < MIN_SDK_FOR_SHELL_MOCK) {
          return { id: serial, kind, connection, label, unavailableReason: 'Precisa de Android 12 ou mais novo' };
        }
      } catch {
        return { id: serial, kind, connection, label, unavailableReason: 'Não respondeu ao adb' };
      }
      return { id: serial, kind, connection, label, unavailableReason: null };
    }),
  );

  return { available: true, devices: devices.filter((d) => d !== null) };
}

/**
 * Emulador: `adb emu geo fix` alimenta o GNSS emulado. Para o sistema é um GPS
 * de verdade (a posição não vem marcada como "mock").
 */
export class AndroidEmulatorDriver implements LocationDriver {
  private sendsVelocity = true;

  constructor(readonly device: Device) {}

  async prepare(): Promise<void> {}

  async push(fix: Fix): Promise<void> {
    const base = ['emu', 'geo', 'fix', coord(fix.position.lng), coord(fix.position.lat), fix.altitudeM.toFixed(1), '12'];
    if (this.sendsVelocity) {
      const out = await adb(this.device.id, [...base, (fix.speedMs * KNOTS_PER_MS).toFixed(2)]);
      if (!/\bKO\b/.test(out.stdout)) return;
      // Emuladores antigos não aceitam o argumento de velocidade.
      this.sendsVelocity = false;
    }
    const out = await adb(this.device.id, base);
    if (/\bKO\b/.test(out.stdout)) throw new CommandError(out.stdout.trim(), null);
  }

  async release(): Promise<void> {}
}

/**
 * Uma sessão `adb shell` aberta para mandar comandos em sequência. Abrir um
 * `adb shell` por posição custa ~100 ms; pela mesma conexão são poucos ms, o
 * que permite várias posições por segundo (movimento fluido).
 */
class PersistentShell {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  private seq = 0;
  private pending: { marker: string; resolve: (out: string) => void; reject: (e: Error) => void } | null = null;

  constructor(private readonly serial: string) {}

  private ensure(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child;
    const child = spawn(ADB, ['-s', this.serial, 'shell'], { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    const onData = (chunk: string) => {
      this.buffer += chunk;
      this.flush();
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const fail = (message: string) => {
      this.child = null;
      this.buffer = '';
      this.pending?.reject(new Error(message));
      this.pending = null;
    };
    child.on('exit', () => fail('Aparelho desconectado do adb (cabo ou Wi-Fi caiu?)'));
    child.on('error', (error) => fail(error.message));
    // Escrever num shell que já morreu gera EPIPE: sem este handler o processo inteiro cai.
    child.stdin.on('error', () => fail('Aparelho desconectado do adb (cabo ou Wi-Fi caiu?)'));
    this.child = child;
    return child;
  }

  private flush(): void {
    const pending = this.pending;
    if (!pending) return;
    const match = new RegExp(`${pending.marker} (\\d+)`).exec(this.buffer);
    if (!match) return;
    const output = this.buffer.slice(0, match.index);
    this.buffer = this.buffer.slice(match.index + match[0].length).replace(/^\r?\n/, '');
    this.pending = null;
    if (match[1] === '0') pending.resolve(output);
    else pending.reject(new CommandError(output.trim().split('\n').slice(0, 3).join(' ') || `código ${match[1]}`, null));
  }

  /** Executa um comando por vez (quem chama já evita sobreposição). */
  exec(command: string, timeoutMs = 5_000): Promise<string> {
    if (this.pending) return Promise.reject(new Error('Comando anterior ainda em andamento'));
    const child = this.ensure();
    this.seq += 1;
    const marker = `__GPSSIM_${this.seq}__`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.close();
        reject(new Error('Aparelho não respondeu a tempo'));
      }, timeoutMs);
      this.pending = {
        marker,
        resolve: (out) => {
          clearTimeout(timer);
          resolve(out);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      if (child.stdin.writable) {
        child.stdin.write(`{ ${command} ; } 2>&1; echo ${marker} $?\n`);
        return;
      }
      // Shell já morreu: descarta e deixa o próximo envio abrir outro.
      this.close();
      clearTimeout(timer);
      reject(new Error('Aparelho desconectado do adb (cabo ou Wi-Fi caiu?)'));
    });
  }

  close(): void {
    const child = this.child;
    this.child = null;
    this.pending = null;
    this.buffer = '';
    if (child) {
      child.stdin.end('exit\n');
      child.kill();
    }
  }
}

/**
 * Aparelho físico (Android 12+): o shell do adb vira "app de local fictício"
 * e cria provedores de teste para gps, network e fused. Nenhum app precisa ser
 * instalado. Todo app do aparelho passa a receber a posição simulada.
 */
export class AndroidDeviceDriver implements LocationDriver {
  private providers: string[] = [];
  private readonly shell: PersistentShell;

  constructor(readonly device: Device) {
    this.shell = new PersistentShell(device.id);
  }

  async prepare(): Promise<void> {
    const serial = this.device.id;
    await adbShell(serial, 'appops set com.android.shell android:mock_location allow');

    const { stdout } = await adbShell(serial, 'cmd location is-location-enabled');
    if (stdout.trim() !== 'true') await adbShell(serial, 'cmd location set-location-enabled true');

    const ready: string[] = [];
    const failures: string[] = [];
    for (const provider of TEST_PROVIDERS) {
      try {
        // Sobra de uma sessão que caiu sem limpar: remove antes de recriar.
        await adbShell(serial, `cmd location providers remove-test-provider ${provider}`).catch(() => undefined);
        await adbShell(
          serial,
          `cmd location providers add-test-provider ${provider} --supportsAltitude --supportsSpeed --supportsBearing && ` +
            `cmd location providers set-test-provider-enabled ${provider} true`,
        );
        ready.push(provider);
      } catch (error) {
        failures.push(`${provider}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (!ready.includes('gps')) {
      throw new Error(`Não foi possível criar o provedor de teste "gps". ${failures.join(' | ')}`);
    }
    this.providers = ready;
  }

  async push(fix: Fix): Promise<void> {
    const location = `${coord(fix.position.lat)},${coord(fix.position.lng)}`;
    const accuracy = fix.accuracyM.toFixed(1);
    const command = this.providers
      .map((p) => `cmd location providers set-test-provider-location ${p} --location ${location} --accuracy ${accuracy}`)
      .join(' && ');
    await this.shell.exec(command);
  }

  async release(): Promise<void> {
    this.shell.close();
    const serial = this.device.id;
    const command = TEST_PROVIDERS.map((p) => `cmd location providers remove-test-provider ${p} 2>/dev/null`).join('; ');
    await adbShell(serial, `${command}; appops set com.android.shell android:mock_location default`).catch(
      () => undefined,
    );
    this.providers = [];
  }
}
