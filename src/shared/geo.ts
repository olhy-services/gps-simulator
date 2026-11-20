import type { LatLng } from './schema';

const EARTH_RADIUS_M = 6_371_008.8;
const toRad = (deg: number) => (deg * Math.PI) / 180;
const toDeg = (rad: number) => (rad * 180) / Math.PI;

export function distanceM(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Rumo de a para b em graus (0 = norte, sentido horário). */
export function bearingDeg(a: LatLng, b: LatLng): number {
  const y = Math.sin(toRad(b.lng - a.lng)) * Math.cos(toRad(b.lat));
  const x =
    Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) -
    Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lng - a.lng));
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Distância acumulada até cada vértice: [0, d01, d01+d12, ...]. */
export function cumulativeDistances(path: readonly LatLng[]): number[] {
  const out = [0];
  for (let i = 1; i < path.length; i++) {
    const prev = path[i - 1];
    const cur = path[i];
    const acc = out[i - 1];
    if (prev === undefined || cur === undefined || acc === undefined) break;
    out.push(acc + distanceM(prev, cur));
  }
  return out;
}

export interface PathPoint {
  position: LatLng;
  /** Rumo do trecho em que o ponto está, no sentido do início para o fim. */
  bearing: number;
}

/** Ponto a `distance` metros do início do caminho (busca binária no acumulado). */
export function pointAlong(path: readonly LatLng[], cumulative: readonly number[], distance: number): PathPoint {
  const first = path[0];
  if (first === undefined) throw new Error('Caminho vazio');
  if (path.length === 1) return { position: first, bearing: 0 };

  let lo = 0;
  let hi = cumulative.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((cumulative[mid] ?? 0) <= distance) lo = mid;
    else hi = mid;
  }
  const a = path[lo];
  const b = path[hi];
  const da = cumulative[lo];
  const db = cumulative[hi];
  if (a === undefined || b === undefined || da === undefined || db === undefined) {
    return { position: first, bearing: 0 };
  }
  const span = db - da;
  const t = span > 0 ? Math.min(1, Math.max(0, (distance - da) / span)) : 0;
  return {
    position: { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t },
    bearing: bearingDeg(a, b),
  };
}

/** Desloca um ponto em metros para leste (dx) e norte (dy). */
export function offsetM(p: LatLng, dx: number, dy: number): LatLng {
  const dLat = dy / EARTH_RADIUS_M;
  const dLng = dx / (EARTH_RADIUS_M * Math.cos(toRad(p.lat)));
  return { lat: p.lat + toDeg(dLat), lng: p.lng + toDeg(dLng) };
}

/** Amostra normal padrão (Box–Muller). */
export function gaussian(random: () => number = Math.random): number {
  const u = 1 - random();
  const v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Desvio aleatório com sigma ≈ jitterM/2: ~95% das amostras ficam dentro de jitterM. */
export function jitter(p: LatLng, jitterM: number, random: () => number = Math.random): LatLng {
  if (jitterM <= 0) return p;
  const sigma = jitterM / 2;
  return offsetM(p, gaussian(random) * sigma, gaussian(random) * sigma);
}

const decimal = (n: number, digits: number) =>
  n.toLocaleString('pt-BR', { minimumFractionDigits: digits, maximumFractionDigits: digits });

/** "850 m", "6,64 km", "12,3 km". */
export function formatDistance(m: number): string {
  if (m < 1000) return `${Math.round(m)} m`;
  return `${decimal(m / 1000, m < 10_000 ? 2 : 1)} km`;
}

/** Estimativa legível: "45 s", "9 min 48 s", "24 min", "1 h 05 min". */
export function formatDuration(totalSec: number): string {
  const s = Math.max(0, Math.round(totalSec));
  if (s < 60) return `${s} s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h} h ${String(m).padStart(2, '0')} min`;
  if (m < 10 && sec > 0) return `${m} min ${sec} s`;
  return `${m} min`;
}

/** Contagem regressiva: "0:45", "12:03". */
export function formatClock(totalSec: number): string {
  const s = Math.max(0, Math.ceil(totalSec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Divide o caminho em trecho já percorrido e restante, cortando no ponto exato. */
export function splitPath(
  path: readonly LatLng[],
  cumulative: readonly number[],
  distance: number,
): { done: LatLng[]; rest: LatLng[] } {
  const cut = pointAlong(path, cumulative, distance).position;
  const done: LatLng[] = [];
  const rest: LatLng[] = [cut];
  path.forEach((p, i) => {
    if ((cumulative[i] ?? 0) < distance) done.push(p);
    else rest.push(p);
  });
  done.push(cut);
  return { done, rest };
}
