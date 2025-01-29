import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
  Timer,
} from '@azure/functions';
import { getPrices } from '../prices';
import { Message, Operation } from '../message';
import { enqueue } from '../service-bus';
import { DateTime } from 'luxon';
import { getBatterySoc } from '../sungrow-api';
import { MIN_SOC } from '../consts';
import { getStatus, Status } from '../data-tables';
import { getNightChargeHours } from '../util';

export async function dischargeLeftover(
  myTimer: Timer,
  context: InvocationContext
): Promise<void> {
  await handleFunction(context);
}

export async function dischargeLeftoverHttp(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  await handleFunction(context);
  return { body: 'Discharge Leftover complete' };
}

app.timer('discharge-leftover', {
  schedule: '0 1 19-20 * * *',
  handler: dischargeLeftover,
});

/*app.http('discharge-leftover-debug', {
  methods: ['GET'],
  handler: dischargeLeftoverHttp,
});*/

async function handleFunction(context: InvocationContext) {
  //  if battery level > 25 and current price is at least 50 öre more expensive than night charge mean, add discharge schedule for next hour
  const prices = await getPrices();
  const soc = await getBatterySoc();
  if (soc <= MIN_SOC) {
    return;
  }

  const status = await getStatus();
  if (status === Status.Discharging) {
    return;
  }

  const chargingHours = getNightChargeHours(prices);
  const chargingHoursMean =
    chargingHours.reduce((a, b) => a + b.price, 0) / chargingHours.length;

  const currentHour = DateTime.now().setZone('Europe/Stockholm').hour;
  if (prices[currentHour].price - chargingHoursMean > 0.5) {
    await enqueue(
      {
        operation: Operation.StartDischarge,
      } as Message,
      DateTime.now()
    );

    await enqueue(
      {
        operation: Operation.StopDischarge,
      } as Message,
      DateTime.now().plus({ hours: 1 }).startOf('hour')
    );
  }
}
