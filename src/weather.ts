import { DateTime } from 'luxon';

export async function getLowestNightTemperature(): Promise<number> {
  const weatherResponse = await fetchWeather();
  if (!weatherResponse) {
    return -10;
  }
  const nightTemperatures = weatherResponse.timeSeries
    .filter((ts) => {
      const date = DateTime.fromISO(ts.validTime);
      const now = DateTime.now();
      return (
        (date.hasSame(now, 'day') && date.hour >= 22) ||
        (date.startOf('day') > now.startOf('day') &&
          date.hour >= 0 &&
          date.hour <= 5)
      );
    })
    .map((ts) => ts.parameters.find((p) => p.name === 't').values[0]);
  return Math.min(...nightTemperatures);
}

async function fetchWeather() {
  const url =
    'https://opendata-download-metfcst.smhi.se/api/category/pmp3g/version/2/geotype/point/lon/18.1016/lat/59.1170/data.json';

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
