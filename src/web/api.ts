import type { ZodType } from 'zod';

import {
  ApiErrorSchema,
  DeviceListSchema,
  GeocodeListSchema,
  type MotionPatch,
  OkSchema,
  type Route,
  type RouteRequest,
  RouteSchema,
  type Scenario,
  ScenarioListSchema,
  ScenarioSchema,
  SessionDetailSchema,
  type TeleportRequest,
  type WifiConnectRequest,
  WifiDiscoverSchema,
  type WifiPairRequest,
  WifiResultSchema,
} from '../shared/schema';

async function request<T>(schema: ZodType<T>, method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: method === 'GET' ? undefined : { 'Content-Type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const parsed = ApiErrorSchema.safeParse(data);
    throw new Error(parsed.success ? parsed.data.error : `Erro HTTP ${response.status}`);
  }
  return schema.parse(data);
}

const sim = (deviceId: string, action: string) => `/api/sim/${encodeURIComponent(deviceId)}/${action}`;

export const api = {
  devices: () => request(DeviceListSchema, 'GET', '/api/devices'),
  resetDevice: (id: string) => request(OkSchema, 'POST', `/api/devices/${encodeURIComponent(id)}/reset`),

  wifiDiscover: () => request(WifiDiscoverSchema, 'GET', '/api/wifi/discover'),
  wifiPair: (body: WifiPairRequest) => request(WifiResultSchema, 'POST', '/api/wifi/pair', body),
  wifiConnect: (body: WifiConnectRequest) => request(WifiResultSchema, 'POST', '/api/wifi/connect', body),
  switchToWifi: (id: string) => request(WifiResultSchema, 'POST', `/api/devices/${encodeURIComponent(id)}/wifi`),

  route: (body: RouteRequest): Promise<Route> => request(RouteSchema, 'POST', '/api/route', body),
  geocode: (q: string) => request(GeocodeListSchema, 'GET', `/api/geocode?q=${encodeURIComponent(q)}`),

  scenarios: () => request(ScenarioListSchema, 'GET', '/api/scenarios'),
  scenario: (slug: string) => request(ScenarioSchema, 'GET', `/api/scenarios/${slug}`),
  saveScenario: (slug: string, scenario: Scenario) => request(OkSchema, 'PUT', `/api/scenarios/${slug}`, scenario),
  deleteScenario: (slug: string) => request(OkSchema, 'DELETE', `/api/scenarios/${slug}`),

  start: (deviceId: string, scenario: Scenario, route: Route) =>
    request(SessionDetailSchema, 'POST', sim(deviceId, 'start'), { scenario, route }),
  teleport: (deviceId: string, body: TeleportRequest) =>
    request(SessionDetailSchema, 'POST', sim(deviceId, 'teleport'), body),
  stop: (deviceId: string) => request(OkSchema, 'POST', sim(deviceId, 'stop')),
  pause: (deviceId: string) => request(SessionDetailSchema, 'POST', sim(deviceId, 'pause')),
  resume: (deviceId: string) => request(SessionDetailSchema, 'POST', sim(deviceId, 'resume')),
  restart: (deviceId: string) => request(SessionDetailSchema, 'POST', sim(deviceId, 'restart')),
  seek: (deviceId: string, fraction: number) =>
    request(SessionDetailSchema, 'POST', sim(deviceId, 'seek'), { fraction }),
  motion: (deviceId: string, patch: MotionPatch) => request(SessionDetailSchema, 'POST', sim(deviceId, 'motion'), patch),
  signal: (deviceId: string, lost: boolean) => request(SessionDetailSchema, 'POST', sim(deviceId, 'signal'), { lost }),
};

export function slugify(name: string): string {
  const slug = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug || 'cenario';
}
