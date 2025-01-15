import { DateTime } from 'luxon';

export interface Price {
  price: number;
  time: string;
}

export async function getPrices(date: DateTime): Promise<Price[]> {
  const prices = await fetchPrices(date);

  const mapped_prices = [];
  for (const price of prices) {
    mapped_prices.push({
      price: price.SEK_per_kWh,
      time: price.time_start,
    });
  }
  return mapped_prices;
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
