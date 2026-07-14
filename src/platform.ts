import { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service, Characteristic } from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { AirConditionerPlatformAccessory } from './platformAccessory';
import { AuthService } from './authService';
import { Component, SmartThingsClient } from '@smartthings/core-sdk';
import { Authenticator} from '@smartthings/core-sdk';
import { Device } from '@smartthings/core-sdk/dist/endpoint/devices';

export class HomebridgePlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;

  public readonly accessories: PlatformAccessory[] = [];
  public readonly authService!: AuthService;

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,

  ) {
    this.log.debug('Finished initializing platform:', this.config.name);

    this.authService = new AuthService(this.config, this.log, this.api.user.configPath());

    this.api.on('didFinishLaunching', () => {
      log.debug('Executed didFinishLaunching callback');
      this.discoverDevices();
    });
  }

  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);

    this.accessories.push(accessory);
  }

  async discoverDevices() {
    const authenticator: Authenticator = await this.authService.getAuthenticator();

    const client: SmartThingsClient = new SmartThingsClient(authenticator);

    let devices: Device[] = [];

    try {
      devices = await client.devices.list();
    } catch (error) {
      let errorMessage = 'Problem with retrieving devices. ';
      if (error instanceof Error) {
        errorMessage = `${errorMessage} ${error.message}`;
      }
      this.log.error(errorMessage);
    }

    for (const device of devices) {
      const deviceComponents: Component[] = device.components ?? [];

      const capabilities = deviceComponents[0]?.capabilities
        .map((capability: { id: string }) => capability.id) ?? [];

      const label = device.label ?? device.deviceId;

      this.log.debug('Discovered device:', label, capabilities);

      if (!this.doesDeviceSupportCapabilities(capabilities)) {
        this.log.warn('Device has unsupported capabilities:', label);
        continue;
      }

      // Acessorio principal do AC (thermostat + switches + ventoinha)
      const mainAccessory = this.getOrCreateAccessory(device, device.deviceId, label);
      new AirConditionerPlatformAccessory(this, mainAccessory, capabilities, client);

      // A auto-limpeza fica so com o switch da definicao (no acessorio do AC). Remover o
      // acessorio de progresso separado, caso tenha ficado em cache de versoes anteriores
      // (o sensor de humidade poluia a humidade da sala no Apple Home).
      const autoCleanUuid = this.api.hap.uuid.generate(`${device.deviceId}-autoclean`);
      const staleAutoClean = this.accessories.find(a => a.UUID === autoCleanUuid);
      if (staleAutoClean) {
        this.log.info('Removing Auto Clean progress accessory:', staleAutoClean.displayName);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [staleAutoClean]);
      }
    }
  }

  private getOrCreateAccessory(device: Device, idSeed: string, displayName: string): PlatformAccessory {
    const uuid = this.api.hap.uuid.generate(idSeed);
    const existing = this.accessories.find(accessory => accessory.UUID === uuid);

    if (existing) {
      this.log.info('Restoring existing accessory from cache:', existing.displayName);
      return existing;
    }

    this.log.info('Adding new accessory:', displayName);
    const accessory = new this.api.platformAccessory(displayName, uuid);
    accessory.context.device = device;
    this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    this.accessories.push(accessory);
    return accessory;
  }

  doesDeviceSupportCapabilities(capabilities: string[]): boolean {
    const supportedCapabilities = AirConditionerPlatformAccessory.supportedCapabilities;

    return supportedCapabilities.every(capability => {
      this.log.debug('Checking if device supports capability:', capability);

      return capabilities.includes(capability);
    });
  }
}
