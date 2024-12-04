import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
  Timer,
} from '@azure/functions';
import { findCheapestNightHours, getPrices, identifyPriceDip } from '../prices';
import { Message } from '../message';
import { enqueue } from '../queue';

export async function scheduler(
  myTimer: Timer,
  context: InvocationContext
): Promise<void> {
  await handleFunction(context);
}

export async function schedulerhttp(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  await handleFunction(context);
  return { body: 'Created queue item.' };
}

async function handleFunction(context: InvocationContext) {
  const prices = await getPrices();
  const cheapestNight = findCheapestNightHours(prices);
  const msg = {
    time: new Date().toISOString(),
  } as Message;
  await enqueue(msg);
}

app.timer('scheduler', {
  schedule: '0 0 0 * * *',
  handler: scheduler,
});

app.http('scheduler-debug', {
  methods: ['GET'],
  handler: schedulerhttp,
});
