import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from '@azure/functions';
import { Message, Operation } from '../message';
import {
  getBatterySoc,
  getDailyLoad,
  setStartBatteryCharge,
  setStartBatteryDischarge,
  setStopBatteryChargeDischarge,
} from '../sungrow-api';
import { DateTime } from 'luxon';
import { getDischargeMessages } from '../service-bus';
import { getLatestChargeSoc, setLatestChargeSoc } from '../data-tables';
import { BATTERY_CAPACITY, MIN_SOC } from '../consts';

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
      await handleStopBatteryCharge();
    case Operation.StartDischarge:
      await handleBatteryDischarge(message);
    case Operation.StopDischarge:
      await setStopBatteryChargeDischarge();
  }
}

async function handleStopBatteryCharge() {
  await setStopBatteryChargeDischarge();
  const soc = await getBatterySoc();
  await setLatestChargeSoc(soc);
}

async function handleBatteryDischarge(message: Message) {
  const dailyLoad = await getDailyLoad();
  const currentHour = DateTime.now().setZone('Europe/Stockholm').hour;
  const loadHourlyMean = dailyLoad / currentHour;

  const latestChargeSoc = await getLatestChargeSoc();
  const dischargeCapacity = (latestChargeSoc - MIN_SOC) * BATTERY_CAPACITY;

  const hours = Math.round(dischargeCapacity / loadHourlyMean);

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
