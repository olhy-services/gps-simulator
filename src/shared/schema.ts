import { z } from 'zod';

/**
 * Contratos compartilhados entre o servidor local (que fala com adb/simctl) e
 * a interface web. Tudo que atravessa a rede ou vem de arquivo passa por aqui.
 */

export const LatLngSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});
export type LatLng = z.infer<typeof LatLngSchema>;

export const WaypointSchema = LatLngSchema.extend({
  id: z.string().min(1).max(64),
  label: z.string().max(200),
  /** Tempo parado ao chegar no ponto (no primeiro ponto: antes de sair). */
  dwellSec: z.number().int().min(0).max(86_400),
});
export type Waypoint = z.infer<typeof WaypointSchema>;

/** `road` segue as ruas (OSRM); `straight` liga os pontos em linha reta. */
export const RouteModeSchema = z.enum(['road', 'straight']);
export type RouteMode = z.infer<typeof RouteModeSchema>;

export const ProfileSchema = z.enum(['car', 'bike', 'foot']);
export type Profile = z.infer<typeof ProfileSchema>;

/** Ao chegar no último ponto: parar, recomeçar do início ou voltar pelo mesmo caminho. */
export const LoopModeSchema = z.enum(['off', 'restart', 'pingpong']);
export type LoopMode = z.infer<typeof LoopModeSchema>;

export const MotionSchema = z.object({
  speedKmh: z.number().min(0.5).max(400),
  /** Acelera o relógio da simulação (movimento e paradas). */
  timeScale: z.number().min(0.25).max(50),
  /** Precisão horizontal informada ao aparelho, em metros. */
  accuracyM: z.number().min(1).max(500),
  /** Ruído aleatório aplicado à posição, em metros (simula GPS "tremendo"). */
  jitterM: z.number().min(0).max(200),
  /** Intervalo entre posições enviadas ao aparelho. */
  tickMs: z.number().int().min(200).max(10_000),
  loop: LoopModeSchema,
});
export type Motion = z.infer<typeof MotionSchema>;

export const MotionPatchSchema = MotionSchema.partial();
export type MotionPatch = z.infer<typeof MotionPatchSchema>;

export const SCENARIO_VERSION = 1;

export const ScenarioSchema = z.object({
  version: z.literal(SCENARIO_VERSION),
  name: z.string().trim().min(1).max(120),
  waypoints: z.array(WaypointSchema).min(2).max(50),
  mode: RouteModeSchema,
  profile: ProfileSchema,
  motion: MotionSchema,
});
export type Scenario = z.infer<typeof ScenarioSchema>;

export const ScenarioSlugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);

export const ScenarioSummarySchema = z.object({
  slug: ScenarioSlugSchema,
  name: z.string(),
  waypointCount: z.number().int(),
});
export type ScenarioSummary = z.infer<typeof ScenarioSummarySchema>;

export const ScenarioListSchema = z.object({ scenarios: z.array(ScenarioSummarySchema) });

// ---------------------------------------------------------------------------
// Rotas

export const RouteRequestSchema = z.object({
  waypoints: z.array(LatLngSchema).min(2).max(50),
  mode: RouteModeSchema,
  profile: ProfileSchema,
});
export type RouteRequest = z.infer<typeof RouteRequestSchema>;

export const RouteSchema = z.object({
  path: z.array(LatLngSchema).min(2),
  distanceM: z.number().min(0),
  /** Distância ao longo de `path` em que cada waypoint fica (mesma ordem). */
  stopDistancesM: z.array(z.number().min(0)).min(2),
});
export type Route = z.infer<typeof RouteSchema>;

// ---------------------------------------------------------------------------
// Aparelhos

export const DeviceKindSchema = z.enum(['android-emulator', 'android-device', 'ios-simulator']);
export type DeviceKind = z.infer<typeof DeviceKindSchema>;

/** Como o aparelho está ligado ao computador. */
export const ConnectionSchema = z.enum(['usb', 'wifi', 'local']);
export type Connection = z.infer<typeof ConnectionSchema>;

export const DeviceSchema = z.object({
  id: z.string(),
  kind: DeviceKindSchema,
  connection: ConnectionSchema,
  label: z.string(),
  /** null = pronto para receber posição; texto = motivo de não estar. */
  unavailableReason: z.string().nullable(),
});
export type Device = z.infer<typeof DeviceSchema>;

export const DeviceListSchema = z.object({
  devices: z.array(DeviceSchema),
  tools: z.object({ adb: z.boolean(), xcrun: z.boolean() }),
});
export type DeviceList = z.infer<typeof DeviceListSchema>;

export const DeviceIdSchema = z.string().regex(/^[\w.:-]{1,128}$/);

// ---------------------------------------------------------------------------
// adb pelo Wi-Fi

const HostSchema = z.string().trim().regex(/^[A-Za-z0-9.-]{1,253}$/, 'Endereço inválido');
const PortSchema = z.number().int().min(1).max(65_535);

export const WifiPairRequestSchema = z.object({
  host: HostSchema,
  port: PortSchema,
  code: z.string().trim().regex(/^\d{6}$/, 'O código de pareamento tem 6 dígitos'),
});
export type WifiPairRequest = z.infer<typeof WifiPairRequestSchema>;

export const WifiConnectRequestSchema = z.object({ host: HostSchema, port: PortSchema });
export type WifiConnectRequest = z.infer<typeof WifiConnectRequestSchema>;

export const WifiServiceSchema = z.object({
  name: z.string(),
  kind: z.enum(['pairing', 'connect']),
  host: z.string(),
  port: z.number().int(),
});
export type WifiService = z.infer<typeof WifiServiceSchema>;
export const WifiDiscoverSchema = z.object({ services: z.array(WifiServiceSchema) });

export const WifiResultSchema = z.object({ message: z.string() });

// ---------------------------------------------------------------------------
// Sessões de simulação

export const SessionStatusSchema = z.enum(['running', 'paused', 'dwelling', 'finished', 'fixed']);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const SessionStateSchema = z.object({
  deviceId: z.string(),
  status: SessionStatusSchema,
  position: LatLngSchema.nullable(),
  bearing: z.number(),
  /** Velocidade que o aparelho percebe (já multiplicada pela aceleração). */
  speedKmh: z.number(),
  traveledM: z.number(),
  totalM: z.number(),
  /** 1 = indo (A → B), -1 = voltando (modo ida e volta). */
  direction: z.union([z.literal(1), z.literal(-1)]),
  lap: z.number().int(),
  /** Índice do waypoint onde está parado, ou o próximo a alcançar. */
  stopIndex: z.number().int(),
  dwellRemainingSec: z.number(),
  signalLost: z.boolean(),
  motion: MotionSchema,
  pushCount: z.number().int(),
  lastError: z.string().nullable(),
});
export type SessionState = z.infer<typeof SessionStateSchema>;

export const SessionDetailSchema = SessionStateSchema.extend({
  scenario: ScenarioSchema.nullable(),
  route: RouteSchema.nullable(),
});
export type SessionDetail = z.infer<typeof SessionDetailSchema>;

export const SessionListSchema = z.object({ sessions: z.array(SessionDetailSchema) });

export const StartRequestSchema = z.object({ scenario: ScenarioSchema, route: RouteSchema });
export type StartRequest = z.infer<typeof StartRequestSchema>;

export const SeekRequestSchema = z.object({ fraction: z.number().min(0).max(1) });
export const SignalRequestSchema = z.object({ lost: z.boolean() });
export const TeleportRequestSchema = LatLngSchema.extend({ accuracyM: z.number().min(1).max(500) });
export type TeleportRequest = z.infer<typeof TeleportRequestSchema>;

// ---------------------------------------------------------------------------
// Busca de endereço

export const GeocodeResultSchema = z.object({
  label: z.string(),
  lat: z.number(),
  lng: z.number(),
});
export type GeocodeResult = z.infer<typeof GeocodeResultSchema>;
export const GeocodeListSchema = z.object({ results: z.array(GeocodeResultSchema) });

// ---------------------------------------------------------------------------

export const ApiErrorSchema = z.object({ error: z.string() });
export const OkSchema = z.object({ ok: z.literal(true) });
