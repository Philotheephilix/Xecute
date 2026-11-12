import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { trace, type Tracer } from '@opentelemetry/api';
import { Resource } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

let sdk: NodeSDK | undefined;

export function initTracing(serviceName: string, version: string): void {
  const exporterEndpoint = process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];

  const resource = new Resource({
    [ATTR_SERVICE_NAME]: serviceName,
    [ATTR_SERVICE_VERSION]: version,
  });

  const traceExporter = exporterEndpoint !== undefined
    ? new OTLPTraceExporter({ url: exporterEndpoint })
    : undefined;

  sdk = new NodeSDK({
    resource,
    ...(traceExporter !== undefined ? { traceExporter } : {}),
    instrumentations: [getNodeAutoInstrumentations()],
  });

  sdk.start();

  process.on('SIGTERM', () => {
    sdk?.shutdown().catch((err: unknown) => {
      console.error('Error shutting down OTel SDK', err);
    });
  });
}

export function getTracer(name: string): Tracer {
  return trace.getTracer(name);
}
