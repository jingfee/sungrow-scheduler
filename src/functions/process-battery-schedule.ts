import { app, InvocationContext } from '@azure/functions';
import { Message, Operation } from '../message';
import {
  setStartBatteryCharge,
  setStartBatteryDischarge,
  setStopBatteryChargeDischarge,
} from '../sungrow-api';

const serviceBusName = 'battery-queue';

export async function serviceBusTrigger(
  message: Message,
  context: InvocationContext
): Promise<void> {
  switch (message.operation) {
    case Operation.StartCharge:
      await setStartBatteryCharge(message.power, message.targetSoc);
    case Operation.StopCharge:
      await setStopBatteryChargeDischarge();
    case Operation.StartDischarge:
      await setStartBatteryDischarge();
    case Operation.StopDischarge:
      await setStopBatteryChargeDischarge();
  }
}

app.serviceBusQueue('service-bus-trigger', {
  connection: 'ServiceBusConnectionString',
  queueName: serviceBusName,
  handler: serviceBusTrigger,
});
