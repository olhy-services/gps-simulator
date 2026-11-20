import type { DeviceKind, LoopMode, Profile } from '../shared/schema';

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export function waypointLetter(index: number): string {
  return LETTERS[index] ?? String(index + 1);
}

export const DEVICE_KIND_LABEL: Record<DeviceKind, string> = {
  'android-emulator': 'Emulador Android',
  'android-device': 'Android físico',
  'ios-simulator': 'Simulador iOS',
};

export const PROFILE_LABEL: Record<Profile, string> = {
  car: 'Carro / moto',
  bike: 'Bicicleta',
  foot: 'A pé',
};

export const LOOP_LABEL: Record<LoopMode, string> = {
  off: 'Não repetir',
  restart: 'Recomeçar',
  pingpong: 'Ida e volta',
};

/** Velocidade sugerida ao escolher o meio de transporte. */
export const PROFILE_SPEED_KMH: Record<Profile, number> = {
  car: 40,
  bike: 15,
  foot: 5,
};
