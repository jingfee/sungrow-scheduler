import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from '@azure/functions';
import { Message, Operation } from '../message';
import {
  getBatterySoc,
  setStartBatteryCharge,
  setStartBatteryDischarge,
  setStopBatteryCharge,
  setStopBatteryDischarge,
} from '../sungrow-api';
import { DateTime } from 'luxon';
import { clearAllMessages, enqueue } from '../service-bus';
import {
  getRankings,
  setLatestBatteryBalanceUpper,
  setLatestChargeSoc,
  setRankings,
} from '../data-tables';
import { BATTERY_CAPACITY, MIN_SOC } from '../consts';
import { getPrices } from '../prices';
import { getProductionForecast } from '../solcast';
import {
  addToMessageWithRank,
  getLoadQuarterlyMean,
  setUnrankedDischargeAfter,
} from '../util';

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
      await handleStartBatteryCharge(message, context);
      break;
    case Operation.StopCharge:
      await handleStopBatteryCharge(message, context);
      break;
    case Operation.StartDischarge:
      await handleStartBatteryDischarge(message, context);
      break;
    case Operation.StopDischarge:
      await handleStopBatteryDischarge(context);
      break;
    case Operation.SetDischargeAfterSolar:
      await handleSetDischargeAfterSolar(context);
      break;
  }
}

async function handleStartBatteryCharge(
  message: Message,
  context: InvocationContext
) {
  await setStartBatteryCharge(message.power, message.targetSoc, context);
}

async function handleStopBatteryCharge(
  message: Message,
  context: InvocationContext
) {
  const soc = await getBatterySoc();
  await setStopBatteryCharge(context);

  await setLatestChargeSoc(soc * message.targetSoc);
}

async function handleStartBatteryDischarge(
  message: Message,
  context: InvocationContext
) {
  if (message.rank != null) {
    const loadQuarterlyMean = await getLoadQuarterlyMean();
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

      const currentChargeSoc = await getBatterySoc();
      const dischargeCapacity = (currentChargeSoc - MIN_SOC) * BATTERY_CAPACITY;

      const quarters = Math.round(dischargeCapacity / loadQuarterlyMean);

      context.log(`Rank: ${rank} Quarters: ${quarters}`);
      if (rank != undefined && rank >= quarters) {
        if (hasFutureDischargeWithLowerRank) {
          return;
        }
      }
    }
  }

  context.log('Starting discharge');
  const now = DateTime.now().setZone('Europe/Stockholm');
  const startHour = now.hour;
  const startMinute = now.minute;
  const endTime = now.plus({ minutes: 15 });
  let endHour = endTime.hour;
  endHour = endHour === 0 ? 24 : endHour;
  const endMinute = endTime.minute;
  await setStartBatteryDischarge(
    startHour,
    startMinute,
    endHour,
    endMinute,
    context
  );
}

async function handleStopBatteryDischarge(context: InvocationContext) {
  await setStopBatteryDischarge(context);
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

  if (!forecast.startTime) {
    context.log(
      'No starttime, either there was an error fetching forecast or upcoming production doesnt reach the threshold, ranked discharge until 09:00'
    );
  }
  const forecastStartTime = DateTime.fromISO(forecast.startTime);

  const now = DateTime.now().setZone('Europe/Stockholm');

  const dischargeEndHour = Math.min(forecastStartTime.hour ?? 9, 9);
  const dischargeEndMinute =
    forecastStartTime.hour > 9 ? 0 : forecastStartTime.minute;

  const dischargeQuartersPriceSorted = prices
    .slice(
      now.hour * 4 + (now.minute >= 30 ? 2 : 0),
      24 * 4 + dischargeEndHour * 4 + (dischargeEndMinute === 30 ? 2 : 0)
    )
    .filter((p) => p.price >= -0.2)
    .sort((a, b) => (a.price < b.price ? 1 : -1));

  const rankings: Record<string, number> = {};
  for (const [index, price] of dischargeQuartersPriceSorted.entries()) {
    rankings[price.time] = index;
  }

  const dischargeQuartersDateSorted = [...dischargeQuartersPriceSorted].sort(
    (a, b) => (a.time > b.time ? 1 : -1)
  );

  let messages: Record<string, Message> = {};
  addToMessageWithRank(
    dischargeQuartersDateSorted,
    rankings,
    messages,
    {
      operation: Operation.StartDischarge,
    } as Message,
    {
      operation: Operation.StopDischarge,
    } as Message
  );
  const rankingsArray = [...Array(dischargeQuartersDateSorted.length).keys()];
  await setRankings(rankingsArray);

  // Only set unrankeddischarge if we have a startHour for the forecast
  if (forecast.startTime) {
    setUnrankedDischargeAfter(messages);
  }

  for (const [time, message] of Object.entries(messages)) {
    context.log('Adding discharge message', time, JSON.stringify(message));
    await enqueue(message, DateTime.fromISO(time));
  }
}
