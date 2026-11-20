import { z } from 'zod';

import { cumulativeDistances } from '../shared/geo';
import type { LatLng, Profile, Route, RouteRequest } from '../shared/schema';
import { USER_AGENT } from './http-client';

/**
 * Rotas pelas ruas via OSRM. Padrão: servidores públicos do OpenStreetMap
 * (routing.openstreetmap.de), que têm perfis de carro, bicicleta e a pé.
 * Para usar um OSRM próprio: GPS_SIM_OSRM_URL=http://localhost:5000
 * (o perfil vai no caminho: /route/v1/{car|bike|foot}/...).
 */
const PUBLIC_OSRM = (profile: Profile) => `https://routing.openstreetmap.de/routed-${profile}/route/v1/driving`;

function routeBaseUrl(profile: Profile): string {
  const custom = process.env.GPS_SIM_OSRM_URL;
  return custom ? `${custom.replace(/\/+$/, '')}/route/v1/${profile}` : PUBLIC_OSRM(profile);
}

const OsrmResponseSchema = z.object({
  code: z.string(),
  message: z.string().optional(),
  routes: z
    .array(
      z.object({
        distance: z.number(),
        legs: z.array(z.object({ distance: z.number() })),
        geometry: z.object({ coordinates: z.array(z.tuple([z.number(), z.number()])) }),
      }),
    )
    .optional(),
});

export async function computeRoute(request: RouteRequest): Promise<Route> {
  return request.mode === 'straight' ? straightRoute(request.waypoints) : roadRoute(request);
}

function straightRoute(waypoints: readonly LatLng[]): Route {
  const stopDistancesM = cumulativeDistances(waypoints);
  return { path: [...waypoints], distanceM: stopDistancesM.at(-1) ?? 0, stopDistancesM };
}

async function roadRoute({ waypoints, profile }: RouteRequest): Promise<Route> {
  const coords = waypoints.map((w) => `${w.lng.toFixed(6)},${w.lat.toFixed(6)}`).join(';');
  const url = `${routeBaseUrl(profile)}/${coords}?overview=full&geometries=geojson&steps=false`;

  let response: Response;
  try {
    response = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new Error('Serviço de rotas fora do ar ou sem internet. Use "linha reta" ou tente de novo.');
  }
  const body: unknown = await response.json().catch(() => null);
  const parsed = OsrmResponseSchema.safeParse(body);
  if (!parsed.success) throw new Error(`Resposta inesperada do serviço de rotas (HTTP ${response.status})`);

  const route = parsed.data.routes?.[0];
  if (parsed.data.code !== 'Ok' || !route) {
    throw new Error(
      parsed.data.code === 'NoRoute'
        ? 'Não existe caminho por rua entre esses pontos'
        : `Serviço de rotas: ${parsed.data.message ?? parsed.data.code}`,
    );
  }

  const path = route.geometry.coordinates.map(([lng, lat]) => ({ lat, lng }));
  if (path.length < 2) throw new Error('Rota vazia. Afaste mais os pontos.');

  // Cada perna (leg) termina num waypoint: o acumulado das pernas marca onde estão as paradas.
  const stopDistancesM = [0];
  for (const leg of route.legs) stopDistancesM.push((stopDistancesM.at(-1) ?? 0) + leg.distance);

  return { path, distanceM: route.distance, stopDistancesM };
}
