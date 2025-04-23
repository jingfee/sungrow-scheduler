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
import { clearAllMessages, enqueue } from '../service-bus';
import {
  getDailyLoadAndTime,
  getRankings,
  setDailyLoad,
  setLatestBatteryBalanceUpper,
  setLatestChargeSoc,
  setRankings,
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
  await handleFunction(
    { operation: Operation.SetDischargeAfterSolar },
    context
  );
  return { body: 'Complete' };
}

app.serviceBusQueue('service-bus-trigger', {
  connection: 'ServiceBusConnectionString',
  queueName: serviceBusName,
  handler: serviceBusTrigger,
});

/* app.http('service-bus-trigger-debug', {
  methods: ['GET'],
  handler: serviceBusTriggerHttp,
}); */

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
  if (message.rank != null) {
    const dailyLoad = await getDailyLoad();
    const rankings = await getRankings();
    const rank = rankings.indexOf(message.rank);
    if (rank === -1) {
      context.log(
        `Rank: ${rank} not found in rankings array: ${JSON.stringify(rankings)}`
      );
    } else {
      const hasFutureDischargeWithLowerRank = rank > 0;
      const newRankings = rankings.filter((r) => r !== message.rank);
      await setRankings(newRankings);

      const currentHour = DateTime.now().setZone('Europe/Stockholm').hour;

      let loadHourlyMean;
      if (currentHour > 6) {
        loadHourlyMean = dailyLoad / currentHour;
        await setDailyLoad(dailyLoad);
      } else {
        const dailyLoadSaved = await getDailyLoadAndTime();
        const dailyLoadSavedHour = DateTime.fromISO(
          dailyLoadSaved.time
        ).setZone('Europe/Stockholm').hour;

        loadHourlyMean =
          (dailyLoad + dailyLoadSaved.load) /
          (currentHour + dailyLoadSavedHour);
      }

      const currentChargeSoc = await getBatterySoc();
      const dischargeCapacity = (currentChargeSoc - MIN_SOC) * BATTERY_CAPACITY;

      const hours = Math.round(dischargeCapacity / loadHourlyMean);

      context.log(`Rank: ${rank} Hours: ${hours}`);
      if (rank != undefined && rank >= hours) {
        if (hasFutureDischargeWithLowerRank) {
          return;
        }
      }
    }
  }

  context.log('Starting discharge');
  const now = DateTime.now().setZone('Europe/Stockholm');
  const startHour = now.hour;
  let endHour = now.plus({ hours: 1 }).hour;
  endHour = endHour === 0 ? 24 : endHour;
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

  await clearAllMessages([Operation.SetDischargeAfterSolar]);
  const prices = await getPrices();
  const forecast = await getProductionForecast(context);

  if (!forecast.startHour) {
    context.log('Error fetching forecast, discharge until 09:00');
  }

  const now = DateTime.now().setZone('Europe/Stockholm');

  const endHour = Math.min(forecast.startHour ?? 9, 9);

  const dischargeHoursPriceSorted = prices
    .slice(now.hour, 24 + endHour)
    .filter((p) => p.price >= -0.2)
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
  const rankingsArray = [...Array(dischargeHoursDateSorted.length).keys()];
  const stopDischarge =
    Object.entries(messages)[Object.keys(messages).length - 1];
  if (stopDischarge[1].operation === Operation.StopDischarge) {
    delete messages[stopDischarge[0]];
  }

  for (let i = 0; i < 3; i++) {
    const time = DateTime.fromISO(stopDischarge[0])
      .setZone('Europe/Stockholm')
      .plus({ hours: i });
    messages[time.toISO()] = { operation: Operation.StartDischarge } as Message;
  }
  const time = DateTime.fromISO(stopDischarge[0])
    .setZone('Europe/Stockholm')
    .plus({ hours: 3 });
  messages[time.toISO()] = {
    operation: Operation.StopDischarge,
  } as Message;

  for (const [time, message] of Object.entries(messages)) {
    context.log('Adding discharge message', time, JSON.stringify(message));
    await enqueue(message, DateTime.fromISO(time));
  }

  await setRankings(rankingsArray);
}
