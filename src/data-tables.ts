import { AzureNamedKeyCredential, TableClient } from '@azure/data-tables';
import { DateTime } from 'luxon';
import { start } from 'repl';

const account = process.env['AzureDataTableAccountName'];
const accountKey = process.env['AzureDataTableAccountKey'];

const _credential = new AzureNamedKeyCredential(account, accountKey);
const _client = new TableClient(
  `https://${account}.table.core.windows.net`,
  process.env['AzureDataTableTableName'],
  _credential
);

export async function setLatestBatteryBalanceUpper(date: DateTime) {
  await _client.upsertEntity({
    partitionKey: TableKeys.LatestBatteryBalanceUpper,
    rowKey: '',
    value: date.toString(),
  });
}

export async function getLatestBatteryBalanceUpper(): Promise<DateTime> {
  const entity = await _client.getEntity(
    TableKeys.LatestBatteryBalanceUpper,
    ''
  );
  return DateTime.fromISO(entity.value);
}

export async function setLatestChargeSoc(soc: number) {
  await _client.upsertEntity({
    partitionKey: TableKeys.LatestChargeSoc,
    rowKey: '',
    value: soc.toString(),
  });
}

export async function getLatestChargeSoc(): Promise<number> {
  const entity = await _client.getEntity(TableKeys.LatestChargeSoc, '');
  return parseFloat(entity.value as string);
}

export async function setLatestNightChargeHighPrice(price: number) {
  await _client.upsertEntity({
    partitionKey: TableKeys.LatestNightChargeHighPrice,
    rowKey: '',
    value: price.toString(),
  });
}

export async function getLatestNightChargeHighPrice() {
  const entity = await _client.getEntity(
    TableKeys.LatestNightChargeHighPrice,
    ''
  );
  return parseInt(entity.value as string);
}

export async function setForecast(
  energy: number,
  batteryEnergy: number,
  startHour: number,
  endHour: number
) {
  await _client.upsertEntity({
    partitionKey: TableKeys.ForecastEnergy,
    rowKey: '',
    value: energy.toString(),
  });
  await _client.upsertEntity({
    partitionKey: TableKeys.ForecastBatteryEnergy,
    rowKey: '',
    value: batteryEnergy.toString(),
  });
  await _client.upsertEntity({
    partitionKey: TableKeys.ForecastStartHour,
    rowKey: '',
    value: startHour.toString(),
  });
  await _client.upsertEntity({
    partitionKey: TableKeys.ForecastEndHour,
    rowKey: '',
    value: endHour.toString(),
  });
}

export async function setDailyLoad(load: number) {
  await _client.upsertEntity({
    partitionKey: TableKeys.DailyLoad,
    rowKey: '',
    value: load.toString(),
  });
}

export async function getDailyLoadAndTime() {
  const entity = await _client.getEntity(TableKeys.DailyLoad, '');
  return { load: parseFloat(entity.value as string), time: entity.timestamp };
}

export async function setRankings(rankings: number[]) {
  await _client.upsertEntity({
    partitionKey: TableKeys.Rankings,
    rowKey: '',
    value: JSON.stringify(rankings),
  });
}

export async function getRankings(): Promise<number[]> {
  const entity = await _client.getEntity(TableKeys.Rankings, '');
  return JSON.parse(entity.value as string);
}

enum TableKeys {
  LatestBatteryBalanceUpper = 'LatestBatteryBalanceUpper',
  LatestChargeSoc = 'LatestChargeSoc',
  LatestNightChargeHighPrice = 'LatestNightChargeHighPrice',
  ForecastEnergy = 'ForecastEnergy',
  ForecastBatteryEnergy = 'ForecastBatteryEnergy',
  ForecastStartHour = 'ForecastStartHour',
  ForecastEndHour = 'ForecastEndHour',
  DailyLoad = 'DailyLoad',
  Rankings = 'Rankings',
}
