import pino from 'pino';
import { AsyncLocalStorage } from 'node:async_hooks';
import { context, trace } from '@opentelemetry/api';

export interface TraceContext {
  trace_id: string;
  span_id: string;
}

export const traceStorage = new AsyncLocalStorage<TraceContext>();

export interface LoggerConfig {
  service: string;
  version: string;
  level: string;
}

export function createLogger(config: LoggerConfig): pino.Logger {
  return pino({
    level: config.level,
    formatters: {
      level(label) {
        return { level: label };
      },
      log(object) {
        const traceCtx = traceStorage.getStore();
        if (traceCtx !== undefined) {
          return { ...object, trace_id: traceCtx.trace_id, span_id: traceCtx.span_id };
        }

        // Try to get trace context from OTel active context
        const activeSpan = trace.getActiveSpan();
        if (activeSpan !== undefined) {
          const spanCtx = activeSpan.spanContext();
          return { ...object, trace_id: spanCtx.traceId, span_id: spanCtx.spanId };
        }

        return object;
      },
    },
    base: {
      service: config.service,
      version: config.version,
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    messageKey: 'event',
  });
}
