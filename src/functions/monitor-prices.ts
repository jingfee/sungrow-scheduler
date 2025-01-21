import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
  Timer,
} from '@azure/functions';
import { getNightChargeHours, getPrices } from '../prices';
import { Message, Operation } from '../message';
import { clearMessage, enqueue, getDischargeMessages } from '../service-bus';
import { DateTime } from 'luxon';

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

export async function handleFunction(context: InvocationContext) {
  // monitor-prices - at 14:30
  //1. check prices after publish
  //  check if avg of todays 15:00-22:00 most expensive hours are at least 30 öre more expensive than avg of tomorrow 00:00-06:00 5 cheapest hours
  //  if not remove rest of discharge
  //  peek messages - remove discharge messages
  const prices = await getPrices();
  const dischargeMessages = await getDischargeMessages();
  if (dischargeMessages.length === 0) {
    return;
  }

  const [chargingHours, ,] = getNightChargeHours(prices);
  const chargingHoursMean =
    chargingHours.reduce((a, b) => a + b.price, 0) / chargingHours.length;

  for (const dischargeMessage of dischargeMessages) {
    await clearMessage(dischargeMessage.sequenceNumber);
  }

  const dischargeHours = [];
  for (const [index, dischargeMessage] of dischargeMessages
    .sort((a, b) =>
      a.scheduledEnqueueTimeUtc > b.scheduledEnqueueTimeUtc ? 1 : -1
    )
    .entries()) {
    if (
      (dischargeMessage.body as Message).operation === Operation.StartDischarge
    ) {
      const chargeHours =
        dischargeMessages[index + 1].scheduledEnqueueTimeUtc.getHours() -
        dischargeMessage.scheduledEnqueueTimeUtc.getHours();

      for (let i = 0; i < chargeHours; i++) {
        const dischargePrice =
          prices[dischargeMessage.scheduledEnqueueTimeUtc.getHours() + i];
        if (dischargePrice.price - chargingHoursMean > 0.3) {
          dischargeHours.push(dischargePrice);
        }
      }
    }
  }

  const messages: Record<string, Message> = {};
  for (const [index, dischargeHour] of dischargeHours.entries()) {
    const currDate = DateTime.fromISO(dischargeHour.time);
    const prevDate =
      index === 0
        ? undefined
        : DateTime.fromISO(dischargeHours[index - 1].time);
    const nextDate =
      index === dischargeHours.length - 1
        ? undefined
        : DateTime.fromISO(dischargeHours[index + 1].time);

    if (!prevDate || currDate.plus({ hours: -1 }) > prevDate) {
      messages[DateTime.fromISO(dischargeHour.time).toISO()] = {
        operation: Operation.StartDischarge,
      } as Message;
    }

    if (!nextDate || currDate.plus({ hours: 1 }) < nextDate) {
      messages[
        DateTime.fromISO(dischargeHour.time).plus({ hours: 1 }).toISO()
      ] = {
        operation: Operation.StopDischarge,
      } as Message;
    }
  }

  for (const [time, message] of Object.entries(messages)) {
    await enqueue(message, DateTime.fromISO(time));
  }
}

app.timer('monitor-prices', {
  schedule: '0 30 13 * * *',
  handler: monitorPrices,
});

app.http('monitor-prices-debug', {
  methods: ['GET'],
  handler: monitorPricesHttp,
});
