import { AzureNamedKeyCredential, TableClient } from '@azure/data-tables';
import { DateTime } from 'luxon';

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

export async function setStatus(status: Status) {
  await _client.upsertEntity({
    partitionKey: TableKeys.Status,
    rowKey: '',
    value: status.toString(),
  });
}

export async function getStatus(): Promise<Status> {
  const entity = await _client.getEntity(TableKeys.Status, '');
  return parseInt(entity.value as string);
}

enum TableKeys {
  LatestBatteryBalanceUpper = 'LatestBatteryBalanceUpper',
  LatestChargeSoc = 'LatestChargeSoc',
  Status = 'Status',
  LatestNightChargeHighPrice = 'LatestNightChargeHighPrice',
}

export enum Status {
  Charging,
  Discharging,
  Stopped,
}
