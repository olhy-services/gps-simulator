import { Crosshair, Maximize } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  type DeviceList,
  type LatLng,
  type Motion,
  type MotionPatch,
  type Profile,
  type Route,
  type RouteMode,
  SCENARIO_VERSION,
  type Scenario,
  ScenarioSchema,
  type ScenarioSummary,
  type Waypoint,
} from '../shared/schema';
import { api, slugify } from './api';
import { DevicePanel } from './components/DevicePanel';
import { type LivePosition, MapView } from './components/MapView';
import { MotionPanel } from './components/MotionPanel';
import { type Notice, Player } from './components/Player';
import { RoutePanel } from './components/RoutePanel';
import { ScenarioPanel } from './components/ScenarioPanel';
import { buildGpx, download } from './gpx';
import { PROFILE_SPEED_KMH } from './labels';
import { useSessions } from './useSessions';

const DEFAULT_MOTION: Motion = { speedKmh: 40, timeScale: 1, accuracyM: 8, jitterM: 0, tickMs: 250, loop: 'off' };
const DEVICE_POLL_MS = 3000;
const DEVICE_KEY = 'gps-sim:device';

interface Draft {
  name: string;
  waypoints: Waypoint[];
  mode: RouteMode;
  profile: Profile;
  motion: Motion;
}

const emptyDraft = (): Draft => ({ name: '', waypoints: [], mode: 'road', profile: 'car', motion: DEFAULT_MOTION });

/** Identidade da rota (o que exige recalcular e reiniciar a simulação). */
function routeKey(d: Pick<Draft, 'waypoints' | 'mode' | 'profile'>): string {
  return JSON.stringify([d.mode, d.profile, d.waypoints.map((w) => [w.lat, w.lng, w.dwellSec])]);
}

function toScenario(draft: Draft) {
  return ScenarioSchema.safeParse({ ...draft, version: SCENARIO_VERSION, name: draft.name.trim() || 'Sem nome' });
}

const fromScenario = (s: Scenario): Draft => ({
  name: s.name,
  waypoints: s.waypoints,
  mode: s.mode,
  profile: s.profile,
  motion: s.motion,
});

let idCounter = 0;
const newId = () => `${Date.now().toString(36)}-${(idCounter++).toString(36)}`;

function readStoredDevice(): string | null {
  try {
    return localStorage.getItem(DEVICE_KEY);
  } catch {
    return null;
  }
}

export function App() {
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [route, setRoute] = useState<{ key: string; value: Route } | null>(null);
  const [routeError, setRouteError] = useState<{ key: string; message: string } | null>(null);
  const [devices, setDevices] = useState<DeviceList | null>(null);
  const [devicesLoading, setDevicesLoading] = useState(false);
  const [chosenDeviceId, setChosenDeviceId] = useState<string | null>(readStoredDevice);
  const [saved, setSaved] = useState<ScenarioSummary[]>([]);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const [follow, setFollow] = useState(false);
  const [fitSignal, setFitSignal] = useState(0);
  const { sessions, connected } = useSessions();

  // Aparelho escolhido se ainda estiver conectado; senão, o primeiro pronto.
  const deviceList = devices?.devices ?? [];
  const device =
    deviceList.find((d) => d.id === chosenDeviceId) ??
    deviceList.find((d) => d.unavailableReason === null) ??
    deviceList[0] ??
    null;
  const deviceId = device?.id ?? null;
  const session = deviceId ? (sessions.get(deviceId) ?? null) : null;
  const deviceReady = device !== null && device.unavailableReason === null;
  const key = routeKey(draft);
  const currentRoute = route?.key === key ? route.value : null;
  const currentRouteError = routeError?.key === key ? routeError.message : null;

  const fail = useCallback((error: unknown) => {
    setNotice({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
  }, []);

  // ---- Aparelhos: varredura periódica para detectar conectar/desconectar.
  const loadDevices = useCallback(() => api.devices().then(setDevices), []);

  useEffect(() => {
    let alive = true;
    const load = () => api.devices().then((list) => alive && setDevices(list)).catch((error: unknown) => alive && fail(error));
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, DEVICE_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [fail]);

  const refreshDevices = () => {
    setDevicesLoading(true);
    loadDevices()
      .catch(fail)
      .finally(() => setDevicesLoading(false));
  };

  const selectDevice = (id: string) => {
    setChosenDeviceId(id);
    try {
      localStorage.setItem(DEVICE_KEY, id);
    } catch {
      // Sem armazenamento: só não lembra o aparelho.
    }
  };

  // Recarregou a página com uma simulação rodando: traz o cenário dela para edição
  // (ajuste de estado durante o render, só uma vez por aparelho).
  const [adoptedFor, setAdoptedFor] = useState<string | null>(null);
  if (session?.scenario && deviceId && adoptedFor !== deviceId) {
    setAdoptedFor(deviceId);
    if (draft.waypoints.length === 0) {
      setDraft(fromScenario(session.scenario));
      if (session.route) setRoute({ key: routeKey(session.scenario), value: session.route });
      setFitSignal((n) => n + 1);
    }
  }

  // ---- Cenários salvos
  const refreshSaved = useCallback(
    () =>
      api
        .scenarios()
        .then((r) => setSaved(r.scenarios))
        .catch(fail),
    [fail],
  );
  useEffect(() => {
    void refreshSaved();
  }, [refreshSaved]);

  // ---- Cálculo da rota (com espera curta para não chamar a cada arrasto)
  const { waypoints, mode, profile } = draft;
  useEffect(() => {
    if (waypoints.length < 2 || route?.key === key) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const value = await api.route({ waypoints: waypoints.map(({ lat, lng }) => ({ lat, lng })), mode, profile });
        if (!cancelled) setRoute({ key, value });
      } catch (error) {
        if (!cancelled) setRouteError({ key, message: error instanceof Error ? error.message : String(error) });
      }
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [key, waypoints, mode, profile, route?.key]);

  // ---- Edição
  const addWaypoint = useCallback((position: LatLng, label = '') => {
    setDraft((d) =>
      d.waypoints.length >= 50 ? d : { ...d, waypoints: [...d.waypoints, { id: newId(), label, dwellSec: 0, ...position }] },
    );
  }, []);

  const moveWaypoint = useCallback((id: string, position: LatLng) => {
    setDraft((d) => ({ ...d, waypoints: d.waypoints.map((w) => (w.id === id ? { ...w, ...position } : w)) }));
  }, []);

  const changeWaypoint = (id: string, patch: Partial<Pick<Waypoint, 'label' | 'dwellSec'>>) =>
    setDraft((d) => ({ ...d, waypoints: d.waypoints.map((w) => (w.id === id ? { ...w, ...patch } : w)) }));

  const removeWaypoint = (id: string) => setDraft((d) => ({ ...d, waypoints: d.waypoints.filter((w) => w.id !== id) }));

  const reverse = () => setDraft((d) => ({ ...d, waypoints: [...d.waypoints].reverse() }));

  const routeChanged = session?.scenario != null && routeKey(session.scenario) !== key;
  const liveMotion = session?.scenario != null && !routeChanged;

  const changeMotion = (patch: MotionPatch) => {
    setDraft((d) => ({ ...d, motion: { ...d.motion, ...patch } }));
    // Velocidade, ritmo etc. valem na hora para a simulação em andamento.
    if (deviceId && liveMotion) api.motion(deviceId, patch).catch(fail);
  };

  // Trocar o meio de transporte já sugere a velocidade típica dele.
  const changeProfile = (next: Profile) =>
    setDraft((d) => ({ ...d, profile: next, motion: { ...d.motion, speedKmh: PROFILE_SPEED_KMH[next] } }));

  // ---- Controle da simulação
  const act = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setNotice(null);
    try {
      await action();
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  };

  const start = () =>
    act(async () => {
      if (!deviceId || !currentRoute) return;
      const scenario = toScenario(draft);
      if (!scenario.success) throw new Error(scenario.error.issues[0]?.message ?? 'Cenário inválido');
      await api.start(deviceId, scenario.data, currentRoute);
    });

  const teleport = useCallback(
    (position: LatLng) => {
      if (!deviceId || !deviceReady) {
        setNotice({ tone: 'error', text: 'Conecte e selecione um aparelho para mudar a localização dele.' });
        return;
      }
      setBusy(true);
      setNotice(null);
      api
        .teleport(deviceId, { ...position, accuracyM: draft.motion.accuracyM })
        .catch(fail)
        .finally(() => setBusy(false));
    },
    [deviceId, deviceReady, draft.motion.accuracyM, fail],
  );

  // ---- Cenários: salvar/abrir/importar/exportar
  const scenarioResult = toScenario(draft);
  const loadScenario = (scenario: Scenario) => {
    setDraft(fromScenario(scenario));
    setFitSignal((n) => n + 1);
  };

  const save = () =>
    act(async () => {
      if (!scenarioResult.success) throw new Error('Marque pelo menos dois pontos antes de salvar.');
      const slug = slugify(scenarioResult.data.name);
      await api.saveScenario(slug, scenarioResult.data);
      await refreshSaved();
      setNotice({ tone: 'info', text: `Cenário salvo em scenarios/${slug}.json` });
    });

  const importFile = async (file: File) => {
    try {
      const raw: unknown = JSON.parse(await file.text());
      const parsed = ScenarioSchema.safeParse(raw);
      if (!parsed.success) throw new Error('Esse arquivo não é um cenário do gps-sim.');
      loadScenario(parsed.data);
      setNotice(null);
    } catch (error) {
      fail(error);
    }
  };

  // ---- Derivados de exibição
  const live = useMemo<LivePosition | null>(() => {
    if (!session?.position) return null;
    return {
      position: session.position,
      bearing: session.bearing,
      active: !session.signalLost && session.status !== 'paused',
    };
  }, [session]);

  const mapPath = currentRoute?.path ?? (routeChanged ? null : (session?.route?.path ?? null));
  const progressM = session?.route && !routeChanged ? session.traveledM : null;

  const blockedReason = !device
    ? 'Conecte um aparelho para começar.'
    : device.unavailableReason
      ? device.unavailableReason
      : draft.waypoints.length < 2
        ? 'Marque a partida e o destino para iniciar.'
        : currentRouteError
          ? 'Ajuste a rota: o caminho não pôde ser calculado.'
          : !currentRoute
            ? 'Calculando o caminho…'
            : null;

  const mapHint =
    draft.waypoints.length === 0 ? (
      'Clique no mapa para marcar a partida'
    ) : draft.waypoints.length === 1 ? (
      'Clique no mapa para marcar o destino'
    ) : !session ? (
      <>
        Arraste os pontos para ajustar · <kbd>botão direito</kbd> coloca o aparelho parado ali
      </>
    ) : null;

  return (
    <div className="app">
      <aside className="side" aria-label="Controles">
        <div className="side-scroll">
          <section className="section" aria-labelledby="app-title">
            <h1 id="app-title" className="app-title">
              Simulador de GPS
              {!connected && <small>reconectando ao servidor…</small>}
            </h1>
            <DevicePanel
              list={devices}
              loading={devicesLoading}
              device={device}
              sessions={sessions}
              onSelect={selectDevice}
              onRefresh={refreshDevices}
            />
          </section>

          <RoutePanel
            waypoints={draft.waypoints}
            mode={draft.mode}
            profile={draft.profile}
            route={currentRoute}
            routeError={currentRouteError}
            speedKmh={draft.motion.speedKmh}
            timeScale={draft.motion.timeScale}
            canTeleport={deviceReady && !busy}
            onAdd={(position, label) => {
              addWaypoint(position, label);
              // Ponto vindo da busca pode estar fora da tela: enquadra.
              setFitSignal((n) => n + 1);
            }}
            onChange={changeWaypoint}
            onRemove={removeWaypoint}
            onReverse={reverse}
            onTeleport={teleport}
            onMode={(next) => setDraft((d) => ({ ...d, mode: next }))}
            onProfile={changeProfile}
          />

          <MotionPanel motion={draft.motion} live={liveMotion} onChange={changeMotion} />

          <ScenarioPanel
            name={draft.name}
            saved={saved}
            canSave={scenarioResult.success}
            canExportGpx={scenarioResult.success && currentRoute !== null}
            onName={(name) => setDraft((d) => ({ ...d, name }))}
            onSave={() => void save()}
            onOpen={(slug) => void act(async () => loadScenario(await api.scenario(slug)))}
            onNew={() => {
              setDraft(emptyDraft());
              setRoute(null);
              setNotice(null);
            }}
            onImport={(file) => void importFile(file)}
            onExportJson={() => {
              if (!scenarioResult.success) return;
              download(
                `${slugify(scenarioResult.data.name)}.json`,
                `${JSON.stringify(scenarioResult.data, null, 2)}\n`,
                'application/json',
              );
            }}
            onExportGpx={() => {
              if (!scenarioResult.success || !currentRoute) return;
              download(
                `${slugify(scenarioResult.data.name)}.gpx`,
                buildGpx(scenarioResult.data, currentRoute),
                'application/gpx+xml',
              );
            }}
          />
        </div>

        <Player
          session={session}
          canStart={deviceReady && currentRoute !== null && scenarioResult.success}
          blockedReason={blockedReason}
          routeChanged={routeChanged}
          busy={busy}
          notice={notice}
          onDismissNotice={() => setNotice(null)}
          onStart={() => void start()}
          onPause={() => deviceId && void act(() => api.pause(deviceId))}
          onResume={() => deviceId && void act(() => api.resume(deviceId))}
          onRestart={() => deviceId && void act(() => api.restart(deviceId))}
          onStop={() => deviceId && void act(() => api.stop(deviceId))}
          onSeek={(fraction) => deviceId && void act(() => api.seek(deviceId, fraction))}
          onSignal={(lost) => deviceId && void act(() => api.signal(deviceId, lost))}
        />
      </aside>

      <main className="map-wrap" aria-label="Mapa">
        <MapView
          waypoints={draft.waypoints}
          path={mapPath}
          live={live}
          progressM={progressM}
          hint={mapHint}
          follow={follow}
          tickMs={session?.motion.tickMs ?? draft.motion.tickMs}
          fitSignal={fitSignal}
          onAdd={addWaypoint}
          onMove={moveWaypoint}
          onTeleport={teleport}
        />
        <div className="map-tools">
          <button
            type="button"
            className="btn icon"
            disabled={draft.waypoints.length === 0}
            onClick={() => setFitSignal((n) => n + 1)}
            aria-label="Enquadrar a rota"
            title="Enquadrar a rota"
          >
            <Maximize size={16} />
          </button>
          <button
            type="button"
            className="btn icon"
            aria-pressed={follow}
            disabled={!live}
            onClick={() => setFollow((f) => !f)}
            aria-label={follow ? 'Parar de seguir o aparelho' : 'Seguir o aparelho no mapa'}
            title={follow ? 'Parar de seguir o aparelho' : 'Seguir o aparelho no mapa'}
          >
            <Crosshair size={16} />
          </button>
        </div>
      </main>
    </div>
  );
}
