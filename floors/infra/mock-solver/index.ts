/**
 * mock-solver: minimal WebSocket server simulating a NEAR intent solver.
 *
 * Listens on ws://0.0.0.0:4040
 * - { type: "publish_intent" } → responds with a mock solution
 * - { type: "ping" } → responds { type: "pong" }
 */

import { WebSocketServer, type WebSocket } from 'ws';

const PORT = 4040;

const server = new WebSocketServer({ host: '0.0.0.0', port: PORT });

server.on('listening', () => {
  console.log(`[mock-solver] WebSocket server listening on ws://0.0.0.0:${PORT}`);
});

server.on('connection', (ws: WebSocket, req) => {
  const remoteAddr = req.socket.remoteAddress ?? 'unknown';
  console.log(`[mock-solver] Client connected from ${remoteAddr}`);

  ws.on('message', (raw) => {
    const text = raw.toString('utf8');
    console.log(`[mock-solver] Received: ${text}`);

    let msg: unknown;
    try {
      msg = JSON.parse(text) as unknown;
    } catch {
      console.warn('[mock-solver] Non-JSON message ignored');
      return;
    }

    if (!isRecord(msg)) return;

    if (msg['type'] === 'publish_intent') {
      const solution = {
        type: 'solution',
        signed_intent: {
          action: 'FtTransfer',
          nonce: 1,
          token_in: 'usdc.test.near',
          token_out: 'eth.test.near',
          amount_in: '1000000',
          amount_out: '500000000000000',
          receiver_id: 'alice.test.near',
          expiry_block_height: 9999999,
          signature: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        },
      };
      ws.send(JSON.stringify(solution));
      console.log('[mock-solver] Sent solution');
    } else if (msg['type'] === 'ping') {
      ws.send(JSON.stringify({ type: 'pong' }));
      console.log('[mock-solver] Sent pong');
    } else {
      console.warn(`[mock-solver] Unknown message type: ${String(msg['type'])}`);
    }
  });

  ws.on('close', () => {
    console.log(`[mock-solver] Client ${remoteAddr} disconnected`);
  });

  ws.on('error', (err) => {
    console.error(`[mock-solver] Error from ${remoteAddr}: ${err.message}`);
  });
});

server.on('error', (err) => {
  console.error(`[mock-solver] Server error: ${err.message}`);
  process.exit(1);
});

function isRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}
