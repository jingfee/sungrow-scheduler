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
import {
  getLatestChargeSoc,
  setLatestChargeSoc,
  setStatus,
  Status,
} from '../data-tables';
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
      await handleStartBatteryCharge(message);
    case Operation.StopCharge:
      await handleStopBatteryCharge();
    case Operation.StartDischarge:
      await handleStartBatteryDischarge(message);
    case Operation.StopDischarge:
      await handleStopBatteryDischarge();
  }
}

async function handleStartBatteryCharge(message: Message) {
  await setStartBatteryCharge(message.power, message.targetSoc);
  await setStatus(Status.Charging);
}

async function handleStopBatteryCharge() {
  await setStopBatteryChargeDischarge();
  await setStatus(Status.Stopped);
  // wait 10 seconds to allow max soc to change
  await sleep(10000);
  const soc = await getBatterySoc();
  await setLatestChargeSoc(soc);
}

function sleep(milliseconds: number) {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve('wakeup');
    }, milliseconds);
  });
}

async function handleStartBatteryDischarge(message: Message) {
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
      await setStatus(Status.Stopped);
      return;
    }
  }

  await setStartBatteryDischarge();
  await setStatus(Status.Discharging);
}

async function handleStopBatteryDischarge() {
  await setStopBatteryChargeDischarge();
  await setStatus(Status.Stopped);
}
