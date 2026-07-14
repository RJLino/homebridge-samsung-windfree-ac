import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';

import { HomebridgePlatform } from './platform';
import { SmartThingsClient, ComponentStatus } from '@smartthings/core-sdk';

// Com que frequencia empurramos a % de progresso para o HomeKit (a plugin nao "empurra"
// por defeito; sem isto o Home so atualiza quando decide perguntar, e a % fica presa).
const POLL_INTERVAL_MS = 30_000;

// Acessorio SEPARADO para a auto-limpeza, para ter tile proprio na app Home.
// Expoe apenas o progresso (HumiditySensor 0-100%): 0% = parado, >0% = a limpar.
// Nao usamos OccupancySensor de proposito — criava a categoria 'Security' no Home e
// parecia um sensor de movimento.
export class AutoCleanAccessory {
  private statusCache: { data: ComponentStatus; ts: number } | null = null;
  private readonly STATUS_CACHE_MS = 2500;
  private readonly deviceId: string;
  private readonly progressService: Service;

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

    // Limpar o sensor de ocupacao antigo (versoes anteriores expunham o 'a limpar' aqui,
    // o que criava a aba 'Security' e o aspeto de sensor de movimento).
    const oldOccupancy = accessory.getService(Service.OccupancySensor);
    if (oldOccupancy) {
      accessory.removeService(oldOccupancy);
    }

    this.progressService =
      accessory.getService(Service.HumiditySensor) ||
      accessory.addService(Service.HumiditySensor, 'Progress', `cleaning-progress-${this.deviceId}`);
    this.nameService(this.progressService, `${label} Auto Clean`);
    this.progressService.setPrimaryService(true);
    this.progressService.getCharacteristic(Characteristic.CurrentRelativeHumidity)
      .onGet(this.handleProgressGet.bind(this));

    // Empurrar atualizacoes periodicamente para o Home refletir o progresso ao vivo.
    this.poll();
    setInterval(() => this.poll(), POLL_INTERVAL_MS).unref();
  }

  private nameService(service: Service, name: string): void {
    const { Characteristic } = this.platform;
    service.setCharacteristic(Characteristic.Name, name);
    if (!service.testCharacteristic(Characteristic.ConfiguredName)) {
      service.addOptionalCharacteristic(Characteristic.ConfiguredName);
    }
    service.setCharacteristic(Characteristic.ConfiguredName, name);
  }

  private async poll(): Promise<void> {
    try {
      this.statusCache = null; // forcar leitura fresca no ciclo de polling
      const progress = await this.readProgress();
      this.progressService.updateCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity, progress);
    } catch (err) {
      this.platform.log.debug('Auto Clean poll failed:', err instanceof Error ? err.message : String(err));
    }
  }

  private async readProgress(): Promise<number> {
    const status = await this.getStatus();
    const progress = status['custom.autoCleaningMode']?.progress?.value;
    return typeof progress === 'number' ? progress : 0;
  }

  private async handleProgressGet(): Promise<CharacteristicValue> {
    return this.readProgress();
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
