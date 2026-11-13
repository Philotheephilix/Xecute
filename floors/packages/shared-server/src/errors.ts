import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export const ERROR_CODES = {
  QUOTE_EXPIRED: 'QUOTE_EXPIRED',
  QUOTE_USED: 'QUOTE_USED',
  QUOTE_SIG_INVALID: 'QUOTE_SIG_INVALID',
  RATE_LIMITED: 'RATE_LIMITED',
  NOT_FOUND: 'NOT_FOUND',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  ASSET_NOT_SUPPORTED: 'ASSET_NOT_SUPPORTED',
  INSUFFICIENT_FUNDS: 'INSUFFICIENT_FUNDS',
  ACCOUNT_NOT_FOUND: 'ACCOUNT_NOT_FOUND',
  RELAYER_ERROR: 'RELAYER_ERROR',
  SIMULATION_FAILED: 'SIMULATION_FAILED',
  INVALID_INVITE: 'INVALID_INVITE',
  FLOOR_QUOTE_UNAVAILABLE: 'FLOOR_QUOTE_UNAVAILABLE',
  UNAUTHORIZED: 'UNAUTHORIZED',
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    retryable: boolean;
    details: Record<string, unknown>;
  };
}

export class FloorApiError extends Error {
  public readonly code: ErrorCode;
  public readonly retryable: boolean;
  public readonly statusCode: number;
  public readonly details: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    retryable: boolean,
    statusCode: number,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'FloorApiError';
    this.code = code;
    this.retryable = retryable;
    this.statusCode = statusCode;
    this.details = details;
  }

  toEnvelope(): ErrorEnvelope {
    return {
      error: {
        code: this.code,
        message: this.message,
        retryable: this.retryable,
        details: this.details,
      },
    };
  }
}

export function errorHandler(fastify: FastifyInstance): void {
  fastify.setErrorHandler(
    (error: FastifyError | FloorApiError | Error, _request: FastifyRequest, reply: FastifyReply) => {
      if (error instanceof FloorApiError) {
        void reply.status(error.statusCode).send(error.toEnvelope());
        return;
      }

      // Fastify validation errors
      if ('validation' in error && error.validation !== undefined) {
        const envelope: ErrorEnvelope = {
          error: {
            code: ERROR_CODES.VALIDATION_ERROR,
            message: error.message,
            retryable: false,
            details: { validation: (error as FastifyError).validation ?? [] },
          },
        };
        void reply.status(400).send(envelope);
        return;
      }

      // Fastify status code errors
      const statusCode = 'statusCode' in error && typeof error.statusCode === 'number'
        ? error.statusCode
        : 500;

      const envelope: ErrorEnvelope = {
        error: {
          code: statusCode === 404 ? ERROR_CODES.NOT_FOUND : ERROR_CODES.INTERNAL_ERROR,
          message: error.message ?? 'An unexpected error occurred',
          retryable: statusCode >= 500,
          details: {},
        },
      };

      if (statusCode >= 500) {
        fastify.log.error({ err: error }, 'Unhandled error');
      }

      void reply.status(statusCode).send(envelope);
    },
  );
}
