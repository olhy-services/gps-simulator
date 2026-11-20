import { RefreshCw, Wifi } from 'lucide-react';
import { useState } from 'react';

import type { Device, DeviceList, SessionDetail } from '../../shared/schema';
import { api } from '../api';
import { DEVICE_KIND_LABEL } from '../labels';
import { WifiConnect } from './WifiConnect';

interface DevicePanelProps {
  list: DeviceList | null;
  loading: boolean;
  device: Device | null;
  sessions: Map<string, SessionDetail>;
  onSelect(id: string): void;
  onRefresh(): void;
}

const CONNECTION_LABEL = { usb: 'USB', wifi: 'Wi-Fi', local: '' } as const;

export function DevicePanel({ list, loading, device, sessions, onSelect, onRefresh }: DevicePanelProps) {
  const devices = list?.devices ?? [];

  if (list && devices.length === 0) {
    return (
      <div className="stack">
        <div className="status-line">
          <span className="dot" />
          <span className="grow">Nenhum aparelho conectado</span>
          <button type="button" className="btn ghost sm" onClick={onRefresh} disabled={loading}>
            <RefreshCw size={14} /> Procurar
          </button>
        </div>
        <NoDevices adb={list.tools.adb} />
        {list.tools.adb && <WifiConnect defaultOpen onConnected={onRefresh} />}
      </div>
    );
  }

  const simulating = device ? sessions.has(device.id) : false;
  const hasWifiTwin = device
    ? devices.some((d) => d.connection === 'wifi' && d.label === `${device.label} (Wi-Fi)`)
    : false;

  return (
    <div className="stack">
      <div className="row">
        <select
          className="select grow"
          aria-label="Aparelho"
          value={device?.id ?? ''}
          onChange={(e) => onSelect(e.target.value)}
          disabled={!list}
        >
          {!list && <option value="">Procurando aparelhos…</option>}
          {devices.map((d) => (
            <option key={d.id} value={d.id}>
              {d.label}
              {sessions.has(d.id) ? ' — simulando' : d.unavailableReason ? ' — indisponível' : ''}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="btn icon"
          onClick={onRefresh}
          disabled={loading}
          aria-label="Procurar aparelhos de novo"
          title="Procurar aparelhos de novo (a lista também atualiza sozinha)"
        >
          <RefreshCw size={16} />
        </button>
      </div>

      {device && (
        <div className="device-meta">
          <span className={`dot ${device.unavailableReason ? 'danger' : simulating ? 'ok' : ''}`} />
          <span>
            {device.unavailableReason ?? (simulating ? 'GPS simulado' : 'Pronto, com GPS real')}
          </span>
          <span aria-hidden="true">·</span>
          <span className="mono" title={device.id}>
            {DEVICE_KIND_LABEL[device.kind]}
            {CONNECTION_LABEL[device.connection] ? ` · ${CONNECTION_LABEL[device.connection]}` : ''}
          </span>
        </div>
      )}

      {device?.kind === 'android-device' && device.connection === 'usb' && !device.unavailableReason && !hasWifiTwin && (
        <SwitchToWifi deviceId={device.id} onDone={onRefresh} />
      )}
      {list?.tools.adb && <WifiConnect defaultOpen={false} onConnected={onRefresh} />}
    </div>
  );
}

function SwitchToWifi({ deviceId, onDone }: { deviceId: string; onDone(): void }) {
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: 'error' | 'info'; text: string } | null>(null);
  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="row">
        <button
          type="button"
          className="btn sm"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setFeedback(null);
            api
              .switchToWifi(deviceId)
              .then((r) => {
                setFeedback({ tone: 'info', text: r.message });
                onDone();
              })
              .catch((error: unknown) =>
                setFeedback({ tone: 'error', text: error instanceof Error ? error.message : String(error) }),
              )
              .finally(() => setBusy(false));
          }}
        >
          <Wifi size={14} /> {busy ? 'Passando para Wi-Fi…' : 'Passar para Wi-Fi'}
        </button>
        <span className="hint">e depois tirar o cabo</span>
      </div>
      {feedback && <p className={feedback.tone === 'error' ? 'error' : 'hint'}>{feedback.text}</p>}
    </div>
  );
}

function NoDevices({ adb }: { adb: boolean }) {
  return (
    <div className="empty-devices">
      {!adb && <p className="error">adb não encontrado. Instale o Android SDK Platform-Tools ou defina GPS_SIM_ADB.</p>}
      <span>Para usar um celular Android 12 ou mais novo:</span>
      <ol>
        <li>Ative as Opções do desenvolvedor e a Depuração USB</li>
        <li>Conecte no USB e aceite a autorização no celular, ou use o Wi-Fi abaixo</li>
      </ol>
      <span>Emuladores Android e simuladores iOS (macOS) aparecem quando estão ligados. A lista atualiza sozinha.</span>
    </div>
  );
}
