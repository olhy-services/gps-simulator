import type { Device, LatLng } from '../../shared/schema';

export interface Fix {
  position: LatLng;
  accuracyM: number;
  /** Graus, 0 = norte. */
  bearing: number;
  speedMs: number;
  altitudeM: number;
}

/** Ponte entre a simulação e um aparelho concreto. */
export interface LocationDriver {
  readonly device: Device;
  /** Deixa o aparelho pronto para receber posições (ex.: cria provedores de teste). */
  prepare(): Promise<void>;
  push(fix: Fix): Promise<void>;
  /** Devolve o GPS real ao aparelho. Deve ser seguro chamar mais de uma vez. */
  release(): Promise<void>;
}
