import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';

import { HomebridgePlatform } from './platform';
import {SmartThingsClient, ComponentStatus, Command} from '@smartthings/core-sdk';

enum AirConditionerMode {
  Auto = 'auto',
  Cool = 'cool',
  Dry = 'dry',
  Heat = 'heat',
  Wind = 'wind'
}

enum SwitchState {
  On = 'on',
  Off = 'off'
}

enum TemperatureUnit {
  Celsius = 'C',
  Farenheit = 'F'
}

enum AirConditionerOptionalMode {
  WindFree = 'windFree',
  Off = 'off'
}

// OCF display-light option strings, sent via the `execute` capability.
// Atencao: a nomenclatura da Samsung esta invertida — 'Light_Off' ACENDE o display
// e 'Light_On' APAGA-o (confirmado no aparelho).
enum DisplayLight {
  On = 'Light_Off',
  Off = 'Light_On'
}

// airConditionerFanMode values
enum FanMode {
  Auto = 'auto',
  Low = 'low',
  Medium = 'medium',
  High = 'high',
  Turbo = 'turbo'
}

// fanOscillationMode values
enum OscillationMode {
  Fixed = 'fixed',
  All = 'all',
  Vertical = 'vertical',
  Horizontal = 'horizontal'
}

export class AirConditionerPlatformAccessory {
  private service: Service;

  private temperatureUnit: TemperatureUnit = TemperatureUnit.Celsius;

  // O display nao expoe leitura de estado nestes ACs (a capability samsungce.airConditionerLighting
  // nao existe e o execute.data volta null). Mantemos um estado otimista: assume-se aceso e
  // atualiza-se com o ultimo comando enviado.
  private displayOn = true;

  // Cache curto do status partilhado por todas as caracteristicas, para nao disparar N chamadas
  // a API de cada vez que o HomeKit atualiza o mosaico.
  private statusCache: { data: ComponentStatus; ts: number } | null = null;
  private readonly STATUS_CACHE_MS = 2500;

  private readonly deviceId: string;

  public static readonly supportedCapabilities =
    [
      'switch',
      'airConditionerMode',
      'thermostatCoolingSetpoint',
    ];

  protected name: string;
  protected commandURL: string;
  protected statusURL: string;
  protected healthURL: string;

  constructor(
    private readonly platform: HomebridgePlatform,
    private readonly accessory: PlatformAccessory,
    private readonly capabilities: string[],
    protected readonly client: SmartThingsClient,
  ) {

    this.name = accessory.context.device.label;
    this.deviceId = accessory.context.device.deviceId;
    this.commandURL = this.platform.config.BaseURL + '/devices/' + this.deviceId + '/commands';
    this.statusURL = this.platform.config.BaseURL + '/devices/' + this.deviceId + '/status';
    this.healthURL = this.platform.config.BaseURL + '/devices/' + this.deviceId + '/health';

    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Samsung')
      .setCharacteristic(this.platform.Characteristic.Model, 'WindFree')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, '1.0.0');

    this.service =
      this.accessory.getService(this.platform.Service.Thermostat) ||
      this.accessory.addService(this.platform.Service.Thermostat);

    this.nameService(this.service, accessory.context.device.label);
    this.service.setPrimaryService(true);

    this.service.getCharacteristic(this.platform.Characteristic.TemperatureDisplayUnits)
      .onGet(this.handleTemperatureDisplayUnitsGet.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.CurrentHeatingCoolingState)
      .onGet(this.handleCurrentHeatingCoolingStateGet.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState)
      .onGet(this.handleTargetHeatingCoolingStateGet.bind(this))
      .onSet(this.handleTargetHeatingCoolingStateSet.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .onGet(this.handleCurrentTemperatureGet.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.TargetTemperature)
      .onGet(this.handleTargetTemperatureGet.bind(this))
      .onSet(this.handleTargetTemperatureSet.bind(this));

    // Humidade: caracteristica opcional do proprio Thermostat, sempre exposta.
    this.service.getCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity)
      .onGet(this.handleCurrentRelativeHumidityGet.bind(this));

    this.setupWindFreeSwitch();
    this.setupDisplaySwitch();
    this.setupFanService();
    this.setupSwingDirectionSwitches();
    this.setupAutoCleanSwitch();
    // O progresso da auto-limpeza passou para um acessorio separado (tile proprio);
    // limpar o servico antigo caso tenha ficado em cache neste acessorio.
    this.removeServiceByName('Auto Clean Progress');
  }

  // ─── Setup dos servicos opcionais (add/remove conforme config) ───────────────

  private setupWindFreeSwitch(): void {
    this.platform.log.debug('Optional WindFree Switch: ', this.platform.config.OptionalWindFreeSwitch);
    if (this.platform.config.OptionalWindFreeSwitch) {
      this.platform.log.debug('Adding WindFree Switch');

      const windFreeSwitchService =
      this.accessory.getService('WindFree') ||
      this.accessory.addService(this.platform.Service.Switch, 'WindFree', `windfree-${this.deviceId}`);

      this.nameService(windFreeSwitchService, 'WindFree');

      windFreeSwitchService.getCharacteristic(this.platform.Characteristic.On)
        .onGet(this.handleWindFreeSwitchGet.bind(this))
        .onSet(this.handleWindFreeSwitchSet.bind(this));
    } else {
      this.removeServiceByName('WindFree');
    }
  }

  private setupDisplaySwitch(): void {
    this.platform.log.debug('Optional Display Switch: ', this.platform.config.OptionalDisplaySwitch);
    if (this.platform.config.OptionalDisplaySwitch) {
      this.platform.log.debug('Adding Display Switch');

      const displaySwitchService =
      this.accessory.getService('Display') ||
      this.accessory.addService(this.platform.Service.Switch, 'Display', `display-${this.deviceId}`);

      this.nameService(displaySwitchService, 'Display');

      displaySwitchService.getCharacteristic(this.platform.Characteristic.On)
        .onGet(this.handleDisplaySwitchGet.bind(this))
        .onSet(this.handleDisplaySwitchSet.bind(this));
    } else {
      this.removeServiceByName('Display');
    }
  }

  private setupFanService(): void {
    // Ligado por omissao (opt-out): controlo de velocidade + oscilacao (swing).
    const enabled = this.platform.config.OptionalFanControl !== false;
    this.platform.log.debug('Optional Fan Control: ', enabled);
    if (!enabled) {
      this.removeServiceByName('Fan');
      return;
    }

    this.platform.log.debug('Adding Fan Service');

    const fanService =
      this.accessory.getService('Fan') ||
      this.accessory.addService(this.platform.Service.Fanv2, 'Fan', `fan-${this.deviceId}`);

    this.nameService(fanService, 'Fan');

    fanService.getCharacteristic(this.platform.Characteristic.Active)
      .onGet(this.handleFanActiveGet.bind(this))
      .onSet(this.handleFanActiveSet.bind(this));

    fanService.getCharacteristic(this.platform.Characteristic.CurrentFanState)
      .onGet(this.handleCurrentFanStateGet.bind(this));

    fanService.getCharacteristic(this.platform.Characteristic.TargetFanState)
      .onGet(this.handleTargetFanStateGet.bind(this))
      .onSet(this.handleTargetFanStateSet.bind(this));

    fanService.getCharacteristic(this.platform.Characteristic.RotationSpeed)
      .setProps({ minValue: 0, maxValue: 100, minStep: 25 })
      .onGet(this.handleRotationSpeedGet.bind(this))
      .onSet(this.handleRotationSpeedSet.bind(this));

    fanService.getCharacteristic(this.platform.Characteristic.SwingMode)
      .onGet(this.handleSwingModeGet.bind(this))
      .onSet(this.handleSwingModeSet.bind(this));
  }

  private setupSwingDirectionSwitches(): void {
    // Switches extra para as direcoes especificas de oscilacao (vertical/horizontal).
    const enabled = this.platform.config.OptionalSwingDirectionSwitches !== false;
    this.platform.log.debug('Optional Swing Direction Switches: ', enabled);

    if (enabled) {
      this.setupOscillationSwitch('Swing Vertical', `swing-vertical-${this.deviceId}`, OscillationMode.Vertical);
      this.setupOscillationSwitch('Swing Horizontal', `swing-horizontal-${this.deviceId}`, OscillationMode.Horizontal);
    } else {
      this.removeServiceByName('Swing Vertical');
      this.removeServiceByName('Swing Horizontal');
    }
  }

  private setupOscillationSwitch(name: string, subtype: string, mode: OscillationMode): void {
    const service =
      this.accessory.getService(name) ||
      this.accessory.addService(this.platform.Service.Switch, name, subtype);

    this.nameService(service, name);

    service.getCharacteristic(this.platform.Characteristic.On)
      .onGet(async () => (await this.getOscillationMode()) === mode)
      .onSet(async (value) => {
        await this.setOscillationMode(value ? mode : OscillationMode.Fixed);
      });
  }

  private setupAutoCleanSwitch(): void {
    const enabled = this.platform.config.OptionalAutoCleanSwitch !== false;
    this.platform.log.debug('Optional Auto Clean Switch: ', enabled);
    if (enabled) {
      const service =
        this.accessory.getService('Auto Clean') ||
        this.accessory.addService(this.platform.Service.Switch, 'Auto Clean', `autoclean-${this.deviceId}`);

      this.nameService(service, 'Auto Clean');

      service.getCharacteristic(this.platform.Characteristic.On)
        .onGet(this.handleAutoCleanGet.bind(this))
        .onSet(this.handleAutoCleanSet.bind(this));
    } else {
      this.removeServiceByName('Auto Clean');
    }
  }

  private removeServiceByName(name: string): void {
    const service = this.accessory.getService(name);
    if (service) {
      this.platform.log.debug('Removing service:', name);
      this.accessory.removeService(service);
    }
  }

  // O Apple Home ignora o caracteristico Name em servicos secundarios e mostra o nome do
  // acessorio. Definir ConfiguredName faz com que cada tile apareca com o seu proprio nome.
  private nameService(service: Service, name: string): void {
    const { Characteristic } = this.platform;
    service.setCharacteristic(Characteristic.Name, name);
    if (!service.testCharacteristic(Characteristic.ConfiguredName)) {
      service.addOptionalCharacteristic(Characteristic.ConfiguredName);
    }
    service.setCharacteristic(Characteristic.ConfiguredName, name);
  }

  // ─── WindFree ────────────────────────────────────────────────────────────────

  private async handleWindFreeSwitchGet(): Promise<CharacteristicValue> {
    this.platform.log.debug('Triggered GET WindFreeSwitch');

    const deviceStatus = await this.getDeviceStatus();
    const windFreeSwitchStatus = deviceStatus['custom.airConditionerOptionalMode'].acOptionalMode.value as AirConditionerOptionalMode;
    const airConditionerMode = deviceStatus.airConditionerMode.airConditionerMode.value as AirConditionerMode;

    if (airConditionerMode === AirConditionerMode.Auto) {
      this.platform.log.debug('WindFreeSwitch is not supported in Auto mode');
      return false;
    }

    return windFreeSwitchStatus === AirConditionerOptionalMode.WindFree;
  }

  private async handleWindFreeSwitchSet(value: CharacteristicValue) {
    this.platform.log.debug('Triggered SET WindFreeSwitch:', value);

    const deviceStatus = await this.getDeviceStatus();
    const airConditionerMode = deviceStatus.airConditionerMode.airConditionerMode.value as AirConditionerMode;

    if (airConditionerMode === AirConditionerMode.Auto) {
      this.platform.log.debug('WindFreeSwitch is not supported in Auto mode');
      return;
    }

    await this.runCommand({
      capability: 'custom.airConditionerOptionalMode',
      command: 'setAcOptionalMode',
      arguments: value ? [AirConditionerOptionalMode.WindFree] : [AirConditionerOptionalMode.Off],
    }, 'WindFreeSwitch');
  }

  // ─── Display (otimista) ────────────────────────────────────────────────────────

  private handleDisplaySwitchGet(): CharacteristicValue {
    this.platform.log.debug('Triggered GET DisplaySwitch (optimistic):', this.displayOn);
    // Estes ACs nao reportam o estado do display; devolvemos o ultimo estado conhecido.
    return this.displayOn;
  }

  private async handleDisplaySwitchSet(value: CharacteristicValue) {
    this.platform.log.debug('Triggered SET DisplaySwitch:', value);

    const on = value as boolean;
    const response = await this.runCommand({
      capability: 'execute',
      command: 'execute',
      arguments: ['mode/vs/0', {
        'x.com.samsung.da.options': [on ? DisplayLight.On : DisplayLight.Off],
      }],
    }, 'DisplaySwitch');

    if (response?.results.length) {
      this.displayOn = on;
    }
  }

  // ─── Temperatura / modo (Thermostat) ───────────────────────────────────────────

  private handleTemperatureDisplayUnitsGet(): CharacteristicValue {
    this.platform.log.debug('Triggered GET TemperatureDisplayUnits');

    return this.temperatureUnit === TemperatureUnit.Celsius
      ? this.platform.Characteristic.TemperatureDisplayUnits.CELSIUS
      : this.platform.Characteristic.TemperatureDisplayUnits.FAHRENHEIT;
  }

  private async handleCurrentHeatingCoolingStateGet(): Promise<CharacteristicValue> {
    this.platform.log.debug('Triggered GET CurrentHeatingCoolingState');

    const deviceStatus = await this.getDeviceStatus();
    const currentHeatingCoolingState = this.platform.Characteristic.CurrentHeatingCoolingState;
    const airConditionerSwitchStatus = deviceStatus.switch.switch.value as SwitchState;
    const airConditionerMode = deviceStatus.airConditionerMode.airConditionerMode.value as AirConditionerMode;
    const coolingSetpoint = deviceStatus.thermostatCoolingSetpoint.coolingSetpoint.value as number;
    const temperature = deviceStatus.temperatureMeasurement.temperature.value as number;

    this.platform.log.debug('CurrentHeatingCoolingState:', airConditionerMode);

    if (airConditionerSwitchStatus === SwitchState.Off) {
      return currentHeatingCoolingState.OFF;
    } else if (airConditionerMode === AirConditionerMode.Cool) {
      return currentHeatingCoolingState.COOL;
    } else if (airConditionerMode === AirConditionerMode.Auto) {
      return temperature > coolingSetpoint ? currentHeatingCoolingState.COOL : currentHeatingCoolingState.HEAT;
    } else if (airConditionerMode === AirConditionerMode.Heat) {
      return currentHeatingCoolingState.HEAT;
    } else {
      return currentHeatingCoolingState.OFF;
    }
  }

  private async handleTargetHeatingCoolingStateGet(): Promise<CharacteristicValue> {
    this.platform.log.debug('Triggered GET TargetHeatingCoolingState');

    const deviceStatus = await this.getDeviceStatus();
    const airConditionerSwitchStatus = deviceStatus.switch.switch.value as SwitchState;
    const targetHeatingCoolingState = this.platform.Characteristic.TargetHeatingCoolingState;
    const airConditionerMode = deviceStatus.airConditionerMode.airConditionerMode.value as AirConditionerMode;

    this.platform.log.debug('TargetHeatingCoolingState:', airConditionerMode);

    if (airConditionerSwitchStatus === SwitchState.Off) {
      return targetHeatingCoolingState.OFF;
    } else if (airConditionerMode === AirConditionerMode.Cool) {
      return targetHeatingCoolingState.COOL;
    } else if (airConditionerMode === AirConditionerMode.Auto) {
      return targetHeatingCoolingState.AUTO;
    } else if (airConditionerMode === AirConditionerMode.Heat) {
      return targetHeatingCoolingState.HEAT;
    } else {
      return targetHeatingCoolingState.OFF;
    }
  }

  private async handleTargetHeatingCoolingStateSet(value: CharacteristicValue) {
    this.platform.log.debug('Triggered SET TargetHeatingCoolingState:', value);

    const TargetHeatingCoolingState = this.platform.Characteristic.TargetHeatingCoolingState;

    this.platform.log.debug('TargetHeatingCoolingState:', TargetHeatingCoolingState);

    const targetHeatingCoolingStateToAirConditionerMode = () => {
      switch (value) {
        case TargetHeatingCoolingState.AUTO:
          return AirConditionerMode.Auto;
        case TargetHeatingCoolingState.COOL:
          return AirConditionerMode.Cool;
        case TargetHeatingCoolingState.HEAT:
          return AirConditionerMode.Heat;
        default:
          return undefined;
      }
    };

    const airConditionerMode = targetHeatingCoolingStateToAirConditionerMode();

    const commands = airConditionerMode ? [
      {
        capability: 'switch',
        command: SwitchState.On,
      },
      {
        capability: 'airConditionerMode',
        command: 'setAirConditionerMode',
        arguments: [airConditionerMode],
      },
    ] : [
      {
        capability: 'switch',
        command: SwitchState.Off,
      },
    ];

    const response = await this.client.devices.executeCommands(this.deviceId, commands);
    this.statusCache = null;

    if (!response.results.length) {
      this.platform.log.error('Failed to set TargetHeatingCoolingState');
    }
  }

  private async handleCurrentTemperatureGet(): Promise<CharacteristicValue> {
    this.platform.log.debug('Triggered GET CurrentTemperature');

    const deviceStatus = await this.getDeviceStatus();
    const temperature = deviceStatus.temperatureMeasurement.temperature.value;

    return temperature as CharacteristicValue;
  }

  private async handleTargetTemperatureGet(): Promise<CharacteristicValue> {
    this.platform.log.debug('Triggered GET TargetTemperature');

    const deviceStatus = await this.getDeviceStatus();
    const temperature = deviceStatus.thermostatCoolingSetpoint.coolingSetpoint.value;

    return temperature as CharacteristicValue;
  }

  private async handleTargetTemperatureSet(value: CharacteristicValue) {
    this.platform.log.debug('Triggered SET TargetTemperature:', value);

    await this.runCommand({
      capability: 'thermostatCoolingSetpoint',
      command: 'setCoolingSetpoint',
      arguments: [value as number],
    }, 'TargetTemperature');
  }

  // ─── Humidade ──────────────────────────────────────────────────────────────────

  private async handleCurrentRelativeHumidityGet(): Promise<CharacteristicValue> {
    this.platform.log.debug('Triggered GET CurrentRelativeHumidity');

    const deviceStatus = await this.getDeviceStatus();
    const humidity = deviceStatus['relativeHumidityMeasurement']?.humidity?.value;

    return typeof humidity === 'number' ? humidity : 0;
  }

  // ─── Ventoinha: velocidade + estado (Fanv2) ────────────────────────────────────

  private async handleFanActiveGet(): Promise<CharacteristicValue> {
    const deviceStatus = await this.getDeviceStatus();
    const on = deviceStatus.switch.switch.value === SwitchState.On;
    return on ? this.platform.Characteristic.Active.ACTIVE : this.platform.Characteristic.Active.INACTIVE;
  }

  private async handleFanActiveSet(value: CharacteristicValue) {
    this.platform.log.debug('Triggered SET Fan Active:', value);
    const on = value === this.platform.Characteristic.Active.ACTIVE;
    await this.runCommand({
      capability: 'switch',
      command: on ? SwitchState.On : SwitchState.Off,
    }, 'Fan Active');
  }

  private async handleCurrentFanStateGet(): Promise<CharacteristicValue> {
    const CurrentFanState = this.platform.Characteristic.CurrentFanState;
    const deviceStatus = await this.getDeviceStatus();
    const on = deviceStatus.switch.switch.value === SwitchState.On;
    return on ? CurrentFanState.BLOWING_AIR : CurrentFanState.INACTIVE;
  }

  private async handleTargetFanStateGet(): Promise<CharacteristicValue> {
    const TargetFanState = this.platform.Characteristic.TargetFanState;
    const fanMode = await this.getFanMode();
    return fanMode === FanMode.Auto ? TargetFanState.AUTO : TargetFanState.MANUAL;
  }

  private async handleTargetFanStateSet(value: CharacteristicValue) {
    this.platform.log.debug('Triggered SET TargetFanState:', value);
    const auto = value === this.platform.Characteristic.TargetFanState.AUTO;

    if (auto) {
      await this.setFanMode(FanMode.Auto);
    } else {
      // Manual: se estava em auto, arranca num valor sensato (medium).
      const current = await this.getFanMode();
      if (current === FanMode.Auto) {
        await this.setFanMode(FanMode.Medium);
      }
    }
  }

  private async handleRotationSpeedGet(): Promise<CharacteristicValue> {
    const fanMode = await this.getFanMode();
    return this.fanModeToPercent(fanMode);
  }

  private async handleRotationSpeedSet(value: CharacteristicValue) {
    this.platform.log.debug('Triggered SET RotationSpeed:', value);
    const percent = value as number;
    if (percent <= 0) {
      // Slider a zero: desligar o AC.
      await this.runCommand({ capability: 'switch', command: SwitchState.Off }, 'RotationSpeed(off)');
      return;
    }
    await this.setFanMode(this.percentToFanMode(percent));
  }

  private fanModeToPercent(fanMode: FanMode): number {
    switch (fanMode) {
      case FanMode.Low: return 25;
      case FanMode.Medium: return 50;
      case FanMode.High: return 75;
      case FanMode.Turbo: return 100;
      case FanMode.Auto:
      default: return 50; // auto nao tem velocidade fixa; TargetFanState indica o modo auto
    }
  }

  private percentToFanMode(percent: number): FanMode {
    if (percent <= 25) {
      return FanMode.Low;
    }
    if (percent <= 50) {
      return FanMode.Medium;
    }
    if (percent <= 75) {
      return FanMode.High;
    }
    return FanMode.Turbo;
  }

  private async getFanMode(): Promise<FanMode> {
    const deviceStatus = await this.getDeviceStatus();
    return (deviceStatus['airConditionerFanMode']?.fanMode?.value as FanMode) ?? FanMode.Auto;
  }

  private async setFanMode(mode: FanMode) {
    await this.runCommand({
      capability: 'airConditionerFanMode',
      command: 'setFanMode',
      arguments: [mode],
    }, 'FanMode');
  }

  // ─── Oscilacao (swing) ──────────────────────────────────────────────────────────

  private async handleSwingModeGet(): Promise<CharacteristicValue> {
    const SwingMode = this.platform.Characteristic.SwingMode;
    const mode = await this.getOscillationMode();
    return mode === OscillationMode.Fixed ? SwingMode.SWING_DISABLED : SwingMode.SWING_ENABLED;
  }

  private async handleSwingModeSet(value: CharacteristicValue) {
    this.platform.log.debug('Triggered SET SwingMode:', value);
    const enabled = value === this.platform.Characteristic.SwingMode.SWING_ENABLED;
    await this.setOscillationMode(enabled ? OscillationMode.All : OscillationMode.Fixed);
  }

  private async getOscillationMode(): Promise<OscillationMode> {
    const deviceStatus = await this.getDeviceStatus();
    return (deviceStatus['fanOscillationMode']?.fanOscillationMode?.value as OscillationMode) ?? OscillationMode.Fixed;
  }

  private async setOscillationMode(mode: OscillationMode) {
    await this.runCommand({
      capability: 'fanOscillationMode',
      command: 'setFanOscillationMode',
      arguments: [mode],
    }, 'FanOscillationMode');
  }

  // ─── Auto-limpeza ────────────────────────────────────────────────────────────────

  private async handleAutoCleanGet(): Promise<CharacteristicValue> {
    const deviceStatus = await this.getDeviceStatus();
    const mode = deviceStatus['custom.autoCleaningMode']?.autoCleaningMode?.value;
    return mode === SwitchState.On;
  }

  private async handleAutoCleanSet(value: CharacteristicValue) {
    this.platform.log.debug('Triggered SET Auto Clean:', value);
    await this.runCommand({
      capability: 'custom.autoCleaningMode',
      command: 'setAutoCleaningMode',
      arguments: [value ? SwitchState.On : SwitchState.Off],
    }, 'AutoClean');
  }

  // ─── Infra: status com cache + envio de comandos ────────────────────────────────

  private async runCommand(
    command: Command,
    label: string,
  ) {
    const response = await this.client.devices.executeCommand(this.deviceId, command);
    // Invalida o cache para a proxima leitura refletir a alteracao.
    this.statusCache = null;

    if (!response.results.length) {
      this.platform.log.error(`Failed to set ${label}`);
    }
    return response;
  }

  private async getDeviceStatus() {
    const now = Date.now();
    if (this.statusCache && now - this.statusCache.ts < this.STATUS_CACHE_MS) {
      return this.statusCache.data;
    }

    this.platform.log.debug('Triggered GET DeviceStatus');
    const data = await this.client.devices.getStatus(this.deviceId);

    if (!data.components?.main) {
      this.platform.log.error('Failed to get device status');
      throw new Error('Failed to get device status');
    }

    this.statusCache = { data: data.components.main, ts: now };
    return this.statusCache.data;
  }
}
