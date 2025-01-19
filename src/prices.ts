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
