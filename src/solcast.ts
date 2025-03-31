import { DateTime } from 'luxon';
import { setForecast } from './data-tables';

export async function getProductionForecast(): Promise<{
  energy: number;
  startHour: number;
  endHour: number;
}> {
  const solcastResponse = await fetchSolcast();
  if (!solcastResponse) {
    return { energy: undefined, startHour: undefined, endHour: undefined };
  }

  const now = DateTime.now().setZone('Europe/Stockholm');
  let energy = 0;
  const filteredForecasts = solcastResponse.forecasts.filter((r) => {
    const time = DateTime.fromISO(r.period_end);
    return (
      +time.startOf('day') > +now.startOf('day') &&
      +now.plus({ days: 2 }).startOf('day') > +time.startOf('day')
    );
  });
  for (const forecast of filteredForecasts) {
    energy += 0.5 * forecast.pv_estimate;
  }

  const filteredProducingHours = filteredForecasts.filter(
    (r) => r.pv_estimate >= 1
  );
  const startHour =
    filteredForecasts.length > 0
      ? DateTime.fromISO(filteredProducingHours[0].period_end).setZone(
          'Europe/Stockholm'
        ).hour
      : undefined;
  const endHour =
    filteredForecasts.length > 0
      ? DateTime.fromISO(
          filteredProducingHours[filteredProducingHours.length - 1].period_end
        )
          .setZone('Europe/Stockholm')
          .plus({ minutes: -30 }).hour
      : undefined;

  await setForecast(energy, startHour, endHour);

  return { energy, startHour, endHour };
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
