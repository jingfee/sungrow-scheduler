import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
  Timer,
} from '@azure/functions';
import { getPrices } from '../prices';
import { Message, Operation } from '../message';
import {
  clearMessage,
  enqueue,
  getChargeAndDischargeMessages,
} from '../service-bus';
import { DateTime } from 'luxon';
import { addToMessageWithRank, getNightChargeHours } from '../util';
import { getBatterySoc } from '../sungrow-api';
import { SEK_THRESHOLD } from '../consts';
import { getStatus, Status } from '../data-tables';

export async function monitorPrices(
  myTimer: Timer,
  context: InvocationContext
): Promise<void> {
  await handleFunction(context);
}

export async function monitorPricesHttp(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  await handleFunction(context);
  return { body: 'Monitor prices complete' };
}

/* app.timer('monitor-prices', {
  schedule: '0 30 13 * * *',
  handler: monitorPrices,
}); */

/*app.http('monitor-prices-debug', {
  methods: ['GET'],
  handler: monitorPricesHttp,
});*/

export async function handleFunction(context: InvocationContext) {
  //  check remaining discharge for the day
  //  get the charging hours for the night and calculate the mean
  //  remove any discharging when price is less than SEK_THRESHOLD more expensive than tonights charging mean
  //  keep most expensive discharge if soc is above 90%
  const prices = await getPrices();
  const dischargeMessages = (await getChargeAndDischargeMessages())
    .dischargeMessages;
  if (dischargeMessages.length === 0) {
    return;
  }

  const status = await getStatus();
  if (status === Status.Discharging) {
  }

  // TODO: Handle if currently discharging
  for (const dischargeMessage of dischargeMessages) {
    context.log('Clearing message', JSON.stringify(dischargeMessage.body));
    await clearMessage(dischargeMessage.sequenceNumber);
  }

  const chargingHours = getNightChargeHours(prices);
  const chargingHoursMean =
    chargingHours.reduce((a, b) => a + b.price, 0) / chargingHours.length;

  let mostExpensiveDischarge = { price: 0 };
  const dischargeHours = [];
  for (const dischargeMessage of dischargeMessages.filter(
    (m) => (m.body as Message).operation === Operation.StartDischarge
  )) {
    const dischargePrice =
      prices[
        DateTime.fromJSDate(dischargeMessage.scheduledEnqueueTimeUtc, {
          zone: 'Europe/Stockholm',
        }).hour
      ];
    if (dischargePrice.price - chargingHoursMean > SEK_THRESHOLD) {
      dischargeHours.push(dischargePrice);
    }

    if (dischargePrice.price > mostExpensiveDischarge.price) {
      mostExpensiveDischarge = dischargePrice;
    }
  }

  // keep at least 1 discharge if soc is high
  if (dischargeHours.length === 0) {
    const currentSoc = await getBatterySoc();
    if (currentSoc >= 0.9) {
      dischargeHours.push(mostExpensiveDischarge);
    }
  }

  const minRankOfRemaningDischarge = (
    dischargeMessages
      .filter((m) => m.body.operation === Operation.StartDischarge)
      .sort((a, b) =>
        (a.body as Message).rank > (b.body as Message).rank ? 1 : -1
      )[0].body as Message
  ).rank;

  const rankings: Record<string, number> = {};
  for (const [index, hour] of [...dischargeHours]
    .sort((a, b) => (a.price < b.price ? 1 : -1))
    .entries()) {
    rankings[hour.time] = index + minRankOfRemaningDischarge;
  }

  const messages: Record<string, Message> = {};
  addToMessageWithRank(
    dischargeHours,
    rankings,
    messages,
    {
      operation: Operation.StartDischarge,
    } as Message,
    {
      operation: Operation.StopDischarge,
    } as Message
  );

  if (Object.keys(messages).length > 0) {
    const nextHourTime = DateTime.now()
      .setZone('Europe/Stockholm')
      .plus({ hours: 1 });
    const firstMessageHour = DateTime.fromISO(Object.keys(messages)[0]).hour;
    if (status === Status.Discharging && nextHourTime.hour < firstMessageHour) {
      messages[nextHourTime.startOf('hour').toISO()] = {
        operation: Operation.StopDischarge,
      } as Message;
    }
  }

  for (const [time, message] of Object.entries(messages)) {
    context.log('Adding message', time, JSON.stringify(message));
    await enqueue(message, DateTime.fromISO(time));
  }
}
