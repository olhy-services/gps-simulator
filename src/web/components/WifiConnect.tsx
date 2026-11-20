import { Wifi } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';

import type { WifiService } from '../../shared/schema';
import { api } from '../api';

interface WifiConnectProps {
  /** Abre já expandido (ex.: nenhum aparelho conectado). */
  defaultOpen: boolean;
  /** Chamado depois de parear/conectar, para a lista de aparelhos atualizar na hora. */
  onConnected(): void;
}

type Feedback = { tone: 'error' | 'info'; text: string } | null;

function parseAddress(value: string): { host: string; port: number } | null {
  const match = /^\s*([A-Za-z0-9.-]+):(\d{1,5})\s*$/.exec(value);
  if (!match?.[1] || !match[2]) return null;
  const port = Number(match[2]);
  return port >= 1 && port <= 65_535 ? { host: match[1], port } : null;
}

/**
 * Depuração por Wi-Fi (Android 11+): primeiro parear com código (uma vez por
 * computador), depois conectar no IP:porta da tela principal. As portas mudam
 * a cada vez que a depuração é ligada.
 */
export function WifiConnect({ defaultOpen, onConnected }: WifiConnectProps) {
  const [open, setOpen] = useState(defaultOpen);
  const [services, setServices] = useState<WifiService[]>([]);
  const [pairAddress, setPairAddress] = useState('');
  const [code, setCode] = useState('');
  const [connectAddress, setConnectAddress] = useState('');
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [busy, setBusy] = useState<'pair' | 'connect' | null>(null);

  // Enquanto aberto, procura na rede celulares com a depuração por Wi-Fi ligada.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    const load = () =>
      api
        .wifiDiscover()
        .then((r) => alive && setServices(r.services))
        .catch(() => undefined);
    void load();
    const timer = setInterval(load, 3000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [open]);

  const pairing = services.filter((s) => s.kind === 'pairing');
  const connectable = services.filter((s) => s.kind === 'connect');

  async function run(kind: 'pair' | 'connect', task: () => Promise<{ message: string }>) {
    setBusy(kind);
    setFeedback(null);
    try {
      const { message } = await task();
      setFeedback({ tone: 'info', text: message });
      onConnected();
    } catch (error) {
      setFeedback({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(null);
    }
  }

  function pair(event: FormEvent) {
    event.preventDefault();
    const address = parseAddress(pairAddress);
    if (!address) {
      setFeedback({ tone: 'error', text: 'Use o formato IP:porta, ex.: 192.168.0.12:37099' });
      return;
    }
    void run('pair', () => api.wifiPair({ ...address, code: code.trim() }));
  }

  function connect(event: FormEvent) {
    event.preventDefault();
    const address = parseAddress(connectAddress);
    if (!address) {
      setFeedback({ tone: 'error', text: 'Use o formato IP:porta, ex.: 192.168.0.12:41213' });
      return;
    }
    void run('connect', () => api.wifiConnect(address));
  }

  return (
    <details open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        <span className="row" style={{ display: 'inline-flex', gap: 6 }}>
          <Wifi size={14} aria-hidden="true" /> Conectar pelo Wi-Fi
        </span>
      </summary>

      <div className="stack">
        <ol className="steps">
          <li>
            No celular: <b>Opções do desenvolvedor › Depuração por Wi-Fi</b> (mesma rede deste computador).
          </li>
          <li>
            Toque em <b>Parear dispositivo com código</b> e preencha abaixo. Só na primeira vez.
          </li>
        </ol>

        <form className="row" onSubmit={pair}>
          <input
            className="input grow mono"
            value={pairAddress}
            onChange={(e) => setPairAddress(e.target.value)}
            placeholder="IP:porta"
            aria-label="IP e porta do pareamento"
            inputMode="url"
          />
          <input
            className="input mono"
            style={{ width: 84 }}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            placeholder="código"
            aria-label="Código de pareamento (6 dígitos)"
            inputMode="numeric"
          />
          <button type="submit" className="btn" disabled={busy !== null || code.length !== 6 || !pairAddress}>
            {busy === 'pair' ? 'Pareando…' : 'Parear'}
          </button>
        </form>
        {pairing.length > 0 && (
          <Found label="Pareamento encontrado" services={pairing} onPick={(s) => setPairAddress(`${s.host}:${s.port}`)} />
        )}

        <p className="hint" style={{ marginTop: 4 }}>
          Depois, conecte com o IP:porta que aparece no topo da tela <b>Depuração por Wi-Fi</b> (é outra porta).
        </p>
        <form className="row" onSubmit={connect}>
          <input
            className="input grow mono"
            value={connectAddress}
            onChange={(e) => setConnectAddress(e.target.value)}
            placeholder="IP:porta"
            aria-label="IP e porta para conectar"
            inputMode="url"
          />
          <button type="submit" className="btn" disabled={busy !== null || !connectAddress}>
            {busy === 'connect' ? 'Conectando…' : 'Conectar'}
          </button>
        </form>
        {connectable.length > 0 && (
          <Found label="Na rede" services={connectable} onPick={(s) => setConnectAddress(`${s.host}:${s.port}`)} />
        )}

        {feedback && (
          <p className={feedback.tone === 'error' ? 'error' : 'hint'} role={feedback.tone === 'error' ? 'alert' : 'status'}>
            {feedback.text}
          </p>
        )}
      </div>
    </details>
  );
}

function Found({ label, services, onPick }: { label: string; services: WifiService[]; onPick(s: WifiService): void }) {
  return (
    <div className="row wrap" style={{ gap: 4 }}>
      <span className="hint">{label}:</span>
      {services.map((s) => (
        <button key={`${s.host}:${s.port}`} type="button" className="chip mono" onClick={() => onPick(s)} title={s.name}>
          {s.host}:{s.port}
        </button>
      ))}
    </div>
  );
}
