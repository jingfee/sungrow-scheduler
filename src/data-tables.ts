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
    partitionKey: Limit.Upper.toString(),
    rowKey: '',
    date: date.toString(),
  });
}

export async function getLatestBatteryBalanceUpper(): DateTime {
  const entity = await _client.getEntity(Limit.Upper.toString(), '');
  return DateTime.fromISO(entity.date);
}

enum Limit {
  Upper,
  Lower,
}
