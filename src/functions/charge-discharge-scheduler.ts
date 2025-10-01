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
  addToMessage,
  addToMessageWithRank,
  getNightChargeQuarters,
  getTargetSoc,
  isSummer,
  setUnrankedDischargeBefore,
} from '../util';
import { getBatterySoc } from '../sungrow-api';
import {
  getLatestBatteryBalanceUpper,
  getLatestNightChargeHighPrice,
  setLatestBatteryBalanceUpper,
  setLatestNightChargeHighPrice,
  setRankings,
} from '../data-tables';
import { BATTERY_CAPACITY, MIN_SOC, SEK_THRESHOLD } from '../consts';
import { getProductionForecast } from '../solcast';
import { instrumentFunction } from '..';

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

const instrumentedChargeDischargeSchedule = instrumentFunction(
  'chargeDischargeScheduleTimer',
  chargeDischargeSchedule
);
const instrumentedChargeDischargeScheduleHttp = instrumentFunction(
  'chargeDischargeScheduleHttp',
  chargeDischargeScheduleHttp
);

app.timer('charge-discharge-schedule', {
  schedule: '0 55 19 * * *',
  handler: instrumentedChargeDischargeSchedule,
});

/* app.http('charge-discharge-schedule-debug', {
  methods: ['GET'],
  handler: instrumentedChargeDischargeScheduleHttp,
}); */

async function handleFunction(context: InvocationContext) {
  await clearAllMessages([Operation.StartDischarge, Operation.StopDischarge]);
  const chargeMessages: Record<string, Message> = {};
  const dischargeMessages: Record<string, Message> = {};
  const prices = await getPrices();
  const forecast = await getProductionForecast(context);
  context.log(
    `Forecast (kWh): ${forecast.energy}, (startTime): ${forecast.startTime}, (endTime): ${forecast.endTime}`
  );

  if (isSummer()) {
    await setDischargeAfterSolar(dischargeMessages, forecast);
  } else {
    const nightChargeQuarters = getNightChargeQuarters(prices);
    const highestNightChargeQuarter = [...nightChargeQuarters].sort((a, b) =>
      a.price < b.price ? 1 : -1
    )[0].price;
    // dischargeQuarters = await setDayChargeAndDischarge(
    //   prices,
    //   highestNightChargeQuarter,
    //   chargeMessages,
    //   dischargeMessages
    // );

    const dischargeQuarters = await setDayDischarge(
      prices,
      highestNightChargeQuarter,
      dischargeMessages
    );

    await setNightCharging(
      prices,
      nightChargeQuarters,
      dischargeQuarters,
      chargeMessages
    );

    const now = DateTime.now().setZone('Europe/Stockholm');
    now.set({ minute: 59 });
    dischargeMessages[now.toISO()] = {
      operation: Operation.StopDischarge,
    } as Message;
  }

  if (Object.keys(chargeMessages).length > 0) {
    await clearAllMessages([Operation.SetDischargeAfterSolar]);
  }

  for (const [time, message] of Object.entries(chargeMessages)) {
    context.log('Adding charge message', time, JSON.stringify(message));
    await enqueue(message, DateTime.fromISO(time));
  }

  const rankings = [
    ...Array(
      Object.values(dischargeMessages).filter(
        (m) => m.operation === Operation.StartDischarge && m.rank != null
      ).length
    ).keys(),
  ];
  if (rankings.length > 0) {
    await setRankings(rankings);
  }

  for (const [time, message] of Object.entries(dischargeMessages)) {
    context.log('Adding discharge message', time, JSON.stringify(message));
    await enqueue(message, DateTime.fromISO(time));
  }
}

async function setNightCharging(
  prices: Price[],
  chargeQuarters: Price[],
  dischargeQuarters: number,
  messages: Record<string, Message>
) {
  // get target_soc based on number of dischargequarters, mean of chargequarters and if at least 7 days since last balancing (100% charge)
  // calc charge amount from currentsoc, targetsoc and battery capacity
  // calc chargingpower based on chargeamount and chargequarters, add 10% to accomodate load cap - if under 800w remove most expensive quarter until above 800w

  const latestBalanceUpper = await getLatestBatteryBalanceUpper();
  const diff = DateTime.now()
    .setZone('Europe/Stockholm')
    .diff(latestBalanceUpper, 'days')
    .toObject();
  const shouldBalanceBatteryUpper = Math.ceil(diff.days) >= 7;

  const targetSoc = await getTargetSoc(
    prices,
    chargeQuarters,
    dischargeQuarters,
    shouldBalanceBatteryUpper
  );

  const currentSoc = await getBatterySoc();
  const chargeAmount = (targetSoc - currentSoc) * BATTERY_CAPACITY;

  if (chargeAmount <= 0) {
    // no need to charge
    return;
  }

  let chargingPower =
    Math.ceil(((chargeAmount / (chargeQuarters.length / 4)) * 1.1) / 100) * 100;
  while (chargeQuarters.length > 1) {
    if (chargingPower < 800) {
      chargeQuarters = chargeQuarters
        .sort((a, b) => (a.price < b.price ? 1 : -1))
        .slice(1)
        .sort((a, b) => (a.time > b.time ? 1 : -1));

      chargingPower =
        Math.ceil(((chargeAmount / (chargeQuarters.length / 4)) * 1.2) / 100) *
        100;
    } else {
      break;
    }
  }

  if (targetSoc === 1) {
    await setLatestBatteryBalanceUpper(
      DateTime.now().setZone('Europe/Stockholm')
    );
  }

  addToMessage(
    chargeQuarters,
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

  const highPrice = chargeQuarters.sort((a, b) =>
    a.price < b.price ? 1 : -1
  )[0].price;
  await setLatestNightChargeHighPrice(highPrice);
}

// async function setDayChargeAndDischarge(
//   prices: Price[],
//   highestNightChargePrice: number,
//   chargeMessages: Record<string, Message>,
//   dischargeMessages: Record<string, Message>
// ) {
//   // find cheapest periods between 10:00-17:00
//   // check periods from 06:00 up to cheapest period, check periods from cheapest period to 22:00
//   // check if at least 5 * 4 periods before and after thats at least SEK_THRESHOLD more expensive than max charge price (day and night), min 1 hour before and min 1 hour after
//   // identify up to 6 hours before and up to 6 hours after that are at least SEK_THRESHOLD more expensive

//   const sortedPrices = prices
//     .slice(34 * 4, 41 * 4) //tomorrow 10:00 - 17:00
//     .sort((a, b) => (a.price > b.price ? 1 : -1));
//   const cheapestDayChargePrice = sortedPrices[0];

//   const cheapestDayChargePeriod =
//     DateTime.fromISO(cheapestDayChargePrice.time).hour * 4 +
//     Math.round(DateTime.fromISO(cheapestDayChargePrice.time).minutes / 15);
//   const highestChargePrice = Math.max(
//     cheapestDayChargePrice.price,
//     highestNightChargePrice
//   );

//   const moreExpensiveBefore = prices
//     .slice(30 * 4, 24 * 4 + cheapestDayChargePeriod)
//     .filter((p) => p.price >= highestChargePrice + SEK_THRESHOLD)
//     .sort((a, b) => (a.price < b.price ? 1 : -1));
//   const moreExpensiveAfter = prices
//     .slice(24 * 4 + cheapestDayChargePeriod, 46 * 4)
//     .filter((p) => p.price >= highestChargePrice + SEK_THRESHOLD)
//     .sort((a, b) => (a.price < b.price ? 1 : -1));

//   if (
//     moreExpensiveBefore.length + moreExpensiveAfter.length < 5 * 4 ||
//     moreExpensiveBefore.length === 0 ||
//     moreExpensiveAfter.length === 0
//   ) {
//     return 0;
//   }

//   // choose up to 6 hours before and after cheapest hour to discharge
//   const dischargePeriodsBefore = moreExpensiveBefore.slice(0, 6 * 4);
//   const dischargePeriodsAfter = moreExpensiveAfter.slice(0, 6 * 4);
//   // target soc based on the number of discharge hours after the day charge

//   const energyPerHour = CHARGE_ENERGY_PER_HOUR;
//   const totalEnergy = energyPerHour * dischargePeriodsAfter.length;
//   const targetSoc = Math.min(
//     (BATTERY_CAPACITY * MIN_SOC + totalEnergy) / BATTERY_CAPACITY,
//     0.9
//   );

//   const nextCheapestDayPrice = sortedPrices[7];
//   // only charge 2 hours instead of 1 if the price diff is small
//   const numberOfChargePeriods =
//     nextCheapestDayPrice.price - cheapestDayChargePrice.price <= 0.05
//       ? 2 * 4
//       : 1 * 4;
//   // chargepower based on the 1 or 2 charge hours and the numbers of dischargehoursbefore
//   const estimatedSocAfterDischarge = Math.max(
//     (BATTERY_CAPACITY - CHARGE_ENERGY_PER_HOUR * dischargeHoursBefore.length) /
//       BATTERY_CAPACITY,
//     MIN_SOC
//   );

//   const chargeAmount =
//     (targetSoc - estimatedSocAfterDischarge) * BATTERY_CAPACITY;
//   if (chargeAmount <= 0) {
//     // no need to charge
//     return 0;
//   }
//   const chargePower = Math.max(
//     Math.ceil(((chargeAmount / numberOfChargeHours) * 1.15) / 100) * 100,
//     5000
//   );

//   const chargeHours =
//     numberOfChargeHours === 2
//       ? [cheapestDayChargePrice, nextCheapestDayPrice].sort((a, b) =>
//           a.time > b.time ? 1 : -1
//         )
//       : [cheapestDayChargePrice];

//   for (const chargeHour of chargeHours) {
//     chargeMessages[DateTime.fromISO(chargeHour.time).toISO()] = {
//       operation: Operation.StartCharge,
//       power: chargePower,
//       targetSoc,
//     } as Message;

//     chargeMessages[
//       DateTime.fromISO(chargeHour.time).plus({ hours: 1 }).toISO()
//     ] = {
//       operation: Operation.StopCharge,
//       targetSoc,
//     } as Message;
//   }

//   const rankings: Record<string, number> = {};
//   for (const [index, hour] of dischargeHoursBefore.entries()) {
//     rankings[hour.time] = index;
//   }
//   for (const [index, hour] of dischargeHoursAfter.entries()) {
//     rankings[hour.time] = index;
//   }

//   const dischargeHours = [
//     ...dischargeHoursBefore.sort((a, b) => (a.time > b.time ? 1 : -1)),
//     ...dischargeHoursAfter.sort((a, b) => (a.time > b.time ? 1 : -1)),
//   ];

//   addToMessageWithRank(
//     dischargeHours,
//     rankings,
//     dischargeMessages,
//     {
//       operation: Operation.StartDischarge,
//     } as Message,
//     {
//       operation: Operation.StopDischarge,
//     } as Message
//   );

//   return dischargeHours.length;
// }

async function setDayDischarge(
  prices: Price[],
  highestNightChargePrice: number,
  messages: Record<string, Message>
) {
  //  find all quearters between 06:00-22:00 SEK_THRESHOLD more expensive than highest charge price
  //  add message to bus to discharge at most expensive quarters
  let dischargeQuartersPriceSorted = prices
    .slice(30 * 4, 46 * 4) // 06:00 to 22:00
    .sort((a, b) => (a.price < b.price ? 1 : -1))
    .filter((p) => p.price >= highestNightChargePrice + SEK_THRESHOLD);
  let skipNightCharge = false;

  if (dischargeQuartersPriceSorted.length === 0) {
    const soc = await getBatterySoc();
    if (soc >= 0.4) {
      const latestNightChargeHighPrice = await getLatestNightChargeHighPrice();
      dischargeQuartersPriceSorted = prices
        .slice(30 * 4, 46 * 4) // 06:00 to 22:00
        .sort((a, b) => (a.price < b.price ? 1 : -1))
        .filter((p) => p.price >= latestNightChargeHighPrice + SEK_THRESHOLD);
    }
    skipNightCharge = true;
  }

  const rankings: Record<string, number> = {};
  for (const [index, price] of dischargeQuartersPriceSorted.entries()) {
    rankings[price.time] = index;
  }

  const dischargeQuartersDateSorted = [...dischargeQuartersPriceSorted].sort(
    (a, b) => (a.time > b.time ? 1 : -1)
  );

  await clearAllMessages([]);
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

  return skipNightCharge ? 0 : dischargeQuartersDateSorted.length;
}

async function setDischargeAfterSolar(
  messages: Record<string, Message>,
  forecast: {
    energy: number;
    batteryEnergy: number;
    startTime: DateTime;
    endTime: DateTime;
  }
) {
  const tomorrow = DateTime.now().setZone('Europe/Stockholm').plus({ days: 1 });
  const endTime = DateTime.min(
    forecast.endTime ?? tomorrow.set({ hour: 18 }),
    tomorrow.set({ hour: 20 })
  );
  messages[endTime.toISO()] = {
    operation: Operation.SetDischargeAfterSolar,
  } as Message;
  if (forecast.endTime) {
    setUnrankedDischargeBefore(messages, endTime);
  }
}
