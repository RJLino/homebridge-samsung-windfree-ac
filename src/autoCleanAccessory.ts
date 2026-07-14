import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';

import { HomebridgePlatform } from './platform';
import { SmartThingsClient, ComponentStatus } from '@smartthings/core-sdk';

// Acessorio SEPARADO para a auto-limpeza, para ter tile proprio na app Home (um servico
// secundario colado ao AC so aparecia no detalhe da bridge). Expoe:
//  - OccupancySensor 'Cleaning' -> Detected quando operatingState === 'autoClean'
//  - HumiditySensor  'Progress' -> progress (0-100%) do ciclo de limpeza
export class AutoCleanAccessory {
  private statusCache: { data: ComponentStatus; ts: number } | null = null;
  private readonly STATUS_CACHE_MS = 2500;
  private readonly deviceId: string;

  constructor(
    private readonly platform: HomebridgePlatform,
    private readonly accessory: PlatformAccessory,
    private readonly client: SmartThingsClient,
  ) {
    this.deviceId = accessory.context.device.deviceId;
    const { Service, Characteristic } = this.platform;
    const label = accessory.context.device.label ?? 'Auto Clean';

    accessory.getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Samsung')
      .setCharacteristic(Characteristic.Model, 'WindFree - Auto Clean');

    const active =
      accessory.getService(Service.OccupancySensor) ||
      accessory.addService(Service.OccupancySensor, 'Cleaning', `cleaning-active-${this.deviceId}`);
    this.nameService(active, `${label} Auto Clean`);
    active.setPrimaryService(true);
    active.getCharacteristic(Characteristic.OccupancyDetected)
      .onGet(this.handleCleaningActiveGet.bind(this));

    const progress =
      accessory.getService(Service.HumiditySensor) ||
      accessory.addService(Service.HumiditySensor, 'Progress', `cleaning-progress-${this.deviceId}`);
    this.nameService(progress, 'Auto Clean Progress');
    progress.getCharacteristic(Characteristic.CurrentRelativeHumidity)
      .onGet(this.handleProgressGet.bind(this));
  }

  private nameService(service: Service, name: string): void {
    const { Characteristic } = this.platform;
    service.setCharacteristic(Characteristic.Name, name);
    if (!service.testCharacteristic(Characteristic.ConfiguredName)) {
      service.addOptionalCharacteristic(Characteristic.ConfiguredName);
    }
    service.setCharacteristic(Characteristic.ConfiguredName, name);
  }

  private async handleCleaningActiveGet(): Promise<CharacteristicValue> {
    const { Characteristic } = this.platform;
    const status = await this.getStatus();
    const state = status['custom.autoCleaningMode']?.operatingState?.value;
    return state === 'autoClean'
      ? Characteristic.OccupancyDetected.OCCUPANCY_DETECTED
      : Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED;
  }

  private async handleProgressGet(): Promise<CharacteristicValue> {
    const status = await this.getStatus();
    const progress = status['custom.autoCleaningMode']?.progress?.value;
    return typeof progress === 'number' ? progress : 0;
  }

  private async getStatus() {
    const now = Date.now();
    if (this.statusCache && now - this.statusCache.ts < this.STATUS_CACHE_MS) {
      return this.statusCache.data;
    }
    const data = await this.client.devices.getStatus(this.deviceId);
    if (!data.components?.main) {
      throw new Error('Failed to get device status');
    }
    this.statusCache = { data: data.components.main, ts: now };
    return this.statusCache.data;
  }
}
