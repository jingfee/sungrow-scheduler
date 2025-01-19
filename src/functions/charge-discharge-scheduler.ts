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
  setStartBatteryCharge,
  setStartBatteryDischarge,
  setStopBatteryCharge,
  setStopBatteryDischarge,
} from '../sungrow-api';

export async function scheduler(
  myTimer: Timer,
  context: InvocationContext
): Promise<void> {
  await handleFunction(context);
}

export async function schedulerhttp(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  await handleFunction(context);
  return { body: 'Created queue item.' };
}

async function handleFunction(context: InvocationContext) {
  // monitor-prices - at 14:30
  //1. check prices after publish
  //  check if avg of todays 15:00-22:00 most expensive hours are at least 30 öre more expensive than avg of tomorrow 00:00-06:00 5 cheapest hours
  //  if not remove rest of discharge
  //  peek messages - remove discharge messages
  //
  //
  // discharge-leftover - at 20:00, 21:00
  //5. check leftover charge
  //  if battery level > 25 and current price is at least 50 öre more expensive than avg of 2 cheapest night hours, add discharge schedule for next hour
  //
  //
  //  when message from bus
  //  if charge
  //  set with api - compulsory, force charge, targetsoc, charge power
  //  chargepower based on target soc - current soc and number of charge hours, max 4 kw
  //  if stop charge
  //  set with api - self-consumption, force charge off
  //  if discharge
  //  set with api - discharge schedule now to next hour

  await clearAllMessages();
  const prices = await getPrices();
  const skipDayDischarge = await setNightCharging(prices);
  if (skipDayDischarge) {
    return;
  }
  const hasDayCharge = await setDayChargeAndDischarge(prices);
  if (hasDayCharge) {
    return;
  }
  await setDayDischarge(prices);
}

/*app.timer('charge-discharge', {
  schedule: '21 0 0 * * *',
  handler: scheduler,
});*/

app.http('scheduler-debug', {
  methods: ['GET'],
  handler: schedulerhttp,
});

async function setNightCharging(prices: Price[]) {
  //  find cheapest 2, 3 and 4 hours between 22:00 - 06:00
  //  if avg4 is less than 10 öre, always charge 4 hours
  //  else
  //    calc avg of those sets of hours
  //    diff avg of tomorrow 4 most expensive hours and night 2 cheapest hours
  //    if diff < 30 öre, set targetsoc to 50%, 2 charge hours and skip day discharge else full charge and allow day discharge
  //    charge 4 hours if diff avg4 and avg2 less than 10 öre or temp less than -6
  //    charge 3 hours if diff avg3 and avg2 less than 5 öre or temp less than 0
  //    else charge 2 hours
  //  targetsoc 100% if saturday -> sunday
  //  targetsoc 99% if diff most expensive and cheapest hour is more than 75 öre
  //  targetsoc 98% if diff most expensive and cheapest hour is less than 75 öre
  //  add message to bus to charge at cheapest hours, targetsoc according to above, chargehours
  //  add message to bus to stop charge selected hours after each hour (if not continous charging)
  const chargingHoursPower = {
    2: 4000,
    3: 3100,
    4: 2400,
  };
  let isCheapNightCharging = false;
  let skipDayDischarge = false;
  let chargingHours = 0;
  let targetSoc = 0;
  const now = DateTime.now();

  const sortedHours = prices
    .slice(22, 30) // 22:00 to 06:00 next day
    .sort((a, b) => (a.price > b.price ? 1 : -1));

  const nightlyMeans = {
    2: sortedHours.slice(0, 2).reduce((a, b) => a + b.price, 0) / 2,
    3: sortedHours.slice(0, 3).reduce((a, b) => a + b.price, 0) / 3,
    4: sortedHours.slice(0, 4).reduce((a, b) => a + b.price, 0) / 4,
    5: sortedHours.slice(0, 5).reduce((a, b) => a + b.price, 0) / 5,
    6: sortedHours.slice(0, 6).reduce((a, b) => a + b.price, 0) / 6,
    7: sortedHours.slice(0, 7).reduce((a, b) => a + b.price, 0) / 7,
    8: sortedHours.slice(0, 8).reduce((a, b) => a + b.price, 0) / 8,
  };

  // Price during night is cheap - charge for 3 hours no matter what
  if (nightlyMeans[3] < 0.1) {
    chargingHours = 3;
    isCheapNightCharging = true;
  }

  const tomorrowMostExpensiveMean =
    prices
      .slice(24) // 00:00 to 23:00 next day
      .sort((a, b) => (a.price < b.price ? 1 : -1))
      .slice(0, 4)
      .reduce((a, b) => a + b.price, 0) / 4;

  // Low diff between nightly prices and daily prices -> skip day discharge and set targetSoc accordingly
  if (tomorrowMostExpensiveMean - nightlyMeans[2] < 0.3) {
    // if we charge during night due to low prices set soc to 80%
    if (isCheapNightCharging) {
      targetSoc = 80;
      // else set soc to 50% and 2 charging hours to keep a backup in case of outage
    } else {
      targetSoc = 50;
      chargingHours = 2;
    }
    skipDayDischarge = true;
  } else {
    // small diff during night - charge 4 hours
    if (nightlyMeans[4] - nightlyMeans[2] < 0.1) {
      chargingHours = 4;
      // mid diff during night - charge 3 hours
    } else if (nightlyMeans[3] - nightlyMeans[2] < 0.05) {
      chargingHours = 3;
      // higher diff during night - charge 2 hours
    } else {
      chargingHours = 2;
    }

    // charge to 100% saturday -> sunday
    if (now.weekday === 6) {
      targetSoc = 100;
    } else {
      const meanCheapest =
        prices
          .slice(24)
          .sort((a, b) => (a.price > b.price ? 1 : -1))
          .slice(0, 3)
          .reduce((a, b) => a + b.price, 0) / 3;
      const meanMostExpensive =
        prices
          .slice(24)
          .sort((a, b) => (a.price < b.price ? 1 : -1))
          .slice(0, 7)
          .reduce((a, b) => a + b.price, 0) / 7;

      const diffLowHighPrice = meanMostExpensive - meanCheapest;

      if (diffLowHighPrice > 0.75) {
        targetSoc = 99;
      } else {
        targetSoc = 98;
      }
    }

    const chargeHours = sortedHours
      .slice(0, chargingHours)
      .sort((a, b) => (a.time > b.time ? 1 : -1));
    for (const [index, chargeHour] of chargeHours.entries()) {
      const currDate = DateTime.fromISO(chargeHour.time);
      const prevDate =
        index === 0 ? undefined : DateTime.fromISO(chargeHours[index - 1].time);
      const nextDate =
        index === chargeHours.length - 1
          ? undefined
          : DateTime.fromISO(chargeHours[index + 1].time);

      if (!prevDate || currDate.plus({ hours: -1 }) > prevDate) {
        await enqueue(
          {
            operation: Operation.StartCharge,
            power: chargingHoursPower[chargingHours],
            targetSoc,
          } as Message,
          DateTime.fromISO(chargeHour.time),
          false
        );
      }

      if (!nextDate || currDate.plus({ hours: 1 }) < nextDate) {
        await enqueue(
          {
            operation: Operation.StopCharge,
          } as Message,
          DateTime.fromISO(chargeHour.time).plus({ hours: 1 }),
          false
        );
      }
    }
    return skipDayDischarge;
  }
}

async function setDayChargeAndDischarge(prices: Price[]) {
  //    find cheapest hour between 10:00-16:00
  //    check hours from 06:00 up to cheapest hour, check hours from cheapest hour to 22:00
  //    check if at least 2 hours before and after thats at least 30 öre more expensive
  //    identify up to 3 hours before and up to 3 hours after that are at least 30 öre more expensive
  //    set discharge schedule with api
  //    add message to bus to charge at cheapest hour, targetsoc based on number of discharge hours after charge, max 90%
  //    add message to bus to stop charge 1 hour after cheapest hour
  const sortedPrices = prices
    .slice(34, 40)
    .sort((a, b) => (a.price > b.price ? 1 : -1));
  const cheapestDayPrice = sortedPrices[0];
  const cheapestHour = DateTime.fromISO(cheapestDayPrice.time).hour;

  const moreExpensiveBefore = prices
    .slice(30, 24 + cheapestHour)
    .filter((p) => p.price - cheapestDayPrice.price >= 0.3)
    .sort((a, b) => (a.price < b.price ? 1 : -1));
  const moreExpensiveAfter = prices
    .slice(24 + cheapestHour, 46)
    .filter((p) => p.price - cheapestDayPrice.price >= 0.3)
    .sort((a, b) => (a.price < b.price ? 1 : -1));

  if (moreExpensiveBefore.length < 2 || moreExpensiveAfter.length < 2) {
    return false;
  }

  await enqueue(
    {
      operation: Operation.StartCharge,
      power: 5000,
      targetSoc: 90,
    } as Message,
    DateTime.fromISO(cheapestDayPrice.time),
    false
  );
  await enqueue(
    {
      operation: Operation.StopCharge,
    } as Message,
    DateTime.fromISO(cheapestDayPrice.time).plus({ hours: 1 }),
    false
  );

  const dischargeHours = [
    ...moreExpensiveBefore
      .slice(0, 3)
      .sort((a, b) => (a.time > b.time ? 1 : -1)),
    ...moreExpensiveAfter
      .slice(0, 3)
      .sort((a, b) => (a.time > b.time ? 1 : -1)),
  ];

  for (const [index, dischargeHour] of dischargeHours.entries()) {
    const currDate = DateTime.fromISO(dischargeHour.time);
    const prevDate =
      index === 0
        ? undefined
        : DateTime.fromISO(dischargeHours[index - 1].time);
    const nextDate =
      index === dischargeHours.length - 1
        ? undefined
        : DateTime.fromISO(dischargeHours[index + 1].time);

    if (!prevDate || currDate.plus({ hours: -1 }) > prevDate) {
      await enqueue(
        {
          operation: Operation.StartDischarge,
        } as Message,
        DateTime.fromISO(dischargeHour.time),
        true
      );
    }

    if (!nextDate || currDate.plus({ hours: 1 }) < nextDate) {
      await enqueue(
        {
          operation: Operation.StopDischarge,
        } as Message,
        DateTime.fromISO(dischargeHour.time).plus({ hours: 1 }),
        false
      );
    }
  }
  return true;
}

async function setDayDischarge(prices) {
  //  find 4 most expensive hours between 06:00-22:00
  //  add message to bus to discharge at most expensive hours

  const dischargeHours = prices
    .slice(30, 46) // 06:00 to 22:00
    .sort((a, b) => (a.price < b.price ? 1 : -1))
    .slice(0, 4)
    .sort((a, b) => (a.time > b.time ? 1 : -1));
  for (const [index, dischargeHour] of dischargeHours.entries()) {
    const currDate = DateTime.fromISO(dischargeHour.time);
    const prevDate =
      index === 0
        ? undefined
        : DateTime.fromISO(dischargeHours[index - 1].time);
    const nextDate =
      index === dischargeHours.length - 1
        ? undefined
        : DateTime.fromISO(dischargeHours[index + 1].time);

    if (!prevDate || currDate.plus({ hours: -1 }) > prevDate) {
      await enqueue(
        {
          operation: Operation.StartDischarge,
        } as Message,
        DateTime.fromISO(dischargeHour.time),
        true
      );
    }

    if (!nextDate || currDate.plus({ hours: 1 }) < nextDate) {
      await enqueue(
        {
          operation: Operation.StopDischarge,
        } as Message,
        DateTime.fromISO(dischargeHour.time).plus({ hours: 1 }),
        false
      );
    }
  }
}
