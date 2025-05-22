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

app.timer('charge-discharge-schedule', {
  schedule: '0 55 * * * *',
  handler: addDailyLoad,
});

/* app.http('charge-discharge-schedule-debug', {
  methods: ['GET'],
  handler: chargeDischargeScheduleHttp,
}); */

async function handleFunction(context: InvocationContext) {
  await addLoadToDailyLoad();
}
