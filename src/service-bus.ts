import { ServiceBusClient, ServiceBusMessage } from '@azure/service-bus';
import { Message } from './message';
import { DateTime } from 'luxon';

const serviceBusName = 'battery-queue';
const connectionString = process.env['ServiceBusConnectionString'];

export async function enqueue(
  message: Message,
  scheduleTime: DateTime,
  clearMessages: boolean
) {
  if (clearMessages) {
    await clearMessageAtTime(scheduleTime);
  }

  const client = new ServiceBusClient(connectionString);
  const sender = client.createSender(serviceBusName);
  try {
    const sbMessage = { body: message } as ServiceBusMessage;
    await sender.scheduleMessages(sbMessage, new Date(scheduleTime.toString()));
  } finally {
    sender.close();
    client.close();
  }
}

export async function clearAllMessages() {
  const client = new ServiceBusClient(connectionString);
  const receiver = client.createReceiver(serviceBusName);
  const sender = client.createSender(serviceBusName);
  try {
    const peekedMessages = await receiver.peekMessages(100);
    for (const peekedMessage of peekedMessages) {
      await sender.cancelScheduledMessages(peekedMessage.sequenceNumber);
    }
  } finally {
    receiver.close();
    sender.close();
    client.close();
  }
}

async function clearMessageAtTime(time: DateTime) {
  const client = new ServiceBusClient(connectionString);
  const receiver = client.createReceiver(serviceBusName);
  const sender = client.createSender(serviceBusName);
  try {
    const peekedMessages = await receiver.peekMessages(100);
    for (const peekedMessage of peekedMessages) {
      if (
        DateTime.fromJSDate(
          peekedMessage.scheduledEnqueueTimeUtc
        ).toMillis() === DateTime.fromISO(time).toMillis()
      ) {
        await sender.cancelScheduledMessages(peekedMessage.sequenceNumber);
      }
    }
  } finally {
    receiver.close();
    sender.close();
    client.close();
  }
}
