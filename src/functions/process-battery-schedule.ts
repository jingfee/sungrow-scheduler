import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from '@azure/functions';
import { Message, Operation } from '../message';
import {
  getDailyLoad,
  setStartBatteryCharge,
  setStartBatteryDischarge,
  setStopBatteryChargeDischarge,
} from '../sungrow-api';
import { DateTime } from 'luxon';
import { getDischargeMessages } from '../service-bus';

const serviceBusName = 'battery-queue';

export async function serviceBusTrigger(
  message: Message,
  context: InvocationContext
): Promise<void> {
  await handleFunction(message, context);
}

export async function serviceBusTriggerHttp(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  await handleFunction({ operation: Operation.StartCharge, rank: 2 }, context);
  return { body: 'Discharge Leftover complete' };
}

app.serviceBusQueue('service-bus-trigger', {
  connection: 'ServiceBusConnectionString',
  queueName: serviceBusName,
  handler: serviceBusTrigger,
});

/*app.http('service-bus-trigger-debug', {
  methods: ['GET'],
  handler: serviceBusTriggerHttp,
});*/

async function handleFunction(message: Message, context: InvocationContext) {
  switch (message.operation) {
    case Operation.StartCharge:
      await setStartBatteryCharge(message.power, message.targetSoc);
    case Operation.StopCharge:
      await setStopBatteryChargeDischarge();
    case Operation.StartDischarge:
      await handleBatteryDischarge(message);
    case Operation.StopDischarge:
      await setStopBatteryChargeDischarge();
  }
}

async function handleBatteryDischarge(message: Message) {
  const dailyLoad = await getDailyLoad();
  const currentHour = DateTime.now().setZone('Europe/Stockholm').hour;
  const loadHourlyMean = dailyLoad / currentHour;

  const batteryCapacity = 7200;
  const hours = Math.round(batteryCapacity / loadHourlyMean);

  if (message.rank != undefined && message.rank >= hours) {
    const dischargeMessages = await getDischargeMessages();
    const hasFutureDischargeWithLowerRank = dischargeMessages.some(
      (m) => m.body.rank < message.rank
    );
    if (hasFutureDischargeWithLowerRank) {
      await setStopBatteryChargeDischarge();
      return;
    }
  }

  await setStartBatteryDischarge();
}
