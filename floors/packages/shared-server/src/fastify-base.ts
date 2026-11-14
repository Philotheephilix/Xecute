import Fastify, { type FastifyInstance, type FastifyBaseLogger } from 'fastify';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import type pino from 'pino';
import type { BaseConfig } from './config.js';
import { errorHandler } from './errors.js';

export type Logger = pino.Logger;

export type ReadyCheck = () => Promise<{ ready: boolean; reason?: string }>;

export async function createApp(config: BaseConfig, logger: Logger, readyCheck?: ReadyCheck): Promise<FastifyInstance> {
  // pino.Logger is structurally compatible with FastifyBaseLogger
  const app = Fastify({
    loggerInstance: logger as unknown as FastifyBaseLogger,
    genReqId: () => crypto.randomUUID(),
    requestIdHeader: 'x-request-id',
  });

  await app.register(helmet, {
    contentSecurityPolicy: false,
  });

  await app.register(cors, {
    origin: config.NODE_ENV === 'local' ? true : [
      /^chrome-extension:\/\//,
      /^https:\/\/mcp\.philotheephilix\.in$/,
      /^https:\/\/xecute\.philotheephilix\.in$/,
    ],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  });

  // Register error handler
  errorHandler(app);

  // Health check
  app.get('/health', async (_request, reply) => {
    return reply.status(200).send({
      status: 'ok',
      service: config.SERVICE_NAME,
      version: config.SERVICE_VERSION,
    });
  });

  // Ready check — services can supply a readyCheck callback to include deeper checks (e.g. DB)
  app.get('/ready', async (_request, reply) => {
    if (readyCheck) {
      const result = await readyCheck();
      if (!result.ready) {
        return reply.status(503).send({ status: 'not_ready', reason: result.reason ?? 'check_failed' });
      }
    }
    return reply.status(200).send({ status: 'ready' });
  });

  return app;
}
