import { SEK_THRESHOLD } from './consts';
import { Message } from './message';
import { Price } from './prices';
import { DateTime } from 'luxon';

export function getNightChargeHours(prices: Price[]): Price[] {
  //  find cheapest 4, 5 and 6 hours between 22:00 - 06:00
  //  if any mean over cheapest hours is less than 10 öre, always charge those hours
  //  charge 6 hours if diff avg6 and avg4 less than 10 öre
  //  charge 5 hours if diff avg5 and avg4 less than 5 öre
  //  else charge 4 hours

  let chargingHours = 0;

  const sortedHours = prices
    .slice(22, 30) // 22:00 to 06:00 next day
    .sort((a, b) => (a.price > b.price ? 1 : -1));

  const nightlyMeans = {
    4: sortedHours.slice(0, 4).reduce((a, b) => a + b.price, 0) / 4,
    5: sortedHours.slice(0, 5).reduce((a, b) => a + b.price, 0) / 5,
    6: sortedHours.slice(0, 6).reduce((a, b) => a + b.price, 0) / 6,
  };

  // Price during night is cheap - charge no matter what
  for (let hour = 6; hour <= 4; hour--) {
    if (sortedHours[hour - 1].price < 0.1) {
      chargingHours = hour;
      break;
    }
  }

  if (chargingHours === 0) {
    // small diff during night - charge 4 hours
    if (nightlyMeans[6] - nightlyMeans[4] < 0.1) {
      chargingHours = 6;
      // mid diff during night - charge 3 hours
    } else if (nightlyMeans[5] - nightlyMeans[4] < 0.05) {
      chargingHours = 5;
      // higher diff during night - charge 2 hours
    } else {
      chargingHours = 4;
    }
  }

  const chargeHours = sortedHours
    .slice(0, chargingHours)
    .sort((a, b) => (a.time > b.time ? 1 : -1));

  return chargeHours;
}

export function getTargetSoc(
  prices: Price[],
  chargingHours: Price[],
  dischargeHours: number,
  shouldBalanceBatteryUpper: boolean
): number {
  // if no dischargehours set targetsoc to 80% if cheap charging, else 40%
  // if dischargehours < 3 set targetsoc to 60%
  // if balance battery set targetsoc 100%
  // targetsoc 99% if diff most expensive and cheapest hour is more than 75 öre
  // targetsoc 98% if diff most expensive and cheapest hour is less than 75 öre

  let targetSoc = 0;
  const chargingHoursMean =
    chargingHours.reduce((a, b) => a + b.price, 0) / chargingHours.length;

  // Low diff between nightly prices and daily prices -> skip day discharge and set targetSoc accordingly
  if (dischargeHours === 0) {
    // if we charge during night due to low prices set soc to 80%
    if (chargingHoursMean < 0.1) {
      targetSoc = 0.8;
      // else set soc to 40% to keep a backup in case of outage
    } else {
      targetSoc = 0.4;
    }
  } else if (dischargeHours < 3) {
    // if only 1 or 2 hour discharge only partially charge
    targetSoc = 0.6;
  } else {
    // charge to 100% saturday -> sunday
    if (shouldBalanceBatteryUpper) {
      targetSoc = 1;
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
        targetSoc = 0.99;
      } else {
        targetSoc = 0.98;
      }
    }
  }

  return targetSoc;
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

export function addToMessageWithRank(
  hoursDateSorted: Price[],
  rankings: Record<string, number>,
  messages: Record<string, Message>,
  startMessage: Message,
  stopMessage: Message
) {
  for (const [index, chargeHour] of hoursDateSorted.entries()) {
    const currDate = DateTime.fromISO(chargeHour.time);
    const nextDate =
      index === hoursDateSorted.length - 1
        ? undefined
        : DateTime.fromISO(hoursDateSorted[index + 1].time);

    messages[DateTime.fromISO(chargeHour.time).toISO()] = {
      ...startMessage,
      rank: rankings[chargeHour.time],
    } as Message;

    if (!nextDate || currDate.plus({ hours: 1 }) < nextDate) {
      messages[DateTime.fromISO(chargeHour.time).plus({ hours: 1 }).toISO()] =
        stopMessage;
    }
  }
}
