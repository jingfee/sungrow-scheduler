import {
  BATTERY_CAPACITY,
  LOAD_HOURS_TO_SAVE,
  MIN_SOC,
  UNRANKED_DISCHARGE_QUARTERS,
} from './consts';
import { getLatestDailyLoads, setLatestDailyLoads } from './data-tables';
import { Message, Operation } from './message';
import { Price } from './prices';
import { DateTime } from 'luxon';
import { getDailyLoad } from './sungrow-api';

export function getNightChargeQuarters(prices: Price[]): Price[] {
  //  find cheapest 4, 5 and 6 hours between 22:00 - 06:00
  //  if any mean over cheapest hours is less than 10 öre, always charge those hours
  //  charge 6 hours if diff avg6 and avg4 less than 10 öre
  //  charge 5 hours if diff avg5 and avg4 less than 5 öre
  //  else charge 4 hours

  const maxChargeQuarters = 6 * 4; // 6 hours, 4 quarters per hour

  let chargingQuarters = 0;

  const sortedQuarters = prices
    .slice(22 * 4, 30 * 4) // 22:00 to 06:00 next day
    .sort((a, b) => (a.price > b.price ? 1 : -1));

  const nightlyMeans = {
    4:
      sortedQuarters.slice(0, 4 * 4).reduce((a, b) => a + b.price, 0) / (4 * 4),
    5:
      sortedQuarters.slice(0, 5 * 4).reduce((a, b) => a + b.price, 0) / (5 * 4),
    6:
      sortedQuarters.slice(0, 6 * 4).reduce((a, b) => a + b.price, 0) / (6 * 4),
  };

  // Price during night is cheap - charge no matter what
  for (
    let quarter = maxChargeQuarters;
    quarter <= maxChargeQuarters - 2 * 4;
    quarter--
  ) {
    if (sortedQuarters[quarter - 1].price < 0.1) {
      chargingQuarters = quarter;
      break;
    }
  }

  if (chargingQuarters === 0) {
    // small diff during night - charge 6 hours
    if (nightlyMeans[6] - nightlyMeans[4] < 0.1) {
      chargingQuarters = maxChargeQuarters;
      // mid diff during night - charge 5 hours
    } else if (nightlyMeans[5] - nightlyMeans[4] < 0.05) {
      chargingQuarters = maxChargeQuarters - 4;
      // higher diff during night - charge 4 hours
    } else {
      chargingQuarters = maxChargeQuarters - 8;
    }
  }

  const chargeQuarters = sortedQuarters
    .slice(0, chargingQuarters)
    .sort((a, b) => (a.time > b.time ? 1 : -1));

  return chargeQuarters;
}

export async function getTargetSoc(
  prices: Price[],
  chargingQuarters: Price[],
  dischargeQuarters: number,
  shouldBalanceBatteryUpper: boolean
): Promise<number> {
  // if no dischargequartesr set targetsoc to 80% if cheap charging, else 40%
  // if dischargequarters < 3*4 set targetsoc to 60%
  // if balance battery set targetsoc 100%
  // targetsoc 99% if diff most expensive and cheapest quarter is more than 75 öre
  // targetsoc 98% if diff most expensive and cheapest quarter is less than 75 öre

  let targetSoc = 0;

  // Low diff between nightly prices and daily prices -> skip day discharge and set targetSoc accordingly
  if (dischargeQuarters > 0) {
    const energyPerQuarter = await getLoadQuarterlyMean();
    const totalEnergy = energyPerQuarter * dischargeQuarters;
    targetSoc = Math.min(
      (BATTERY_CAPACITY * MIN_SOC + totalEnergy) / BATTERY_CAPACITY,
      1
    );

    if (targetSoc >= 1) {
      // charge to 100% saturday -> sunday
      if (shouldBalanceBatteryUpper) {
        targetSoc = 1;
      } else {
        // mean of tomorrows 12 cheapest quarters
        const meanCheapest =
          (prices
            .slice(24 * 4)
            .sort((a, b) => (a.price > b.price ? 1 : -1))
            .slice(0, 3 * 4)
            .reduce((a, b) => a + b.price, 0) /
            3) *
          4;
        // mean of tomorrows 28 most expensive quarters
        const meanMostExpensive =
          (prices
            .slice(24 * 4)
            .sort((a, b) => (a.price < b.price ? 1 : -1))
            .slice(0, 7 * 4)
            .reduce((a, b) => a + b.price, 0) /
            7) *
          4;

        const diffLowHighPrice = meanMostExpensive - meanCheapest;

        if (diffLowHighPrice > 0.75) {
          targetSoc = 0.99;
        } else {
          targetSoc = 0.98;
        }
      }
    }
  }

  const chargingQuartersMean =
    chargingQuarters.reduce((a, b) => a + b.price, 0) / chargingQuarters.length;
  // if we charge during night due to low prices set soc to min 80%
  // else set soc to min 30% to keep a backup in case of outage
  targetSoc = Math.max(chargingQuartersMean < 0.1 ? 0.8 : 0.3, targetSoc);

  if (!isWinter()) {
    // if not winter - charge to max 80% since we will get some sun the next day as well
    targetSoc = Math.min(0.8, targetSoc);
  }

  return targetSoc;
}

export function isSummer() {
  const now = DateTime.now().setZone('Europe/Stockholm');

  if ([5, 6, 7, 8].includes(now.month)) {
    return true;
  } else if (now.month === 4) {
    return now.day >= 10;
  } else {
    return false;
  }
}

export function isWinter() {
  const now = DateTime.now().setZone('Europe/Stockholm');

  if ([11, 12, 1, 2].includes(now.month)) {
    return true;
  } else if (now.month === 10) {
    return now.day >= 10;
  } else if (now.month === 3) {
    return now.day < 10;
  } else {
    return false;
  }
}

export function addToMessage(
  prices: Price[],
  messages: Record<string, Message>,
  startMessage: Message,
  stopMessage: Message
) {
  for (const [index, price] of prices.entries()) {
    const currDate = DateTime.fromISO(price.time);
    const prevDate =
      index === 0 ? undefined : DateTime.fromISO(prices[index - 1].time);
    const nextDate =
      index === prices.length - 1
        ? undefined
        : DateTime.fromISO(prices[index + 1].time);

    if (!prevDate || currDate.plus({ minutes: -15 }) > prevDate) {
      messages[DateTime.fromISO(price.time).toISO()] = startMessage;
    }

    if (!nextDate || currDate.plus({ minutes: 15 }) < nextDate) {
      messages[DateTime.fromISO(price.time).plus({ minutes: 15 }).toISO()] =
        stopMessage;
    }
  }
}

export function addToMessageWithRank(
  prices: Price[],
  rankings: Record<string, number>,
  messages: Record<string, Message>,
  startMessage: Message,
  stopMessage: Message
) {
  for (const [index, price] of prices.entries()) {
    const currDate = DateTime.fromISO(price.time);
    const nextDate =
      index === prices.length - 1
        ? undefined
        : DateTime.fromISO(prices[index + 1].time);

    messages[DateTime.fromISO(price.time).toISO()] = {
      ...startMessage,
      rank: rankings[price.time],
    } as Message;

    if (!nextDate || currDate.plus({ minutes: 15 }) < nextDate) {
      messages[DateTime.fromISO(price.time).plus({ minutes: 15 }).toISO()] =
        stopMessage;
    }
  }
}

export function setUnrankedDischargeBefore(
  messages: Record<string, Message>,
  dischargeStartTime: DateTime
) {
  for (let i = -1 * UNRANKED_DISCHARGE_QUARTERS; i < 0; i++) {
    const time = dischargeStartTime
      .setZone('Europe/Stockholm')
      .plus({ minutes: i * 15 });
    messages[time.toISO()] = {
      operation: Operation.StartDischarge,
    } as Message;
  }
  // Stop-message 1 minute before to avoid conflict with setdischargeaftersolar-message
  const time = dischargeStartTime
    .setZone('Europe/Stockholm')
    .plus({ minutes: -1 });
  messages[time.toISO()] = {
    operation: Operation.StopDischarge,
  } as Message;
}

export function setUnrankedDischargeAfter(messages: Record<string, Message>) {
  const stopDischarge =
    Object.entries(messages)[Object.keys(messages).length - 1];
  if (stopDischarge[1].operation === Operation.StopDischarge) {
    delete messages[stopDischarge[0]];
  }

  for (let i = 0; i < UNRANKED_DISCHARGE_QUARTERS; i++) {
    const time = DateTime.fromISO(stopDischarge[0])
      .setZone('Europe/Stockholm')
      .plus({ minutes: i * 15 });
    messages[time.toISO()] = { operation: Operation.StartDischarge } as Message;
  }
  const time = DateTime.fromISO(stopDischarge[0])
    .setZone('Europe/Stockholm')
    .plus({ minutes: UNRANKED_DISCHARGE_QUARTERS * 15 });
  messages[time.toISO()] = {
    operation: Operation.StopDischarge,
  } as Message;
}

export async function addLoadToDailyLoad() {
  const now = DateTime.now().setZone('Europe/Stockholm');
  const savedLoads = await getLatestDailyLoads();
  const load = await getDailyLoad();
  savedLoads.push({ value: load, timestamp: now.toISO() });
  if (savedLoads.length > LOAD_HOURS_TO_SAVE) {
    savedLoads.splice(0, 1);
  }
  await setLatestDailyLoads(savedLoads);
}

export async function getLoadQuarterlyMean() {
  const savedLoads = await getLatestDailyLoads();
  const first = savedLoads[0];
  const last = savedLoads[savedLoads.length - 1];

  const firstDateTime = DateTime.fromISO(first.timestamp);
  const lastDateTime = DateTime.fromISO(last.timestamp);
  const diffMinutes = lastDateTime.diff(firstDateTime, 'minutes').minutes;

  const diffLoad = last.value - first.value;

  const loadPerMinute = diffLoad / diffMinutes;

  return Math.round(loadPerMinute * 15);
}
