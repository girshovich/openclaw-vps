import { WebSocketServer } from 'ws';
import type { GatewayInboundMessage, GatewayOutboundMessage } from '../types.js';
import { runTurn } from '../runtime/index.js';
import { findOrCreateSession } from '../memory/sqlite.js';

export function startGateway(): WebSocketServer {
  const port = parseInt(process.env['GATEWAY_PORT'] ?? '8080', 10);
  const wss = new WebSocketServer({ port });

  wss.on('connection', (ws) => {
    ws.on('message', (data) => {
      void (async () => {
        try {
          const msg = JSON.parse(data.toString()) as GatewayInboundMessage;
          if (msg.type !== 'message') return;

          const sessionId = findOrCreateSession(msg.channel, msg.channelId);
          const text = await runTurn(sessionId, msg.text);

          const outbound: GatewayOutboundMessage = { type: 'response', channelId: msg.channelId, text };
          ws.send(JSON.stringify(outbound));
        } catch (err) {
          console.error('[gateway] error processing message:', err);
        }
      })();
    });

    ws.on('error', (err) => console.error('[gateway] client error:', err));
  });

  console.log(`[gateway] listening on port ${port}`);
  return wss;
}
