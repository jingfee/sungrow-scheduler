import { Message } from './message';
import { Price } from './prices';
import { DateTime } from 'luxon';

export const SEK_THRESHOLD = parseFloat(process.env['SEK_THRESHOLD']);

export function getNightChargeHours(
  prices: Price[],
  shouldBalanceBatteryUpper: boolean
): [Price[], number, boolean] {
  let isCheapNightCharging = false;
  let skipDayDischarge = false;
  let chargingHours = 0;
  let targetSoc = 0;

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
  if (tomorrowMostExpensiveMean - nightlyMeans[2] < SEK_THRESHOLD) {
    // if we charge during night due to low prices set soc to 80% (if not saturday -> sunday then charge 100%)
    if (isCheapNightCharging) {
      targetSoc = shouldBalanceBatteryUpper ? 100 : 80;
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
    if (shouldBalanceBatteryUpper) {
      targetSoc = 100;
    } else {
      // mean of tomorrows 3 cheapest hours
      const meanCheapest =
        prices
          .slice(24)
          .sort((a, b) => (a.price > b.price ? 1 : -1))
          .slice(0, 3)
          .reduce((a, b) => a + b.price, 0) / 3;
      // mean of tomorrows 7 most expensive hours
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
  }

  const chargeHours = sortedHours
    .slice(0, chargingHours)
    .sort((a, b) => (a.time > b.time ? 1 : -1));

  return [chargeHours, targetSoc, skipDayDischarge];
}

export function addToMessage(
  hours: Price[],
  messages: Record<string, Message>,
  startMessage: Message,
  stopMessage: Message
) {
  for (const [index, chargeHour] of hours.entries()) {
    const currDate = DateTime.fromISO(chargeHour.time);
    const prevDate =
      index === 0 ? undefined : DateTime.fromISO(hours[index - 1].time);
    const nextDate =
      index === hours.length - 1
        ? undefined
        : DateTime.fromISO(hours[index + 1].time);

    if (!prevDate || currDate.plus({ hours: -1 }) > prevDate) {
      messages[DateTime.fromISO(chargeHour.time).toISO()] = startMessage;
    }

    if (!nextDate || currDate.plus({ hours: 1 }) < nextDate) {
      messages[DateTime.fromISO(chargeHour.time).plus({ hours: 1 }).toISO()] =
        stopMessage;
    }
  }
}
