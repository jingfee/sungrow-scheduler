import {
  BATTERY_CAPACITY,
  CHARGE_ENERGY_PER_HOUR,
  LOAD_HOURS_TO_SAVE,
  MIN_SOC,
  UNRANKED_DISCHARGE_HOURS,
} from './consts';
import { getLatestDailyLoads, setLatestDailyLoads } from './data-tables';
import { Message, Operation } from './message';
import { Price } from './prices';
import { DateTime } from 'luxon';
import { getDailyLoad } from './sungrow-api';

export function getNightChargeHours(prices: Price[]): Price[] {
  //  find cheapest 4, 5 and 6 hours between 22:00 - 06:00
  //  if any mean over cheapest hours is less than 10 öre, always charge those hours
  //  charge 6 hours if diff avg6 and avg4 less than 10 öre
  //  charge 5 hours if diff avg5 and avg4 less than 5 öre
  //  else charge 4 hours

  const maxChargeHours = 6;

  let chargingHours = 0;

  const sortedHours = prices
    .slice(22, 30) // 22:00 to 06:00 next day
    .sort((a, b) => (a.price > b.price ? 1 : -1));

  const nightlyMeans = {
    2: sortedHours.slice(0, 2).reduce((a, b) => a + b.price, 0) / 2,
    3: sortedHours.slice(0, 3).reduce((a, b) => a + b.price, 0) / 3,
    4: sortedHours.slice(0, 4).reduce((a, b) => a + b.price, 0) / 4,
    5: sortedHours.slice(0, 5).reduce((a, b) => a + b.price, 0) / 5,
    6: sortedHours.slice(0, 6).reduce((a, b) => a + b.price, 0) / 6,
  };

  // Price during night is cheap - charge no matter what
  for (let hour = maxChargeHours; hour <= maxChargeHours - 2; hour--) {
    if (sortedHours[hour - 1].price < 0.1) {
      chargingHours = hour;
      break;
    }
  }

  if (chargingHours === 0) {
    // small diff during night - charge 4 hours
    if (nightlyMeans[maxChargeHours] - nightlyMeans[maxChargeHours - 2] < 0.1) {
      chargingHours = maxChargeHours;
      // mid diff during night - charge 3 hours
    } else if (
      nightlyMeans[maxChargeHours - 1] - nightlyMeans[maxChargeHours - 2] <
      0.05
    ) {
      chargingHours = maxChargeHours - 1;
      // higher diff during night - charge 2 hours
    } else {
      chargingHours = maxChargeHours - 2;
    }
  }

  const chargeHours = sortedHours
    .slice(0, chargingHours)
    .sort((a, b) => (a.time > b.time ? 1 : -1));

  return chargeHours;
}

export async function getTargetSoc(
  prices: Price[],
  chargingHours: Price[],
  dischargeHours: number,
  shouldBalanceBatteryUpper: boolean
): Promise<number> {
  // if no dischargehours set targetsoc to 80% if cheap charging, else 40%
  // if dischargehours < 3 set targetsoc to 60%
  // if balance battery set targetsoc 100%
  // targetsoc 99% if diff most expensive and cheapest hour is more than 75 öre
  // targetsoc 98% if diff most expensive and cheapest hour is less than 75 öre

  let targetSoc = 0;

  // Low diff between nightly prices and daily prices -> skip day discharge and set targetSoc accordingly
  if (dischargeHours > 0) {
    const energyPerHour = CHARGE_ENERGY_PER_HOUR;
    const totalEnergy = energyPerHour * dischargeHours;
    targetSoc = Math.min(
      (BATTERY_CAPACITY * MIN_SOC + totalEnergy) / BATTERY_CAPACITY,
      1
    );

    if (targetSoc >= 1) {
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
  }

  const chargingHoursMean =
    chargingHours.reduce((a, b) => a + b.price, 0) / chargingHours.length;
  // if we charge during night due to low prices set soc to 80%
  if (chargingHoursMean < 0.1) {
    targetSoc = Math.max(0.8, targetSoc);
    // else set soc to 30% to keep a backup in case of outage
  } else {
    targetSoc = Math.max(0.3, targetSoc);
  }

  return targetSoc;
}

export function isWinter() {
  const now = DateTime.now().setZone('Europe/Stockholm');
  return [1, 2, 11, 12].includes(now.month);
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

export function setUnrankedDischargeBefore(
  messages: Record<string, Message>,
  dischargeStartTime: DateTime
) {
  for (let i = -1 * UNRANKED_DISCHARGE_HOURS; i < 0; i++) {
    const time = dischargeStartTime
      .setZone('Europe/Stockholm')
      .plus({ hours: i });
    messages[time.toISO()] = { operation: Operation.StartDischarge } as Message;
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

  for (let i = 0; i < UNRANKED_DISCHARGE_HOURS; i++) {
    const time = DateTime.fromISO(stopDischarge[0])
      .setZone('Europe/Stockholm')
      .plus({ hours: i });
    messages[time.toISO()] = { operation: Operation.StartDischarge } as Message;
  }
  const time = DateTime.fromISO(stopDischarge[0])
    .setZone('Europe/Stockholm')
    .plus({ hours: UNRANKED_DISCHARGE_HOURS });
  messages[time.toISO()] = {
    operation: Operation.StopDischarge,
  } as Message;
}

export async function addLoadToDailyLoad() {
  const savedLoads = await getLatestDailyLoads();
  const load = await getDailyLoad();
  savedLoads.push(load);
  if (savedLoads.length > LOAD_HOURS_TO_SAVE) {
    savedLoads.splice(0, 1);
  }
  await setLatestDailyLoads(savedLoads);
}

export async function getLoadHourlyMean() {
  const savedLoads = await getLatestDailyLoads();
  let loadSums = 0;
  for (let i = 1; i < savedLoads.length; i++) {
    const prev = savedLoads[i - 1];
    const curr = savedLoads[i];
    // if new day add the new load, otherwise add the diff
    loadSums += prev > curr ? curr : curr - prev;
  }
  return loadSums / (savedLoads.length - 1);
}
