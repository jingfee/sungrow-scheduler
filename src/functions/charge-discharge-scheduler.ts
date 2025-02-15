import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
  Timer,
} from '@azure/functions';
import { getPrices, Price } from '../prices';
import { Message, Operation } from '../message';
import { clearAllMessages, enqueue } from '../service-bus';
import { DateTime } from 'luxon';
import {
  getNightChargeHours,
  addToMessage,
  addToMessageWithRank,
  getTargetSoc,
} from '../util';
import { getBatterySoc } from '../sungrow-api';
import {
  getLatestBatteryBalanceUpper,
  getLatestNightChargeHighPrice,
  setLatestBatteryBalanceUpper,
  setLatestNightChargeHighPrice,
} from '../data-tables';
import { BATTERY_CAPACITY, SEK_THRESHOLD } from '../consts';

export async function chargeDischargeSchedule(
  myTimer: Timer,
  context: InvocationContext
): Promise<void> {
  await handleFunction(context);
}

export async function chargeDischargeScheduleHttp(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  await handleFunction(context);
  return { body: 'Schedule complete' };
}

app.timer('charge-discharge-schedule', {
  schedule: '0 55 20 * * *',
  handler: chargeDischargeSchedule,
});

/*app.http('charge-discharge-schedule-debug', {
  methods: ['GET'],
  handler: chargeDischargeScheduleHttp,
});*/

async function handleFunction(context: InvocationContext) {
  await clearAllMessages();
  const chargeMessages: Record<string, Message> = {};
  const dischargeMessages: Record<string, Message> = {};
  const prices = await getPrices();
  const skipDayDischarge = await setNightCharging(prices, chargeMessages);
  if (!skipDayDischarge) {
    const hasDayCharge = await setDayChargeAndDischarge(
      prices,
      chargeMessages,
      dischargeMessages
    );
    if (!hasDayCharge) {
      await setDayDischarge(prices, dischargeMessages);
    }
  }

  for (const [time, message] of Object.entries(chargeMessages)) {
    context.log('Adding charge message', time, JSON.stringify(message));
    await enqueue(message, DateTime.fromISO(time));
  }
  for (const [time, message] of Object.entries(dischargeMessages)) {
    context.log('Adding discharge message', time, JSON.stringify(message));
    await enqueue(message, DateTime.fromISO(time));
  }
}

async function setNightCharging(
  prices: Price[],
  messages: Record<string, Message>
) {
  //  find cheapest 2, 3 and 4 hours between 22:00 - 06:00
  //  if mean over 4 cheapest hours is less than 10 öre, always charge 4 hours
  //  else
  //    calc mean of those sets of hours
  //    diff avg of tomorrow 4 most expensive hours and night 2 cheapest hours
  //    if diff < SEK_THRESHOLD, set targetsoc to 50%, 2 charge hours and skip day discharge else full charge and allow day discharge
  //    charge 4 hours if diff avg4 and avg2 less than 10 öre
  //    charge 3 hours if diff avg3 and avg2 less than 5 öre
  //    else charge 2 hours
  //  targetsoc 100% if saturday -> sunday
  //  targetsoc 99% if diff most expensive and cheapest hour is more than 75 öre
  //  targetsoc 98% if diff most expensive and cheapest hour is less than 75 öre

  const latestBalanceUpper = await getLatestBatteryBalanceUpper();
  const diff = DateTime.now().diff(latestBalanceUpper, 'days').toObject();
  const shouldBalanceBatteryUpper = Math.ceil(diff.days) >= 7;

  let chargeHours = getNightChargeHours(prices);
  const targetSoc = getTargetSoc(
    prices,
    chargeHours,
    shouldBalanceBatteryUpper
  );
  const skipDayDischarge = targetSoc < 0.98;

  const currentSoc = await getBatterySoc();
  const chargeAmount = (targetSoc - currentSoc) * BATTERY_CAPACITY;

  if (chargeAmount <= 0) {
    // no need to charge
    return skipDayDischarge;
  }

  let chargingPower =
    Math.ceil(((chargeAmount / chargeHours.length) * 1.2) / 100) * 100;
  while (chargeHours.length > 1) {
    if (chargingPower < 800) {
      chargeHours = chargeHours
        .sort((a, b) => (a.price < b.price ? 1 : -1))
        .slice(1)
        .sort((a, b) => (a.time > b.time ? 1 : -1));

      chargingPower =
        Math.ceil(((chargeAmount / chargeHours.length) * 1.2) / 100) * 100;
    } else {
      break;
    }
  }

  if (targetSoc === 1) {
    await setLatestBatteryBalanceUpper(DateTime.now());
  }

  addToMessage(
    chargeHours,
    messages,
    {
      operation: Operation.StartCharge,
      power: chargingPower,
      targetSoc,
    } as Message,
    {
      operation: Operation.StopCharge,
      targetSoc,
    } as Message
  );

  const highPrice = chargeHours.sort((a, b) => (a.price < b.price ? 1 : -1))[0]
    .price;
  await setLatestNightChargeHighPrice(highPrice);

  return skipDayDischarge;
}

async function setDayChargeAndDischarge(
  prices: Price[],
  chargeMessages: Record<string, Message>,
  dischargeMessages: Record<string, Message>
) {
  // find cheapest hour between 10:00-16:00
  // check hours from 06:00 up to cheapest hour, check hours from cheapest hour to 22:00
  // check if at least 2 hours before and after thats at least SEK_THRESHOLD more expensive
  // identify up to 3 hours before and up to 3 hours after that are at least SEK_THRESHOLD more expensive

  const sortedPrices = prices
    .slice(34, 40) //tomorrow 10:00 - 16:00
    .sort((a, b) => (a.price > b.price ? 1 : -1));
  const cheapestDayPrice = sortedPrices[0];

  const cheapestHour = DateTime.fromISO(cheapestDayPrice.time).hour;

  const moreExpensiveBefore = prices
    .slice(30, 24 + cheapestHour)
    .filter((p) => p.price - cheapestDayPrice.price >= SEK_THRESHOLD)
    .sort((a, b) => (a.price < b.price ? 1 : -1));
  const moreExpensiveAfter = prices
    .slice(24 + cheapestHour, 46)
    .filter((p) => p.price - cheapestDayPrice.price >= SEK_THRESHOLD)
    .sort((a, b) => (a.price < b.price ? 1 : -1));

  if (moreExpensiveBefore.length < 2 || moreExpensiveAfter.length < 2) {
    return false;
  }

  // choose up to 4 hours before and after cheapest hour to discharge
  const dischargeHoursBefore = moreExpensiveBefore.slice(0, 4);
  const dischargeHoursAfter = moreExpensiveAfter.slice(0, 4);
  // target soc based on the number of discharge hours after the day charge
  const targetSoc = dischargeHoursAfter.length >= 2 ? 0.9 : 0.6;
  const nextCheapestDayPrice = sortedPrices[1];
  // only charge 2 hours instead of 1 if the price diff is small
  const numberOfChargeHours =
    nextCheapestDayPrice.price - cheapestDayPrice.price <= 0.05 ? 2 : 1;
  // chargepower based on the 1 or 2 charge hours and the numbers of dischargehoursbefore
  const chargePower =
    numberOfChargeHours === 2
      ? dischargeHoursBefore.length >= 3
        ? 5000
        : 3000
      : dischargeHoursBefore.length >= 2
      ? 5000
      : 3000;

  const chargeHours =
    numberOfChargeHours === 2
      ? [cheapestDayPrice, nextCheapestDayPrice].sort((a, b) =>
          a.time > b.time ? 1 : -1
        )
      : [cheapestDayPrice];

  for (const chargeHour of chargeHours) {
    chargeMessages[DateTime.fromISO(chargeHour.time).toISO()] = {
      operation: Operation.StartCharge,
      power: chargePower,
      targetSoc,
    } as Message;

    chargeMessages[
      DateTime.fromISO(chargeHour.time).plus({ hours: 1 }).toISO()
    ] = {
      operation: Operation.StopCharge,
      targetSoc,
    } as Message;
  }

  const rankings: Record<string, number> = {};
  for (const [index, hour] of dischargeHoursBefore.entries()) {
    rankings[hour.time] = index;
  }
  for (const [index, hour] of dischargeHoursAfter.entries()) {
    rankings[hour.time] = index;
  }

  const dischargeHours = [
    ...dischargeHoursBefore.sort((a, b) => (a.time > b.time ? 1 : -1)),
    ...dischargeHoursAfter.sort((a, b) => (a.time > b.time ? 1 : -1)),
  ];

  addToMessageWithRank(
    dischargeHours,
    rankings,
    dischargeMessages,
    {
      operation: Operation.StartDischarge,
    } as Message,
    {
      operation: Operation.StopDischarge,
    } as Message
  );

  return true;
}

async function setDayDischarge(
  prices: Price[],
  messages: Record<string, Message>
) {
  //  find 4 most expensive hours between 06:00-22:00
  //  add message to bus to discharge at most expensive hours

  const latestNightChargeHighPrice = await getLatestNightChargeHighPrice();

  const dischargeHoursPriceSorted = prices
    .slice(30, 46) // 06:00 to 22:00
    .sort((a, b) => (a.price < b.price ? 1 : -1))
    .filter((p) => p.price > latestNightChargeHighPrice)
    .slice(0, 5);

  const rankings: Record<string, number> = {};
  for (const [index, hour] of dischargeHoursPriceSorted.entries()) {
    rankings[hour.time] = index;
  }

  const dischargeHoursDateSorted = [...dischargeHoursPriceSorted].sort((a, b) =>
    a.time > b.time ? 1 : -1
  );

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
}
