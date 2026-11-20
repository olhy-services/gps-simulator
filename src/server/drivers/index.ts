import type { Device, DeviceList } from '../../shared/schema';
import { AndroidDeviceDriver, AndroidEmulatorDriver, listAndroidDevices } from './android';
import { IosSimulatorDriver, listIosSimulators } from './ios';
import type { LocationDriver } from './types';

export async function listDevices(): Promise<DeviceList> {
  const [android, ios] = await Promise.all([listAndroidDevices(), listIosSimulators()]);
  return {
    devices: [...android.devices, ...ios.devices],
    tools: { adb: android.available, xcrun: ios.available },
  };
}

export function createDriver(device: Device): LocationDriver {
  switch (device.kind) {
    case 'android-emulator':
      return new AndroidEmulatorDriver(device);
    case 'android-device':
      return new AndroidDeviceDriver(device);
    case 'ios-simulator':
      return new IosSimulatorDriver(device);
  }
}

/** Procura o aparelho pelo id e garante que ele pode receber posição. */
export async function findReadyDevice(id: string): Promise<Device> {
  const { devices } = await listDevices();
  const device = devices.find((d) => d.id === id);
  if (!device) throw new Error(`Aparelho "${id}" não encontrado. Ele está conectado?`);
  if (device.unavailableReason) throw new Error(`${device.label}: ${device.unavailableReason}`);
  return device;
}

export type { Fix, LocationDriver } from './types';
