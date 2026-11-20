import { z } from 'zod';

import type { Device } from '../../shared/schema';
import { isMissingBinary, run } from '../exec';
import type { Fix, LocationDriver } from './types';

const SimctlListSchema = z.object({
  devices: z.record(
    z.string(),
    z.array(z.object({ udid: z.string(), name: z.string(), state: z.string() })),
  ),
});

export interface SimctlListing {
  available: boolean;
  devices: Device[];
}

/** Simuladores iOS ligados (só existe no macOS com Xcode). */
export async function listIosSimulators(): Promise<SimctlListing> {
  if (process.platform !== 'darwin') return { available: false, devices: [] };
  let stdout: string;
  try {
    ({ stdout } = await run('xcrun', ['simctl', 'list', 'devices', 'booted', '-j']));
  } catch (error) {
    if (isMissingBinary(error)) return { available: false, devices: [] };
    throw error;
  }
  const raw: unknown = JSON.parse(stdout);
  const parsed = SimctlListSchema.parse(raw);
  const devices = Object.values(parsed.devices)
    .flat()
    .filter((d) => d.state === 'Booted')
    .map((d): Device => ({ id: d.udid, kind: 'ios-simulator', connection: 'local', label: `Simulador ${d.name}`, unavailableReason: null }));
  return { available: true, devices };
}

/** `xcrun simctl location` (Xcode 14+). */
export class IosSimulatorDriver implements LocationDriver {
  constructor(readonly device: Device) {}

  async prepare(): Promise<void> {}

  async push(fix: Fix): Promise<void> {
    await run('xcrun', [
      'simctl',
      'location',
      this.device.id,
      'set',
      `${fix.position.lat.toFixed(7)},${fix.position.lng.toFixed(7)}`,
    ]);
  }

  async release(): Promise<void> {
    await run('xcrun', ['simctl', 'location', this.device.id, 'clear']).catch(() => undefined);
  }
}
