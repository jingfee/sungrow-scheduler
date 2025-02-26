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
  setStopBatteryCharge,
  setStopBatteryDischarge,
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
  context.log('Handling message', JSON.stringify(message));
  switch (message.operation) {
    case Operation.StartCharge:
      await handleStartBatteryCharge(message);
      break;
    case Operation.StopCharge:
      await handleStopBatteryCharge(message);
      break;
    case Operation.StartDischarge:
      await handleStartBatteryDischarge(message, context);
      break;
    case Operation.StopDischarge:
      await handleStopBatteryDischarge();
      break;
  }
}

async function handleStartBatteryCharge(message: Message) {
  await setStartBatteryCharge(message.power, message.targetSoc);
  await setStatus(Status.Charging);
}

async function handleStopBatteryCharge(message: Message) {
  const soc = await getBatterySoc();
  await setStopBatteryCharge();

  await setLatestChargeSoc(soc * message.targetSoc);
  await setStatus(Status.Stopped);
}

async function handleStartBatteryDischarge(
  message: Message,
  context: InvocationContext
) {
  const dailyLoad = await getDailyLoad();
  const currentHour = DateTime.now().setZone('Europe/Stockholm').hour;
  const loadHourlyMean = dailyLoad / currentHour;

  const latestChargeSoc = await getLatestChargeSoc();
  const dischargeCapacity = (latestChargeSoc - MIN_SOC) * BATTERY_CAPACITY;

  const hours = Math.round(dischargeCapacity / loadHourlyMean);

  context.log(`Rank: ${message.rank} Hours: ${hours}`);
  if (message.rank != undefined && message.rank >= hours) {
    const dischargeMessages = await getDischargeMessages();
    const hasFutureDischargeWithLowerRank = dischargeMessages
      .filter((m) => (m.body as Message).operation === Operation.StartDischarge)
      .some((m) => m.body.rank < message.rank);
    if (hasFutureDischargeWithLowerRank) {
      await setStatus(Status.Stopped);
      return;
    }
  }

  context.log('Starting discharge');
  const now = DateTime.now().setZone('Europe/Stockholm');
  const startHour = now.hour;
  const endHour = now.plus({ hours: 1 }).hour;
  await setStartBatteryDischarge(startHour, endHour);
  await setStatus(Status.Discharging);
}

async function handleStopBatteryDischarge() {
  await setStopBatteryDischarge();
  await setStatus(Status.Stopped);
}
