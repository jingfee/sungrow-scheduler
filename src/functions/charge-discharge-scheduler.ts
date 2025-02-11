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
  setLatestBatteryBalanceUpper,
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

  const nightChargeHours = getNightChargeHours(prices);
  const highestNightChargeHour = nightChargeHours.sort((a, b) =>
    a.price < b.price ? 1 : -1
  )[0].price;
  let dischargeHours = await setDayChargeAndDischarge(
    prices,
    highestNightChargeHour,
    chargeMessages,
    dischargeMessages
  );
  if (!dischargeHours) {
    dischargeHours = await setDayDischarge(
      prices,
      highestNightChargeHour,
      dischargeMessages
    );
  }

  await setNightCharging(
    prices,
    nightChargeHours,
    dischargeHours,
    chargeMessages
  );

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
  chargeHours: Price[],
  dischargeHours: number,
  messages: Record<string, Message>
) {
  // get target_soc based on number of dischargehours, mean of chargehours and if at least 7 days since last balancing (100% charge)
  // calc charge amount from currentsoc, targetsoc and battery capacity
  // calc chargingpower based on chargeamount and chargehours, add 20% to accomodate load cap - if under 800w remove most expensive hour until above 800w

  const latestBalanceUpper = await getLatestBatteryBalanceUpper();
  const diff = DateTime.now().diff(latestBalanceUpper, 'days').toObject();
  const shouldBalanceBatteryUpper = diff.days >= 7;

  const targetSoc = getTargetSoc(
    prices,
    chargeHours,
    dischargeHours,
    shouldBalanceBatteryUpper
  );

  const currentSoc = await getBatterySoc();
  const chargeAmount = (targetSoc - currentSoc) * BATTERY_CAPACITY;

  if (chargeAmount <= 0) {
    // no need to charge
    return;
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
}

async function setDayChargeAndDischarge(
  prices: Price[],
  highestNightChargePrice: number,
  chargeMessages: Record<string, Message>,
  dischargeMessages: Record<string, Message>
) {
  // find cheapest hour between 10:00-16:00
  // check hours from 06:00 up to cheapest hour, check hours from cheapest hour to 22:00
  // check if at least 5 hours before and after thats at least SEK_THRESHOLD more expensive than max charge price (day and night), min 1 hour before and min 1 hour after
  // identify up to 6 hours before and up to 6 hours after that are at least SEK_THRESHOLD more expensive

  const sortedPrices = prices
    .slice(34, 40) //tomorrow 10:00 - 16:00
    .sort((a, b) => (a.price > b.price ? 1 : -1));
  const cheapestDayChargePrice = sortedPrices[0];

  const cheapestDayChargeHour = DateTime.fromISO(
    cheapestDayChargePrice.time
  ).hour;
  const highestChargePrice = Math.max(
    cheapestDayChargePrice.price,
    highestNightChargePrice
  );

  const moreExpensiveBefore = prices
    .slice(30, 24 + cheapestDayChargeHour)
    .filter((p) => p.price >= highestChargePrice + SEK_THRESHOLD)
    .sort((a, b) => (a.price < b.price ? 1 : -1));
  const moreExpensiveAfter = prices
    .slice(24 + cheapestDayChargeHour, 46)
    .filter((p) => p.price >= highestChargePrice + SEK_THRESHOLD)
    .sort((a, b) => (a.price < b.price ? 1 : -1));

  if (
    moreExpensiveBefore.length + moreExpensiveAfter.length < 5 ||
    moreExpensiveBefore.length === 0 ||
    moreExpensiveAfter.length === 0
  ) {
    return 0;
  }

  // choose up to 6 hours before and after cheapest hour to discharge
  const dischargeHoursBefore = moreExpensiveBefore.slice(0, 6);
  const dischargeHoursAfter = moreExpensiveAfter.slice(0, 6);
  // target soc based on the number of discharge hours after the day charge
  const targetSocTable = {
    1: 0.35,
    2: 0.45,
    3: 0.55,
    4: 0.65,
    5: 0.75,
    6: 0.85,
  };
  const chargePowerTable = {
    1: {
      1: 3000,
      2: 3750,
      3: 4500,
      4: 5000,
      5: 5000,
      6: 5000,
    },
    2: {
      1: 2000,
      2: 2750,
      3: 3500,
      4: 4250,
      5: 5000,
      6: 5000,
    },
  };
  const targetSoc = targetSocTable[moreExpensiveBefore.length];
  const nextCheapestDayPrice = sortedPrices[1];
  // only charge 2 hours instead of 1 if the price diff is small
  const numberOfChargeHours =
    nextCheapestDayPrice.price - cheapestDayChargePrice.price <= 0.05 ? 2 : 1;
  // chargepower based on the 1 or 2 charge hours and the numbers of dischargehoursbefore
  const chargePower =
    chargePowerTable[numberOfChargeHours][dischargeHoursBefore.length];

  const chargeHours =
    numberOfChargeHours === 2
      ? [cheapestDayChargePrice, nextCheapestDayPrice].sort((a, b) =>
          a.time > b.time ? 1 : -1
        )
      : [cheapestDayChargePrice];

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

  return dischargeHours.length;
}

async function setDayDischarge(
  prices: Price[],
  highestNightChargePrice: number,
  messages: Record<string, Message>
) {
  //  find all hours between 06:00-22:00 SEK_THRESHOLD more expensive than highest charge price
  //  add message to bus to discharge at most expensive hours

  const dischargeHoursPriceSorted = prices
    .slice(30, 46) // 06:00 to 22:00
    .sort((a, b) => (a.price < b.price ? 1 : -1))
    .filter((p) => p.price >= highestNightChargePrice + SEK_THRESHOLD);

  if (dischargeHoursPriceSorted.length === 0) {
    return 0;
  }

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

  return dischargeHoursDateSorted.length;
}
