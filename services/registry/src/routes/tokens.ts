import type { FastifyInstance } from 'fastify';
import { FloorApiError } from '@floors/shared-server';

export interface Token {
  asset_id: string;
  symbol: string;
  name: string;
  decimals: number;
  nep141_contract: string;
  pyth_feed: string;
  enabled: boolean;
}

const SUPPORTED_TOKENS: Token[] = [
  {
    asset_id: 'eth.near',
    symbol: 'ETH',
    name: 'Ethereum',
    decimals: 18,
    nep141_contract: 'aurora',
    pyth_feed: '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
    enabled: true,
  },
  {
    asset_id: 'sol.near',
    symbol: 'SOL',
    name: 'Solana',
    decimals: 9,
    nep141_contract: 'sol.bridge.near',
    pyth_feed: '0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
    enabled: true,
  },
  {
    asset_id: 'strk.near',
    symbol: 'STRK',
    name: 'Starknet',
    decimals: 18,
    nep141_contract: 'strk.bridge.near',
    pyth_feed: '0x6a182399ff70ccf3e06024898942028204125a819e519a335ffa4579e66cd870',
    enabled: true,
  },
];

const TOKEN_INDEX = new Map<string, Token>(
  SUPPORTED_TOKENS.map((t) => [t.asset_id, t]),
);

const REGISTRY_VERSION = 1;

export function registerTokenRoutes(app: FastifyInstance): void {
  app.get('/v1/tokens', async (_request, reply) => {
    return reply.status(200).send({
      version: REGISTRY_VERSION,
      tokens: SUPPORTED_TOKENS,
      published_at_ns: (BigInt(Date.now()) * BigInt(1_000_000)).toString(),
    });
  });

  app.get('/v1/tokens/:asset_id', async (request, reply) => {
    const { asset_id } = request.params as { asset_id: string };

    const token = TOKEN_INDEX.get(asset_id);
    if (token === undefined) {
      throw new FloorApiError(
        'ASSET_NOT_SUPPORTED',
        `Token ${asset_id} is not supported`,
        false,
        404,
      );
    }

    return reply.status(200).send(token);
  });
}
