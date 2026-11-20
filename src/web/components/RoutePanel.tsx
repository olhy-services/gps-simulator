import { ArrowDownUp, LocateFixed, Search, X } from 'lucide-react';
import { type FormEvent, useState } from 'react';

import { formatDistance, formatDuration } from '../../shared/geo';
import {
  type GeocodeResult,
  type LatLng,
  type Profile,
  ProfileSchema,
  type Route,
  type RouteMode,
  type Waypoint,
} from '../../shared/schema';
import { api } from '../api';
import { PROFILE_LABEL, waypointLetter } from '../labels';

interface RoutePanelProps {
  waypoints: Waypoint[];
  mode: RouteMode;
  profile: Profile;
  route: Route | null;
  routeError: string | null;
  speedKmh: number;
  timeScale: number;
  canTeleport: boolean;
  onAdd(position: LatLng, label: string): void;
  onChange(id: string, patch: Partial<Pick<Waypoint, 'label' | 'dwellSec'>>): void;
  onRemove(id: string): void;
  onReverse(): void;
  onTeleport(position: LatLng): void;
  onMode(mode: RouteMode): void;
  onProfile(profile: Profile): void;
}

export function RoutePanel(props: RoutePanelProps) {
  const { waypoints } = props;

  return (
    <section className="section" aria-labelledby="route-title">
      <div className="section-head">
        <h2 id="route-title">Rota</h2>
        {waypoints.length >= 2 && (
          <button type="button" className="btn ghost sm" onClick={props.onReverse} title="Troca o início pelo fim">
            <ArrowDownUp size={14} /> Inverter
          </button>
        )}
      </div>

      <AddressSearch onPick={(r) => props.onAdd({ lat: r.lat, lng: r.lng }, shortLabel(r.label))} />

      {waypoints.length > 0 ? (
        <ol className="waypoints">
          {waypoints.map((wp, index) => (
            <WaypointRow
              key={wp.id}
              waypoint={wp}
              index={index}
              last={index === waypoints.length - 1}
              canTeleport={props.canTeleport}
              onChange={props.onChange}
              onRemove={props.onRemove}
              onTeleport={props.onTeleport}
            />
          ))}
        </ol>
      ) : (
        <p className="hint">Busque um endereço ou clique no mapa para marcar o ponto de partida.</p>
      )}
      {waypoints.length === 1 && <p className="hint">Agora marque o destino (ponto B).</p>}

      <div className="row wrap">
        <div className="segmented" role="group" aria-label="Tipo de caminho">
          <button type="button" aria-pressed={props.mode === 'road'} onClick={() => props.onMode('road')}>
            Pelas ruas
          </button>
          <button type="button" aria-pressed={props.mode === 'straight'} onClick={() => props.onMode('straight')}>
            Linha reta
          </button>
        </div>
        {props.mode === 'road' && (
          <select
            className="select grow"
            aria-label="Meio de transporte"
            value={props.profile}
            onChange={(e) => {
              const p = ProfileSchema.safeParse(e.target.value);
              if (p.success) props.onProfile(p.data);
            }}
          >
            {ProfileSchema.options.map((p) => (
              <option key={p} value={p}>
                {PROFILE_LABEL[p]}
              </option>
            ))}
          </select>
        )}
      </div>

      <RouteSummary {...props} />
    </section>
  );
}

function RouteSummary({ waypoints, route, routeError, speedKmh, timeScale }: RoutePanelProps) {
  if (waypoints.length < 2) return null;
  if (routeError) return <p className="error">{routeError}</p>;
  if (!route) return <p className="hint">Calculando o caminho…</p>;

  const dwell = waypoints.reduce((sum, w) => sum + w.dwellSec, 0);
  const travel = route.distanceM / (speedKmh / 3.6);
  return (
    <p className="route-summary num" aria-live="polite">
      <span>
        <b>{formatDistance(route.distanceM)}</b>
      </span>
      <span>
        <b>{formatDuration((travel + dwell) / timeScale)}</b> a {speedKmh} km/h
        {timeScale !== 1 ? ` (${timeScale}×)` : ''}
      </span>
      {dwell > 0 && <span>{formatDuration(dwell)} parado</span>}
    </p>
  );
}

interface WaypointRowProps {
  waypoint: Waypoint;
  index: number;
  last: boolean;
  canTeleport: boolean;
  onChange: RoutePanelProps['onChange'];
  onRemove: RoutePanelProps['onRemove'];
  onTeleport: RoutePanelProps['onTeleport'];
}

function WaypointRow({ waypoint: wp, index, last, canTeleport, onChange, onRemove, onTeleport }: WaypointRowProps) {
  const letter = waypointLetter(index);
  const role = index === 0 ? 'Partida' : last ? 'Destino' : `Parada ${letter}`;
  return (
    <li className="wp">
      <span className="wp-letter" aria-hidden="true">
        {letter}
      </span>
      <input
        className="input small"
        value={wp.label}
        placeholder={role}
        aria-label={`Nome do ponto ${letter}`}
        onChange={(e) => onChange(wp.id, { label: e.target.value })}
      />
      <div className="wp-actions">
        <button
          type="button"
          className="btn icon sm ghost"
          disabled={!canTeleport}
          onClick={() => onTeleport(wp)}
          aria-label={`Colocar o aparelho parado no ponto ${letter}`}
          title="Colocar o aparelho parado neste ponto"
        >
          <LocateFixed size={15} />
        </button>
        <button
          type="button"
          className="btn icon sm ghost"
          onClick={() => onRemove(wp.id)}
          aria-label={`Remover ponto ${letter}`}
          title="Remover ponto"
        >
          <X size={15} />
        </button>
      </div>
      <div className="wp-meta">
        <span className="mono num" title="Latitude, longitude">
          {wp.lat.toFixed(5)}, {wp.lng.toFixed(5)}
        </span>
        <label title={index === 0 ? 'Tempo esperando aqui antes de sair' : 'Tempo parado aqui ao chegar'}>
          {index === 0 ? 'Espera' : 'Parada'}
          <span className="unit-input small">
            <input
              className="input small"
              type="number"
              inputMode="numeric"
              min={0}
              step={5}
              value={wp.dwellSec}
              onChange={(e) => onChange(wp.id, { dwellSec: clampInt(e.target.valueAsNumber, 0, 86_400) })}
            />
            <i>s</i>
          </span>
        </label>
      </div>
    </li>
  );
}

function AddressSearch({ onPick }: { onPick(result: GeocodeResult): void }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<GeocodeResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const q = query.trim();
    if (q.length < 3) return;
    setBusy(true);
    setError(null);
    try {
      const { results: found } = await api.geocode(q);
      setResults(found);
      if (found.length === 0) setError('Nada encontrado. Tente rua + cidade.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha na busca');
      setResults(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="search" onSubmit={submit} role="search">
      <div className="row">
        <input
          className="input grow"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && setResults(null)}
          placeholder="Buscar endereço"
          aria-label="Buscar endereço para adicionar como ponto"
        />
        <button
          type="submit"
          className="btn icon"
          disabled={busy || query.trim().length < 3}
          aria-label={busy ? 'Buscando…' : 'Buscar'}
        >
          <Search size={16} />
        </button>
      </div>
      {error && (
        <p className="hint" style={{ marginTop: 6 }}>
          {error}
        </p>
      )}
      {results && results.length > 0 && (
        <ul className="results">
          {results.map((r) => (
            <li key={`${r.lat},${r.lng}`}>
              <button
                type="button"
                onClick={() => {
                  onPick(r);
                  setResults(null);
                  setQuery('');
                }}
              >
                {r.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </form>
  );
}

function shortLabel(label: string): string {
  return label.split(',').slice(0, 2).join(',').trim();
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}
