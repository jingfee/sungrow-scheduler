import { app, InvocationContext } from '@azure/functions';

const serviceBusName = 'charging-queue';

export async function serviceBusTrigger(
  message: unknown,
  context: InvocationContext
): Promise<void> {
  context.log('Service bus queue function processed message:', message);
  context.log('EnqueuedTimeUtc =', context.triggerMetadata.enqueuedTimeUtc);
  context.log('DeliveryCount =', context.triggerMetadata.deliveryCount);
  context.log('MessageId =', context.triggerMetadata.messageId);
}

app.serviceBusQueue('service-bus-trigger', {
  connection: 'ServiceBusConnectionString',
  queueName: serviceBusName,
  handler: serviceBusTrigger,
});
