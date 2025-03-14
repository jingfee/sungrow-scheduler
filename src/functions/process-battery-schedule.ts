import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from '@azure/functions';
import { Message, Operation } from '../message';
import {
  getBatterySoc,
  getDailyLoad,
  setStartBatteryCharge,
  setStartBatteryDischarge,
  setStopBatteryCharge,
  setStopBatteryDischarge,
} from '../sungrow-api';
import { DateTime } from 'luxon';
import {
  clearAllMessages,
  enqueue,
  getChargeAndDischargeMessages,
} from '../service-bus';
import {
  getLatestChargeSoc,
  setLatestBatteryBalanceUpper,
  setLatestChargeSoc,
} from '../data-tables';
import { BATTERY_CAPACITY, MIN_SOC } from '../consts';
import { getPrices } from '../prices';
import { getProductionForecast } from '../solcast';
import { addToMessageWithRank } from '../util';

const serviceBusName = 'battery-queue';

export async function serviceBusTrigger(
  message: Message,
  context: InvocationContext
): Promise<void> {
  await handleFunction(message, context);
}

export async function serviceBusTriggerHttp(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  await handleFunction({ operation: Operation.StartCharge, rank: 2 }, context);
  return { body: 'Discharge Leftover complete' };
}

app.serviceBusQueue('service-bus-trigger', {
  connection: 'ServiceBusConnectionString',
  queueName: serviceBusName,
  handler: serviceBusTrigger,
});

/*app.http('service-bus-trigger-debug', {
  methods: ['GET'],
  handler: serviceBusTriggerHttp,
});*/

async function handleFunction(message: Message, context: InvocationContext) {
  context.log('Handling message', JSON.stringify(message));
  switch (message.operation) {
    case Operation.StartCharge:
      await handleStartBatteryCharge(message);
      break;
    case Operation.StopCharge:
      await handleStopBatteryCharge(message);
      break;
    case Operation.StartDischarge:
      await handleStartBatteryDischarge(message, context);
      break;
    case Operation.StopDischarge:
      await handleStopBatteryDischarge();
      break;
    case Operation.SetDischargeAfterSolar:
      await handleSetDischargeAfterSolar(context);
      break;
  }
}

async function handleStartBatteryCharge(message: Message) {
  await setStartBatteryCharge(message.power, message.targetSoc);
}

async function handleStopBatteryCharge(message: Message) {
  const soc = await getBatterySoc();
  await setStopBatteryCharge();

  await setLatestChargeSoc(soc * message.targetSoc);
}

async function handleStartBatteryDischarge(
  message: Message,
  context: InvocationContext
) {
  const dailyLoad = await getDailyLoad();
  const currentHour = DateTime.now().setZone('Europe/Stockholm').hour;
  const loadHourlyMean = dailyLoad / currentHour;

  const latestChargeSoc = await getLatestChargeSoc();
  const dischargeCapacity = (latestChargeSoc - MIN_SOC) * BATTERY_CAPACITY;

  const hours = Math.round(dischargeCapacity / loadHourlyMean);

  context.log(`Rank: ${message.rank} Hours: ${hours}`);
  if (message.rank != undefined && message.rank >= hours) {
    const messages = await getChargeAndDischargeMessages();
    const nextChargeMessage =
      messages.chargeMessages.length > 0
        ? messages.chargeMessages.sort((a, b) =>
            a.scheduledEnqueueTimeUtc > b.scheduledEnqueueTimeUtc ? 1 : -1
          )[0]
        : undefined;
    const hasFutureDischargeWithLowerRank = messages.dischargeMessages
      .filter(
        (m) =>
          (m.body as Message).operation === Operation.StartDischarge &&
          (!nextChargeMessage ||
            m.scheduledEnqueueTimeUtc <
              nextChargeMessage.scheduledEnqueueTimeUtc)
      )
      .some((m) => m.body.rank < message.rank);
    if (hasFutureDischargeWithLowerRank) {
      return;
    }
  }

  context.log('Starting discharge');
  const now = DateTime.now().setZone('Europe/Stockholm');
  const startHour = now.hour;
  const endHour = now.plus({ hours: 1 }).hour;
  await setStartBatteryDischarge(startHour, endHour);
}

async function handleStopBatteryDischarge() {
  await setStopBatteryDischarge();
}

async function handleSetDischargeAfterSolar(context: InvocationContext) {
  const soc = await getBatterySoc();
  await setLatestChargeSoc(soc);

  if (soc === 1) {
    await setLatestBatteryBalanceUpper(
      DateTime.now().setZone('Europe/Stockholm')
    );
  }

  await clearAllMessages([]);
  const prices = await getPrices();
  const forecast = await getProductionForecast();

  if (!forecast.startHour) {
    context.log('Error fetching forecast, discharge until 06:00');
  }

  const now = DateTime.now().setZone('Europe/Stockholm');

  const dischargeHoursPriceSorted = prices
    .slice(now.hour, 24 + forecast.startHour)
    .filter((p) => p.price > 0.05)
    .sort((a, b) => (a.price < b.price ? 1 : -1));

  const rankings: Record<string, number> = {};
  for (const [index, hour] of dischargeHoursPriceSorted.entries()) {
    rankings[hour.time] = index;
  }

  const dischargeHoursDateSorted = [...dischargeHoursPriceSorted].sort((a, b) =>
    a.time > b.time ? 1 : -1
  );

  const messages: Record<string, Message> = {};
  addToMessageWithRank(
    dischargeHoursDateSorted,
    rankings,
    messages,
    {
      operation: Operation.StartDischarge,
    } as Message,
    {
      operation: Operation.StopDischarge,
    } as Message
  );

  for (const [time, message] of Object.entries(messages)) {
    context.log('Adding discharge message', time, JSON.stringify(message));
    await enqueue(message, DateTime.fromISO(time));
  }
}
