// index.ts
import { AzureFunctionsInstrumentation } from '@azure/functions-opentelemetry-instrumentation';
import {
  AzureMonitorLogExporter,
  AzureMonitorTraceExporter,
} from '@azure/monitor-opentelemetry-exporter';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { detectResources } from '@opentelemetry/resources';
import {
  LoggerProvider,
  SimpleLogRecordProcessor,
} from '@opentelemetry/sdk-logs';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { trace } from '@opentelemetry/api';

// 1. Detect environment resources (service.name, cloud info, etc.)
const resource = detectResources();

// 2. Create tracer provider with processor + exporter
const tracerProvider = new NodeTracerProvider({
  resource,
  spanProcessors: [new BatchSpanProcessor(new AzureMonitorTraceExporter())],
});
tracerProvider.register();

// 3. Setup logs
const loggerProvider = new LoggerProvider({ resource });
loggerProvider.addLogRecordProcessor(
  new SimpleLogRecordProcessor(new AzureMonitorLogExporter())
);

// 4. Register instrumentations (auto + Service Bus, HTTP, etc.)
registerInstrumentations({
  tracerProvider,
  loggerProvider,
  instrumentations: [
    getNodeAutoInstrumentations(),
    new AzureFunctionsInstrumentation(),
  ],
});

// 5. Global wrapper for all functions (Timer trigger not covered by instrumentation)
export function instrumentFunction<T extends (...args: any[]) => any>(
  name: string,
  fn: T
): T {
  const tracer = trace.getTracer('functions');

  return async function (...args: any[]) {
    const context = args[0];
    const span = tracer.startSpan(name, {
      attributes: {
        'faas.execution': context?.invocationId,
      },
    });

    try {
      return await fn(...args);
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: 2, message: (err as Error).message });
      throw err;
    } finally {
      span.end();
    }
  } as T;
}
