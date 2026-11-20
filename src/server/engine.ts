import { cumulativeDistances, jitter, pointAlong } from '../shared/geo';
import type {
  LatLng,
  MotionPatch,
  Route,
  Scenario,
  SessionDetail,
  SessionState,
  SessionStatus,
} from '../shared/schema';
import type { Fix, LocationDriver } from './drivers';
import { errorMessage } from './exec';

type Direction = 1 | -1;

export interface SimulationEvents {
  onTick(state: SessionState): void;
}

const DEFAULT_ALTITUDE_M = 0;

/**
 * Uma simulação por aparelho. O relógio roda no servidor (não no navegador),
 * então aba em segundo plano ou fechada não atrasa a posição.
 *
 * Modelo: a posição é uma distância percorrida ao longo de `route.path`. Cada
 * waypoint é um "ponto de controle" nessa distância; ao alcançá-lo, a simulação
 * para pelo `dwellSec` dele. No fim do caminho aplica o modo de repetição.
 */
export class Simulation {
  private status: SessionStatus;
  private traveled = 0;
  private direction: Direction = 1;
  private lap = 1;
  /** Posição (em `order`) do próximo waypoint a alcançar. */
  private cursor = 1;
  private dwellRemaining = 0;
  private signalLost = false;
  private position: LatLng | null = null;
  private bearing = 0;
  private pushCount = 0;
  private lastError: string | null = null;
  private inFlight = false;
  private timer: NodeJS.Timeout | null = null;
  private lastTickAt = 0;
  private resumeTo: 'running' | 'dwelling' = 'running';
  private fixedMotion: Scenario['motion'] | null = null;

  private readonly cumulative: number[];
  private readonly total: number;
  private readonly stopDistances: number[];

  private constructor(
    private readonly driver: LocationDriver,
    private scenario: Scenario | null,
    private readonly route: Route | null,
    private readonly events: SimulationEvents,
    fixed: LatLng | null,
  ) {
    this.cumulative = route ? cumulativeDistances(route.path) : [0];
    this.total = this.cumulative.at(-1) ?? 0;
    // A distância informada pela rota pode diferir um pouco da calculada aqui;
    // os pontos de controle são reescalados para o caminho real.
    const scale = route && route.distanceM > 0 ? this.total / route.distanceM : 1;
    this.stopDistances = route ? route.stopDistancesM.map((d) => Math.min(this.total, d * scale)) : [0];

    if (fixed) {
      this.status = 'fixed';
      this.position = fixed;
      return;
    }
    this.status = 'running';
    const firstDwell = scenario?.waypoints[0]?.dwellSec ?? 0;
    if (firstDwell > 0) {
      this.status = 'dwelling';
      this.dwellRemaining = firstDwell;
      this.cursor = 0;
    }
    this.updatePosition();
  }

  static route(driver: LocationDriver, scenario: Scenario, route: Route, events: SimulationEvents): Simulation {
    if (route.stopDistancesM.length !== scenario.waypoints.length) {
      throw new Error('A rota não corresponde aos pontos do cenário. Recalcule a rota.');
    }
    return new Simulation(driver, scenario, route, events, null);
  }

  /** Posição parada num ponto (sem rota). */
  static fixed(
    driver: LocationDriver,
    position: LatLng,
    motion: Scenario['motion'],
    events: SimulationEvents,
  ): Simulation {
    const sim = new Simulation(driver, null, null, events, position);
    sim.fixedMotion = motion;
    return sim;
  }

  get deviceId(): string {
    return this.driver.device.id;
  }

  private get motion(): Scenario['motion'] {
    const motion = this.scenario?.motion ?? this.fixedMotion;
    if (!motion) throw new Error('Simulação sem parâmetros de movimento');
    return motion;
  }

  start(): void {
    this.lastTickAt = performance.now();
    this.schedule();
    void this.push();
  }

  private schedule(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => this.tick(), this.motion.tickMs);
  }

  /** Para o relógio sem devolver o GPS real (o aparelho vai receber outra simulação). */
  halt(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Para o relógio e devolve o GPS real ao aparelho. */
  async stop(): Promise<void> {
    this.halt();
    await this.driver.release();
  }

  pause(): void {
    if (this.status === 'running' || this.status === 'dwelling') {
      this.resumeTo = this.status;
      this.status = 'paused';
      this.emit();
    }
  }

  resume(): void {
    if (this.status !== 'paused') return;
    this.status = this.resumeTo;
    this.lastTickAt = performance.now();
    this.emit();
  }

  /** Recomeça do início com o mesmo cenário. */
  restart(): void {
    if (!this.route) return;
    this.direction = 1;
    this.lap = 1;
    this.seek(0);
    const firstDwell = this.scenario?.waypoints[0]?.dwellSec ?? 0;
    if (firstDwell > 0) {
      this.status = 'dwelling';
      this.dwellRemaining = firstDwell;
      this.cursor = 0;
    } else {
      this.status = 'running';
    }
    this.lastTickAt = performance.now();
    this.emit();
  }

  seek(fraction: number): void {
    if (!this.route) return;
    this.traveled = Math.min(this.total, Math.max(0, fraction * this.total));
    const order = this.order();
    const ahead = order.findIndex((stop) => {
      const d = this.stopDistances[stop] ?? 0;
      return this.direction === 1 ? d > this.traveled : d < this.traveled;
    });
    this.cursor = ahead === -1 ? order.length : ahead;
    this.dwellRemaining = 0;
    if (this.status === 'dwelling' || this.status === 'finished') this.status = 'paused';
    this.resumeTo = 'running';
    this.updatePosition();
    this.emit();
    void this.push();
  }

  setMotion(patch: MotionPatch): void {
    const tickChanged = patch.tickMs !== undefined && patch.tickMs !== this.motion.tickMs;
    const next = { ...this.motion, ...patch };
    if (this.scenario) this.scenario = { ...this.scenario, motion: next };
    else this.fixedMotion = next;
    if (tickChanged && this.timer) this.schedule();
    this.emit();
  }

  setSignalLost(lost: boolean): void {
    this.signalLost = lost;
    this.emit();
    if (!lost) void this.push();
  }

  /** Ordem em que os waypoints são visitados no sentido atual. */
  private order(): number[] {
    const n = this.stopDistances.length;
    const forward = Array.from({ length: n }, (_, i) => i);
    return this.direction === 1 ? forward : forward.reverse();
  }

  private tick(): void {
    const now = performance.now();
    const elapsed = (now - this.lastTickAt) / 1000;
    this.lastTickAt = now;
    this.step(elapsed * this.motion.timeScale);
    void this.push();
  }

  /** Avança o relógio da simulação em `seconds` (já acelerados). Público para testes. */
  step(seconds: number): void {
    if (this.status === 'running' || this.status === 'dwelling') this.advance(seconds);
    this.updatePosition();
    this.emit();
  }

  private advance(seconds: number): void {
    const speedMs = this.motion.speedKmh / 3.6;
    const order = this.order();
    let budget = seconds;
    // Guarda contra laço infinito em rota de comprimento zero com repetição.
    let guard = 1000;

    while (budget > 1e-9 && guard-- > 0) {
      if (this.status === 'dwelling') {
        const used = Math.min(budget, this.dwellRemaining);
        this.dwellRemaining -= used;
        budget -= used;
        if (this.dwellRemaining > 1e-9) return;
        this.dwellRemaining = 0;
        this.status = 'running';
        this.cursor += 1;
        if (this.cursor >= order.length && !this.endOfPass()) return;
        continue;
      }

      if (this.status !== 'running') return;
      const stop = order[this.cursor];
      if (stop === undefined) {
        if (!this.endOfPass()) return;
        continue;
      }
      const target = this.stopDistances[stop] ?? 0;
      const gap = Math.abs(target - this.traveled);
      const reach = speedMs * budget;

      if (reach < gap) {
        this.traveled += this.direction * reach;
        return;
      }

      this.traveled = target;
      budget -= speedMs > 0 ? gap / speedMs : budget;
      const dwell = this.scenario?.waypoints[stop]?.dwellSec ?? 0;
      if (dwell > 0) {
        this.status = 'dwelling';
        this.dwellRemaining = dwell;
        continue;
      }
      this.cursor += 1;
      if (this.cursor >= order.length && !this.endOfPass()) return;
    }
  }

  /** Chegou ao fim do caminho. Retorna true se a simulação continua andando. */
  private endOfPass(): boolean {
    switch (this.motion.loop) {
      case 'off':
        this.status = 'finished';
        return false;
      case 'restart': {
        this.traveled = 0;
        this.lap += 1;
        const firstDwell = this.scenario?.waypoints[0]?.dwellSec ?? 0;
        if (firstDwell > 0) {
          this.status = 'dwelling';
          this.dwellRemaining = firstDwell;
          this.cursor = 0;
          return true;
        }
        this.cursor = 1;
        this.status = 'running';
        return this.total > 0;
      }
      case 'pingpong':
        this.direction = this.direction === 1 ? -1 : 1;
        break;
    }
    this.lap += 1;
    this.cursor = 1;
    this.status = 'running';
    return this.total > 0;
  }

  private updatePosition(): void {
    if (!this.route) return;
    const point = pointAlong(this.route.path, this.cumulative, this.traveled);
    this.position = point.position;
    this.bearing = this.direction === 1 ? point.bearing : (point.bearing + 180) % 360;
  }

  private currentSpeedMs(): number {
    return this.status === 'running' ? (this.motion.speedKmh / 3.6) * this.motion.timeScale : 0;
  }

  private async push(): Promise<void> {
    if (this.signalLost || this.inFlight || !this.position) return;
    // Aparelho lento (ex.: adb via Wi-Fi): pula o tick em vez de enfileirar posições velhas.
    this.inFlight = true;
    const fix: Fix = {
      position: jitter(this.position, this.motion.jitterM),
      accuracyM: this.motion.accuracyM,
      bearing: this.bearing,
      speedMs: this.currentSpeedMs(),
      altitudeM: DEFAULT_ALTITUDE_M,
    };
    try {
      await this.driver.push(fix);
      this.pushCount += 1;
      this.lastError = null;
    } catch (error) {
      this.lastError = errorMessage(error);
    } finally {
      this.inFlight = false;
    }
  }

  private emit(): void {
    this.events.onTick(this.state());
  }

  state(): SessionState {
    const order = this.order();
    const stop = this.status === 'dwelling' ? order[this.cursor] : order[Math.min(this.cursor, order.length - 1)];
    return {
      deviceId: this.deviceId,
      status: this.status,
      position: this.position,
      bearing: this.bearing,
      speedKmh: this.currentSpeedMs() * 3.6,
      traveledM: this.traveled,
      totalM: this.total,
      direction: this.direction,
      lap: this.lap,
      stopIndex: stop ?? 0,
      dwellRemainingSec: this.dwellRemaining / this.motion.timeScale,
      signalLost: this.signalLost,
      motion: this.motion,
      pushCount: this.pushCount,
      lastError: this.lastError,
    };
  }

  detail(): SessionDetail {
    return { ...this.state(), scenario: this.scenario, route: this.route };
  }
}
