import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
  Timer,
} from '@azure/functions';
import { getPrices, Price } from '../prices';
import { Message, Operation } from '../message';
import { enqueue } from '../service-bus';
import { DateTime } from 'luxon';
import { getNightChargeHours, addToMessage, SEK_THRESHOLD } from '../util';
import { getBatterySoc } from '../sungrow-api';
import {
  getLatestBatteryBalanceUpper,
  setLatestBatteryBalanceUpper,
} from '../data-tables';

// TODO:
// * Implement 1-2 extra hours for day charging
// * Discharge based on priority - check mean power usage previous hours - high power usage prioritize fewer hours with high price - low power usage can discharge more hours
// * Set min soc percentage to allow periodically full discharge

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

async function handleFunction(context: InvocationContext) {
  const messages: Record<string, Message> = {};
  const prices = await getPrices();
  const skipDayDischarge = await setNightCharging(prices, messages);
  if (!skipDayDischarge) {
    const hasDayCharge = await setDayChargeAndDischarge(prices, messages);
    if (!hasDayCharge) {
      await setDayDischarge(prices, messages);
    }
  }

  for (const [time, message] of Object.entries(messages)) {
    await enqueue(message, DateTime.fromISO(time));
  }
}

app.timer('charge-discharge-schedule', {
  schedule: '0 55 20 * * *',
  handler: chargeDischargeSchedule,
});

/*app.http('charge-discharge-schedule-debug', {
  methods: ['GET'],
  handler: chargeDischargeScheduleHttp,
});*/

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
  const diff = DateTime.now().diff(latestBalanceUpper, 'days');
  const shouldBalanceBatteryUpper = diff >= 7;

  let [chargeHours, targetSoc, skipDayDischarge] = getNightChargeHours(
    prices,
    shouldBalanceBatteryUpper
  );

  const currentSoc = parseFloat(await getBatterySoc());
  const chargeAmount = (targetSoc / 100 - currentSoc) * 9.6 * 1000;

  if (chargeAmount <= 0) {
    // no need to charge
    return skipDayDischarge;
  }

  let chargingPower;
  while (chargeHours.length > 1) {
    chargingPower =
      Math.ceil(((chargeAmount / chargeHours.length) * 1.2) / 100) * 100;

    if (chargingPower < 1000) {
      chargeHours = chargeHours
        .sort((a, b) => (a.price > b.price ? 1 : -1))
        .slice(1)
        .sort((a, b) => (a.time > b.time ? 1 : -1));
    } else {
      break;
    }
  }

  if (targetSoc === 100) {
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
    } as Message
  );

  return skipDayDischarge;
}

async function setDayChargeAndDischarge(
  prices: Price[],
  messages: Record<string, Message>
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

  messages[DateTime.fromISO(cheapestDayPrice.time).toISO()] = {
    operation: Operation.StartCharge,
    power: 5000,
    targetSoc: 90,
  } as Message;

  messages[DateTime.fromISO(cheapestDayPrice.time).plus({ hours: 1 }).toISO()] =
    {
      operation: Operation.StopCharge,
    } as Message;

  const dischargeHours = [
    ...moreExpensiveBefore
      .slice(0, 3)
      .sort((a, b) => (a.time > b.time ? 1 : -1)),
    ...moreExpensiveAfter
      .slice(0, 3)
      .sort((a, b) => (a.time > b.time ? 1 : -1)),
  ];

  addToMessage(
    dischargeHours,
    messages,
    {
      operation: Operation.StartDischarge,
    } as Message,
    {
      operation: Operation.StopCharge,
    } as Message
  );

  return true;
}

async function setDayDischarge(prices, messages: Record<string, Message>) {
  //  find 4 most expensive hours between 06:00-22:00
  //  add message to bus to discharge at most expensive hours

  const dischargeHours = prices
    .slice(30, 46) // 06:00 to 22:00
    .sort((a, b) => (a.price < b.price ? 1 : -1))
    .slice(0, 4)
    .sort((a, b) => (a.time > b.time ? 1 : -1));

  addToMessage(
    dischargeHours,
    messages,
    {
      operation: Operation.StartDischarge,
    } as Message,
    {
      operation: Operation.StopDischarge,
    } as Message
  );
}
