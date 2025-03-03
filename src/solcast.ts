import { DateTime } from 'luxon';

export async function getProductionForecast(): Promise<number> {
  const solcastResponse = await fetchSolcast();
  if (!solcastResponse) {
    return 0;
  }

  const now = DateTime.now();
  let energy = 0;
  for (const forecast of solcastResponse.forecasts) {
    const time = DateTime.fromISO(forecast.period_end);
    if (+now.startOf('day') === +time.startOf('day')) {
      continue;
    }
    if (+now.plus({ days: 2 }).startOf('day') === +time.startOf('day')) {
      break;
    }

    energy += 0.5 * forecast.pv_estimate;
  }

  return energy;
}

async function fetchSolcast() {
  const url =
    'https://api.solcast.com.au/rooftop_sites/32f2-c16c-7cb0-ea39/forecasts?format=json';

  try {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${process.env['SolcastApiKey']}`,
      },
    });
    if (!response.ok) {
      return;
    }

    return await response.json();
  } catch (error: any) {
    console.error(error.message);
  }
}
