import { ServiceBusClient, ServiceBusMessage } from '@azure/service-bus';
import { Message } from './message';
import { DateTime } from 'luxon';

const serviceBusName = 'charging-queue';
const connectionString = process.env['ServiceBusConnectionString'];

export async function enqueue(message: Message, scheduleTime: DateTime) {
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
