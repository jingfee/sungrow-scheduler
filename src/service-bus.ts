import {
  ServiceBusClient,
  ServiceBusMessage,
  ServiceBusReceivedMessage,
} from '@azure/service-bus';
import { Message, Operation } from './message';
import { DateTime } from 'luxon';

const serviceBusName = 'battery-queue';
const connectionString = process.env['ServiceBusConnectionString'];

const _client = new ServiceBusClient(connectionString);
const _sender = _client.createSender(serviceBusName);
const _receiver = _client.createReceiver(serviceBusName);

export async function enqueue(message: Message, scheduleTime: DateTime) {
  const sbMessage = { body: message } as ServiceBusMessage;
  await _sender.scheduleMessages(sbMessage, new Date(scheduleTime.toString()));
}

export async function clearAllMessages() {
  const sender = _client.createSender(serviceBusName);
  const peekedMessages = await _receiver.peekMessages(100);
  for (const peekedMessage of peekedMessages) {
    await sender.cancelScheduledMessages(peekedMessage.sequenceNumber);
  }
}

export async function getDischargeMessages(): Promise<
  ServiceBusReceivedMessage[]
> {
  const dischargeMessages = [];
  const peekedMessages = await _receiver.peekMessages(100);
  for (const peekedMessage of peekedMessages) {
    if (
      (peekedMessage.body as Message).operation === Operation.StartDischarge ||
      (peekedMessage.body as Message).operation === Operation.StopDischarge
    ) {
      dischargeMessages.push(peekedMessage);
    }
  }
  return dischargeMessages;
}

export async function clearMessage(sequenceNumber) {
  await _sender.cancelScheduledMessages(sequenceNumber);
}
