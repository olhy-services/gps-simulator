import { cumulativeDistances, pointAlong } from '../shared/geo';
import type { Route, Scenario } from '../shared/schema';

const escapeXml = (s: string) =>
  s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c] ?? c);

/**
 * GPX com horário em cada ponto, no formato que o Xcode usa para simular
 * localização num iPhone físico (Debug › Simulate Location). A velocidade e as
 * paradas viram intervalos de tempo entre os pontos.
 */
export function buildGpx(scenario: Scenario, route: Route): string {
  const cumulative = cumulativeDistances(route.path);
  const total = cumulative.at(-1) ?? 0;
  const scale = route.distanceM > 0 ? total / route.distanceM : 1;
  const stops = route.stopDistancesM.map((d, i) => ({
    at: Math.min(total, d * scale),
    dwell: scenario.waypoints[i]?.dwellSec ?? 0,
  }));
  const speed = scenario.motion.speedKmh / 3.6;
  const stepM = Math.max(5, speed); // ~1 ponto por segundo de movimento

  let clock = Date.UTC(2026, 0, 1, 12, 0, 0);
  const points: string[] = [];
  const add = (distance: number) => {
    const { position } = pointAlong(route.path, cumulative, distance);
    points.push(
      `  <wpt lat="${position.lat.toFixed(7)}" lon="${position.lng.toFixed(7)}"><time>${new Date(clock).toISOString()}</time></wpt>`,
    );
  };

  let traveled = 0;
  add(0);
  for (const stop of stops) {
    while (traveled + stepM < stop.at) {
      traveled += stepM;
      clock += (stepM / speed) * 1000;
      add(traveled);
    }
    if (stop.at > traveled) {
      clock += ((stop.at - traveled) / speed) * 1000;
      traveled = stop.at;
      add(traveled);
    }
    if (stop.dwell > 0) {
      clock += stop.dwell * 1000;
      add(traveled);
    }
  }

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="gps-sim" xmlns="http://www.topografix.com/GPX/1/1">',
    `  <metadata><name>${escapeXml(scenario.name)}</name></metadata>`,
    ...points,
    '</gpx>',
    '',
  ].join('\n');
}

export function download(filename: string, content: string, type: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
