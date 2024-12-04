import { QueueClient } from '@azure/storage-queue';
import { Message } from './message';
import { DateTime } from 'luxon';

const queueName = 'schedule';
const connectionString = process.env['AzureWebJobsSungrowSchedulerStorage'];

export async function enqueue(message: Message) {
  const queueClient = new QueueClient(connectionString, queueName);
  await queueClient.sendMessage(JSON.stringify(message));
}

export async function dequeue(): Promise<Message> {
  const queueClient = new QueueClient(connectionString, queueName);
  const now = DateTime.now().setZone('Europe/Stockholm');

  while (true) {
    const messages = await queueClient.receiveMessages();

    if (messages.receivedMessageItems.length === 0) {
      //no messages - return
      break;
    }

    const message = messages.receivedMessageItems[0];
    const parsedMessage = JSON.parse(message.messageText) as Message;
    const messageDate = DateTime.fromISO(parsedMessage.time).setZone(
      'Europe/Stockholm'
    );

    if (
      now.year === messageDate.year &&
      now.month === messageDate.month &&
      now.day === messageDate.day &&
      now.hour > messageDate.hour
    ) {
      //message is old - remove and check next message
      await queueClient.deleteMessage(message.messageId, message.popReceipt);
    } else if (
      now.year === messageDate.year &&
      now.month === messageDate.month &&
      now.day === messageDate.day &&
      now.hour === messageDate.hour
    ) {
      //message now - remove and return
      await queueClient.deleteMessage(message.messageId, message.popReceipt);
      return parsedMessage;
    } else {
      //message is for later - return
      break;
    }
  }
}
