import { Bot } from 'grammy';
import { WebSocket } from 'ws';
import type { GatewayInboundMessage, GatewayOutboundMessage } from '../../types.js';
import { startTelegramMcpServer } from './mcp-server.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function connectWithRetry(url: string, maxAttempts = 10): Promise<WebSocket> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const ws = new WebSocket(url);
    try {
      await new Promise<void>((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
      });
      return ws;
    } catch {
      ws.terminate();
      if (attempt === maxAttempts) throw new Error(`Cannot connect to gateway at ${url}`);
      console.warn(`[telegram] gateway not ready, retrying in ${attempt}s...`);
      await sleep(1000 * attempt);
    }
  }
  throw new Error('Unreachable');
}

export async function startTelegramConnector(): Promise<void> {
  const token = process.env['TELEGRAM_BOT_TOKEN'];
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not set');

  const gatewayPort = process.env['GATEWAY_PORT'] ?? '8080';
  const ws = await connectWithRetry(`ws://localhost:${gatewayPort}`);

  const bot = new Bot(token);

  async function sendMessage(chatId: string, text: string): Promise<void> {
    await bot.api.sendMessage(Number(chatId), text);
  }

  // Receive responses from gateway and forward to Telegram
  ws.on('message', (data) => {
    void (async () => {
      try {
        const msg = JSON.parse(data.toString()) as GatewayOutboundMessage;
        if (msg.type === 'response') {
          await sendMessage(msg.channelId, msg.text);
        }
      } catch (err) {
        console.error('[telegram] error handling gateway response:', err);
      }
    })();
  });

  ws.on('error', (err) => console.error('[telegram] WebSocket error:', err));
  ws.on('close', () => console.warn('[telegram] gateway connection closed'));

  // Forward incoming Telegram messages to gateway
  bot.on('message:text', (ctx) => {
    const inbound: GatewayInboundMessage = {
      type: 'message',
      channel: 'telegram',
      channelId: String(ctx.chat.id),
      text: ctx.message.text,
    };
    ws.send(JSON.stringify(inbound));
  });

  // Start MCP server (for future tool-call path)
  await startTelegramMcpServer(sendMessage);

  // Start long polling (non-blocking — runs until process exits)
  bot.start().catch((err) => console.error('[telegram] bot error:', err));
  console.log('[telegram] connector started');
}
