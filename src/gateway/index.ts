import { WebSocketServer } from 'ws';
import type { GatewayInboundMessage, GatewayOutboundMessage, ChannelType } from '../types.js';
import { extractPhoto } from './photo-marker.js';
import { enqueue } from './lane-queue.js';
import { runTurn, BudgetExceededError } from '../runtime/index.js';
import { findOrCreateSession, createSession, getSessionHistory, updateSessionStatus, resetTaskRetries } from '../memory/sqlite.js';
import { classifySession } from '../runtime/classifier.js';
import { archiveSession } from '../runtime/archive.js';

async function resolveSession(
  channel: ChannelType,
  channelId: string,
  text: string,
): Promise<string> {
  const sessionId = findOrCreateSession(channel, channelId);
  const history = getSessionHistory(sessionId);

  // No history yet — use this session
  if (history.length === 0) return sessionId;

  // Build recent context for the classifier (last 6 messages)
  const recent = history
    .slice(-6)
    .map((m) => `${m.role}: ${m.content.slice(0, 100)}`)
    .join('\n');

  let decision: 'new' | 'continue';
  try {
    decision = await classifySession(recent, text);
  } catch {
    decision = 'continue'; // classifier failure → be conservative
  }

  if (decision === 'new') {
    await archiveSession(sessionId);
    return createSession({ channel, channelId });
  }

  return sessionId;
}

export function startGateway(): WebSocketServer {
  const port = parseInt(process.env['GATEWAY_PORT'] ?? '8080', 10);
  const wss = new WebSocketServer({ port });

  wss.on('connection', (ws) => {
    ws.on('message', (data) => {
      void (async () => {
        let channelId: string | undefined;
        try {
          const msg = JSON.parse(data.toString()) as GatewayInboundMessage;
          if (msg.type !== 'message') return;

          const { channel, text } = msg;
          channelId = msg.channelId;
          let sessionId: string;
          let responseText: string;

          if (text.trim() === '/end') {
            sessionId = findOrCreateSession(channel, channelId);
            await archiveSession(sessionId);
            responseText = 'Session ended and archived.';
          } else if (text.trim() === '/new') {
            const current = findOrCreateSession(channel, channelId);
            await archiveSession(current);
            sessionId = createSession({ channel, channelId });
            responseText = 'Started a new session.';
          } else {
            sessionId = await resolveSession(channel, channelId, text);
            resetTaskRetries(sessionId); // user replied → reset retry counters
            try {
              responseText = await enqueue(sessionId, () => runTurn(sessionId, text));
            } catch (err) {
              if (err instanceof BudgetExceededError) {
                responseText = `⚠️ ${err.message}`;
              } else {
                throw err;
              }
            }
          }

          // Update session to active on any message
          updateSessionStatus(sessionId, 'active');

          const { text: outText, photo } = extractPhoto(responseText);
          const outbound: GatewayOutboundMessage = {
            type: 'response',
            channelId,
            text: outText,
            ...(photo !== undefined && { photo }),
          };
          ws.send(JSON.stringify(outbound));
        } catch (err) {
          console.error('[gateway] error processing message:', err);
          if (channelId) {
            const errMsg = err instanceof Error ? err.message : String(err);
            const outbound: GatewayOutboundMessage = {
              type: 'response',
              channelId,
              text: `⚠️ Что-то пошло не так: ${errMsg}\n\nНачните новую сессию командой /new.`,
            };
            ws.send(JSON.stringify(outbound));
          }
        }
      })();
    });

    ws.on('error', (err) => console.error('[gateway] client error:', err));
  });

  console.log(`[gateway] listening on port ${port}`);
  return wss;
}
