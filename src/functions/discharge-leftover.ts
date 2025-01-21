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

async function handleFunction(context: InvocationContext) {
  // discharge-leftover - at 20:00, 21:00
  //5. check leftover charge
  //  if battery level > 25 and current price is at least 50 öre more expensive than avg of 2 cheapest night hours, add discharge schedule for next hour
  const prices = await getPrices();
  const soc = await getBatterySoc();
  if (parseFloat(soc) <= 0.24) {
    return;
  }

  const cheapestNightMean =
    prices
      .slice(22, 30)
      .sort((a, b) => (a.price > b.price ? 1 : -1))
      .slice(0, 2)
      .reduce((a, b) => a + b.price, 0) / 2;

  const currentHour = DateTime.now().hour;
  if (prices[currentHour].price - cheapestNightMean > 0.5) {
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

app.timer('discharge-leftover', {
  schedule: '0 0 19-20 * * *',
  handler: dischargeLeftover,
});

app.http('discharge-leftover-debug', {
  methods: ['GET'],
  handler: dischargeLeftoverHttp,
});
