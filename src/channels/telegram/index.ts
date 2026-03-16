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

  // Register bot command menu (shows up when user taps "/" in Telegram)
  await bot.api.setMyCommands([
    { command: 'end',   description: 'End and archive the current session' },
    { command: 'new',   description: 'Start a fresh session' },
    { command: 'tasks', description: 'List active tasks' },
    { command: 'help',  description: 'Show available commands' },
  ]);

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

  // Helper to forward a fixed text to the gateway
  function forward(channelId: string, text: string): void {
    const inbound: GatewayInboundMessage = { type: 'message', channel: 'telegram', channelId, text };
    ws.send(JSON.stringify(inbound));
  }

  // Command handlers
  bot.command('end',   (ctx) => forward(String(ctx.chat.id), '/end'));
  bot.command('new',   (ctx) => forward(String(ctx.chat.id), '/new'));
  bot.command('tasks', (ctx) => forward(String(ctx.chat.id), '/tasks'));
  bot.command('help',  async (ctx) => {
    await ctx.reply(
      'Available commands:\n' +
      '/end — end and archive the current session\n' +
      '/new — start a fresh session\n' +
      '/tasks — list active tasks\n' +
      '/help — show this message',
    );
  });

  // Forward regular text messages to gateway (skip commands — handled above)
  bot.on('message:text', (ctx) => {
    if (ctx.message.text.startsWith('/')) return;
    forward(String(ctx.chat.id), ctx.message.text);
  });

  // Start MCP server (for future tool-call path)
  await startTelegramMcpServer(sendMessage);

  // Start long polling (non-blocking — runs until process exits)
  bot.start().catch((err) => console.error('[telegram] bot error:', err));
  console.log('[telegram] connector started');
}
