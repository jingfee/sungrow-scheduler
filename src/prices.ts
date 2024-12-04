import { DateTime } from 'luxon';

export interface Price {
  price: number;
  time: string;
}

const VATTENFALL_LOW = 0.16;
const VATTENFALL_HIGH = 0.536;

export function findCheapestNightHours(prices: Price[]) {
  const now = DateTime.now().setZone('Europe/Stockholm');
  const filteredPrices = prices.filter((p) => {
    const priceTime = DateTime.fromISO(p.time);
    return (
      (priceTime.day === now.day && priceTime.hour >= 22) ||
      (priceTime.day > now.day && priceTime.hour <= 6)
    );
  });
  filteredPrices.sort((a, b) => a.price - b.price);
  return filteredPrices.slice(0, 3);
}

export function identifyPriceDip(prices: Price[]): number[] {
  const now = DateTime.now().setZone('Europe/Stockholm');
  const filteredPrices = prices.filter((p) => {
    const priceTime = DateTime.fromISO(p.time);
    return priceTime.day === now.day;
  });

  // Steg 1: Beräkna medelpriset
  const avgPrice =
    filteredPrices.reduce((sum, price) => sum + price.price, 0) /
    filteredPrices.length;

  // Steg 2: Beräkna standardavvikelsen
  const variance =
    filteredPrices.reduce(
      (sum, price) => sum + Math.pow(price.price - avgPrice, 2),
      0
    ) / filteredPrices.length;
  const stdDev = Math.sqrt(variance);

  // Steg 3: Identifiera dippar baserat på standardavvikelse
  const dips = [];
  filteredPrices.forEach((price) => {
    if (price.price < avgPrice - 0.5 * stdDev) {
      dips.push(price); // Timmen identifieras som en dipp
    }
  });

  return dips; // Returnerar timmar med dippar
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

  addVattenfallPrices(prices);
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

function addVattenfallPrices(prices: Price[]): void {
  for (const price of prices) {
    const priceDate = DateTime.fromISO(price.time).setZone('Europe/Stockholm');
    const month = priceDate.month;
    let isLowPrice = true;

    if ([0, 1, 2, 10, 11].includes(month)) {
      const day = priceDate.day;
      if ([1, 2, 3, 4, 5].includes(day)) {
        const hour = priceDate.hour;

        if (hour >= 6 && hour <= 22) {
          isLowPrice = false;
        }
      }
    }

    if (isLowPrice) {
      price.price += VATTENFALL_LOW;
    } else {
      price.price += VATTENFALL_HIGH;
    }
  }
}
