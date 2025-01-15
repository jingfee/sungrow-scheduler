import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
  Timer,
} from '@azure/functions';
import { getPrices, Price } from '../prices';
import { Message, Operation } from '../message';
import { enqueue } from '../service-bus';
import { DateTime } from 'luxon';
import { get_battery_soc } from '../sungrow-api';

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
  const soc = await get_battery_soc();
  context.log(soc);
  //1. set night charging - at 23:00
  //  find cheapest 2, 3 and 4 hours
  //  if avg4 is less than 10 öre, always charge 4 hours
  //  else
  //    calc avg of those sets of hours
  //    diff avg of tomorrow 4 most expensive hours and night 2 cheapest hours
  //    if diff < 30 öre, set targetsoc to 50% and skip day discharge else full charge and allow day discharge
  //    charge 4 hours if diff avg4 and avg2 less than 10 öre
  //    charge 3 hours if diff avg3 and avg2 less than 5 öre
  //    else charge 2 hours
  //  targetsoc 100% if saturday -> sunday
  //  targetsoc 99% if diff most expensive and cheapest hour is more than 75 öre
  //  targetsoc 98% if diff most expensive and cheapest hour is less than 75 öre
  //  add message to bus to charge at cheapest hours, targetsoc according to above, chargehours
  //  add message to bus to stop charge selected hours after each hour (if not continous charging)
  //2. day discharge + day charge - if not skipping discharge - at 23:00
  //    find cheapest hour between 10:00-16:00
  //    check hours from 06:00 up to cheapest hour, check hours from cheapest hour to 23:00
  //    check if at least 2 hours before and after thats at least 30 öre more expensive
  //    identify up to 3 hours before and up to 3 hours after that are at least 30 öre more expensive
  //    set discharge schedule with api
  //    add message to bus to charge at cheapest hour, targetsoc based on number of discharge hours after charge, max 90%
  //    add message to bus to stop charge 1 hour after cheapest hour
  //3. day discharge - if not day charging and not skipping - at 23:00
  //  find 4 most expensive hours between 06:00-22:00
  //  set discharge schedule with api
  //4. check prices after publish - at 14:30
  //  check if avg of todays 15:00-23:00 most expensive hours are at least 30 öre more expensive than avg of tomorrow 00:00-06:00 5 cheapest hours
  //  if not remove rest of discharge with api
  //5. check leftover charge - at 21:00, 22:00, 23:00
  //  if battery level > 25 and current price is at least 50 öre more expensive than avg of 2 cheapest night hours, add discharge schedule for next hour
  //
  //
  //  when message from bus
  //  if charge
  //  set with api - compulsory, force charge, targetsoc, charge power
  //  chargepower based on target soc - current soc and number of charge hours, max 4 or 4,5 kw
  //  if stop charge
  //  set with api - self-consumption, force charge off
}

/*app.timer('charge-discharge', {
  schedule: '23 0 0 * * *',
  handler: scheduler,
});*/

app.http('scheduler-debug', {
  methods: ['GET'],
  handler: schedulerhttp,
});
