import { DateTime } from 'luxon';

export interface Price {
  price: number;
  time: string;
}

export async function getPrices(): Promise<Price[]> {
  const today = DateTime.now().setZone('Europe/Stockholm');
  const tomorrow = today.plus({ days: 1 });
  const priceToday = await fetchPrices(today);
  const priceTomorrow = await fetchPrices(tomorrow);
  const prices = [];
  for (const price of priceToday) {
    prices.push({
      price: price.SEK_per_kWh,
      time: price.time_start,
    });
  }
  if (priceTomorrow) {
    for (const price of priceTomorrow) {
      prices.push({
        price: price.SEK_per_kWh,
        time: price.time_start,
      });
    }
  }
  return prices;
}

async function fetchPrices(date: DateTime) {
  const year = date.year;
  const month = date.month;
  const day = date.day;
  const url = `https://www.elprisetjustnu.se/api/v1/prices/${year}/${String(
    month
  ).padStart(2, '0')}-${String(day).padStart(2, '0')}_SE3.json`;

  try {
    const response = await fetch(url);
    if (!response.ok) {
      return;
    }

    return await response.json();
  } catch (error: any) {
    console.error(error.message);
  }
}

export function getNightChargeHours(
  prices: Price[]
): [Price[], number, boolean] {
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

    return [chargeHours, targetSoc, skipDayDischarge];
  }
}
