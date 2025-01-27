import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
  Timer,
} from '@azure/functions';
import { getPrices } from '../prices';
import { Message, Operation } from '../message';
import { clearMessage, enqueue, getDischargeMessages } from '../service-bus';
import { DateTime } from 'luxon';
import { addToMessage, getNightChargeHours, SEK_THRESHOLD } from '../util';
import { getBatterySoc } from '../sungrow-api';

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
  //  check remaining discharge for the day
  //  get the charging hours for the night and calculate the mean
  //  remove any discharging when price is less than SEK_THRESHOLD more expensive than tonights charging mean
  //  keep most expensive discharge if soc is above 90%
  const prices = await getPrices();
  const dischargeMessages = await getDischargeMessages();
  if (dischargeMessages.length === 0) {
    return;
  }

  const [chargingHours, ,] = getNightChargeHours(prices, false);
  const chargingHoursMean =
    chargingHours.reduce((a, b) => a + b.price, 0) / chargingHours.length;

  const currentSoc = await getBatterySoc();

  for (const dischargeMessage of dischargeMessages) {
    await clearMessage(dischargeMessage.sequenceNumber);
  }

  let mostExpensiveDischarge = { price: 0 };
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
        if (dischargePrice.price - chargingHoursMean > SEK_THRESHOLD) {
          dischargeHours.push(dischargePrice);
        }

        if (dischargePrice.price > mostExpensiveDischarge.price) {
          mostExpensiveDischarge = dischargePrice;
        }
      }
    }
  }

  if (dischargeHours.length === 0 && currentSoc >= 0.9) {
    dischargeHours.push(mostExpensiveDischarge);
  }

  const messages: Record<string, Message> = {};
  addToMessage(
    dischargeHours,
    messages,
    { operation: Operation.StartDischarge } as Message,
    { operation: Operation.StopCharge } as Message
  );

  for (const [time, message] of Object.entries(messages)) {
    await enqueue(message, DateTime.fromISO(time));
  }
}

/*app.timer('monitor-prices', {
  schedule: '0 30 13 * * *',
  handler: monitorPrices,
});*/

/*app.http('monitor-prices-debug', {
  methods: ['GET'],
  handler: monitorPricesHttp,
});*/
