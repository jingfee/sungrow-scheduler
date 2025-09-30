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

// 4. Register instrumentations
registerInstrumentations({
  tracerProvider,
  loggerProvider,
  instrumentations: [
    getNodeAutoInstrumentations(),
    new AzureFunctionsInstrumentation(),
  ],
});
