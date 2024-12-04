import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
  output,
} from '@azure/functions';
import { dequeue } from '../queue';

export async function schedulerhttp(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  await handleFunction(context);
  return { body: 'Created queue item.' };
}

async function handleFunction(context: InvocationContext) {
  const msg = await dequeue();
  context.log(JSON.stringify(msg));
}

/*app.timer('operation', {
  schedule: '0 0 0 * * *',
  handler: scheduler,
  extraOutputs: [queueOutput],
});*/

app.http('operation-debug', {
  methods: ['GET'],
  handler: schedulerhttp,
});
