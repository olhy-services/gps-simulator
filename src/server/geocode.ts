import { z } from 'zod';

import type { GeocodeResult } from '../shared/schema';
import { USER_AGENT } from './http-client';

/**
 * Busca de endereço via Nominatim (OpenStreetMap). A política de uso pede no
 * máximo 1 requisição por segundo; as chamadas são enfileiradas aqui.
 * Para usar outra instância: GPS_SIM_NOMINATIM_URL.
 */
const BASE = (process.env.GPS_SIM_NOMINATIM_URL ?? 'https://nominatim.openstreetmap.org').replace(/\/+$/, '');
const MIN_INTERVAL_MS = 1100;

const NominatimSchema = z.array(z.object({ display_name: z.string(), lat: z.string(), lon: z.string() }));

let queue: Promise<unknown> = Promise.resolve();
let lastCallAt = 0;

export function geocode(query: string): Promise<GeocodeResult[]> {
  const task = queue.then(async () => {
    const wait = lastCallAt + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastCallAt = Date.now();
    return search(query);
  });
  queue = task.catch(() => undefined);
  return task;
}

async function search(query: string): Promise<GeocodeResult[]> {
  const url = `${BASE}/search?format=jsonv2&limit=6&q=${encodeURIComponent(query)}`;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'pt-BR,pt,en' },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error('Busca de endereço indisponível. Clique direto no mapa.');
  }
  const body: unknown = await response.json().catch(() => null);
  const parsed = NominatimSchema.safeParse(body);
  if (!parsed.success) throw new Error(`Busca de endereço falhou (HTTP ${response.status})`);
  return parsed.data
    .map((r) => ({ label: r.display_name, lat: Number(r.lat), lng: Number(r.lon) }))
    .filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lng));
}
