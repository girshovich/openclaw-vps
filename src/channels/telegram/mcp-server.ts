import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from 'node:http';
import { z } from 'zod';

export type TelegramSendFn = (chatId: string, text: string) => Promise<void>;

export function createTelegramMcpServer(sendMessage: TelegramSendFn): McpServer {
  const server = new McpServer({ name: 'telegram', version: '1.0.0' });

  server.tool(
    'send_message',
    'Send a message to a Telegram chat',
    {
      chatId: z.string().describe('Telegram chat ID'),
      text: z.string().describe('Message text to send'),
    },
    async ({ chatId, text }) => {
      await sendMessage(chatId, text);
      return { content: [{ type: 'text' as const, text: 'Message sent' }] };
    },
  );

  return server;
}

export async function startTelegramMcpServer(sendMessage: TelegramSendFn): Promise<void> {
  const port = parseInt(process.env['TELEGRAM_MCP_PORT'] ?? '8081', 10);
  const mcpServer = createTelegramMcpServer(sendMessage);

  // Stateless transport: no session management needed for a single-tool server
  const transport = new StreamableHTTPServerTransport();
  // Cast needed: MCP SDK Transport interface is incompatible with exactOptionalPropertyTypes
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await mcpServer.connect(transport as any);

  const httpServer = createServer(async (req, res) => {
    await transport.handleRequest(req, res);
  });

  await new Promise<void>((resolve) => httpServer.listen(port, resolve));
  console.log(`[telegram-mcp] listening on port ${port}`);
}
