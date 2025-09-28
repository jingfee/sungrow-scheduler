import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
  Timer,
} from '@azure/functions';
import { addLoadToDailyLoad } from '../util';

export async function addDailyLoad(
  myTimer: Timer,
  context: InvocationContext
): Promise<void> {
  await handleFunction(context);
}

export async function addDailyLoadHttp(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  await handleFunction(context);
  return { body: 'Complete' };
}

app.timer('add-daily-load', {
  schedule: '0 10,25,40,55 * * * *',
  handler: addDailyLoad,
});

/* app.http('add-daily-load-debug', {
  methods: ['GET'],
  handler: chargeDischargeScheduleHttp,
}); */

async function handleFunction(context: InvocationContext) {
  await addLoadToDailyLoad();
}
