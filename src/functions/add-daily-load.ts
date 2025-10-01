import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
  Timer,
} from '@azure/functions';
import { addLoadToDailyLoad } from '../util';
import { instrumentFunction } from '..';

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

const instrumentedAddDailyLoad = instrumentFunction(
  'addDailyLoadTimer',
  addDailyLoad
);
const instrumentedAddDailyLoadHttp = instrumentFunction(
  'addDailyLoadHttp',
  addDailyLoadHttp
);

app.timer('add-daily-load', {
  schedule: '0 55 * * * *',
  handler: instrumentedAddDailyLoad,
});

/* app.http('add-daily-load-debug', {
  methods: ['GET'],
  handler: chargeDischargeScheduleHttp,
}); */

async function handleFunction(context: InvocationContext) {
  await addLoadToDailyLoad();
}
