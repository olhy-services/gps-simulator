import type { LatLng, Motion, Route, Scenario, SessionDetail, SessionState } from '../shared/schema';
import { createDriver, findReadyDevice, type LocationDriver } from './drivers';
import { Simulation } from './engine';

export type SessionEvent =
  | { type: 'tick'; state: SessionState }
  | { type: 'sessions'; sessions: SessionDetail[] };

/** Uma simulação ativa por aparelho; vários aparelhos podem rodar ao mesmo tempo. */
export class SessionManager {
  private readonly sessions = new Map<string, Simulation>();
  private readonly drivers = new Map<string, LocationDriver>();
  private readonly listeners = new Set<(event: SessionEvent) => void>();

  subscribe(listener: (event: SessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  list(): SessionDetail[] {
    return [...this.sessions.values()].map((s) => s.detail());
  }

  get(deviceId: string): Simulation {
    const sim = this.sessions.get(deviceId);
    if (!sim) throw new NotFoundError(`Nenhuma simulação ativa no aparelho "${deviceId}"`);
    return sim;
  }

  async startRoute(deviceId: string, scenario: Scenario, route: Route): Promise<SessionDetail> {
    const driver = await this.driverFor(deviceId);
    return this.replace(deviceId, Simulation.route(driver, scenario, route, this.events()));
  }

  async teleport(deviceId: string, position: LatLng, motion: Motion): Promise<SessionDetail> {
    const driver = await this.driverFor(deviceId);
    return this.replace(deviceId, Simulation.fixed(driver, position, motion, this.events()));
  }

  /** Para a simulação e devolve o GPS real ao aparelho. */
  async stop(deviceId: string): Promise<void> {
    const sim = this.sessions.get(deviceId);
    this.sessions.delete(deviceId);
    this.drivers.delete(deviceId);
    if (sim) await sim.stop();
    this.broadcastSessions();
  }

  /** Limpa um aparelho que ficou com GPS simulado (ex.: processo morto no meio). */
  async reset(deviceId: string): Promise<void> {
    if (this.sessions.has(deviceId)) {
      await this.stop(deviceId);
      return;
    }
    const device = await findReadyDevice(deviceId);
    await createDriver(device).release();
  }

  async stopAll(): Promise<void> {
    await Promise.allSettled([...this.sessions.keys()].map((id) => this.stop(id)));
  }

  private async driverFor(deviceId: string): Promise<LocationDriver> {
    const existing = this.drivers.get(deviceId);
    if (existing) return existing;
    const device = await findReadyDevice(deviceId);
    const driver = createDriver(device);
    await driver.prepare();
    this.drivers.set(deviceId, driver);
    return driver;
  }

  /** Troca a simulação do aparelho sem soltar o driver (evita recriar provedores). */
  private replace(deviceId: string, next: Simulation): SessionDetail {
    const previous = this.sessions.get(deviceId);
    if (previous) previous.halt();
    this.sessions.set(deviceId, next);
    next.start();
    this.broadcastSessions();
    return next.detail();
  }

  private events() {
    return { onTick: (state: SessionState) => this.broadcast({ type: 'tick', state }) };
  }

  broadcastSessions(): void {
    this.broadcast({ type: 'sessions', sessions: this.list() });
  }

  private broadcast(event: SessionEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

