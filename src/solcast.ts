import { DateTime } from 'luxon';
import { setForecast } from './data-tables';
import { InvocationContext } from '@azure/functions';

export async function getProductionForecast(
  context: InvocationContext
): Promise<{
  energy: number;
  batteryEnergy: number;
  startTime: DateTime;
  endTime: DateTime;
}> {
  const solcastResponse = await fetchSolcast();
  if (!solcastResponse) {
    return {
      energy: undefined,
      batteryEnergy: undefined,
      startTime: undefined,
      endTime: undefined,
    };
  }

  const now = DateTime.now().setZone('Europe/Stockholm');
  let energy = 0;
  let batteryEnergy = 0;
  const filteredForecasts = solcastResponse.forecasts.filter((r) => {
    const time = DateTime.fromISO(r.period_end);
    return (
      +time.startOf('day') > +now.startOf('day') &&
      +now.plus({ days: 2 }).startOf('day') > +time.startOf('day')
    );
  });
  context.log(
    `Solcast first tomorrow: ${JSON.stringify(filteredForecasts[0])}`
  );
  context.log(
    `Solcast last tomorrow: ${JSON.stringify(
      filteredForecasts[filteredForecasts.length - 1]
    )}`
  );
  for (const forecast of filteredForecasts) {
    energy += 0.5 * forecast.pv_estimate;
    if (forecast.pv_estimate > 1.5) {
      batteryEnergy += 0.5 * (forecast.pv_estimate - 1.5);
    }
  }

  const filteredProducingHours = filteredForecasts.filter(
    (r) => r.pv_estimate >= 1.5
  );
  context.log(
    `Solcast first producing: ${JSON.stringify(filteredProducingHours[0])}`
  );
  context.log(
    `Solcast last producing: ${JSON.stringify(
      filteredForecasts[filteredProducingHours.length - 1]
    )}`
  );
  const startTime =
    filteredForecasts.length > 0
      ? DateTime.fromISO(filteredProducingHours[0].period_end).setZone(
          'Europe/Stockholm'
        )
      : undefined;
  const endTime =
    filteredForecasts.length > 0
      ? DateTime.fromISO(
          filteredProducingHours[filteredProducingHours.length - 1].period_end
        )
          .setZone('Europe/Stockholm')
          .plus({ hours: -1 })
      : undefined;

  context.log(`Solcast start time: ${startTime}`);
  context.log(`Solcast end time: ${endTime}`);

  await setForecast(energy, batteryEnergy, startTime, endTime);

  return { energy, batteryEnergy, startTime, endTime };
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
