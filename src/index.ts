import 'dotenv/config';
import { initDb } from './memory/sqlite.js';
import { onZeroBalance } from './llm/index.js';
import { initQdrant } from './memory/qdrant.js';
import { startGateway } from './gateway/index.js';
import { startTelegramConnector } from './channels/telegram/index.js';
import { startHeartbeat } from './heartbeat/index.js';

function registerZeroBalanceAlert(): void {
  onZeroBalance(async (provider) => {
    console.warn(`[llm] ${provider} has zero balance — switching to fallback provider`);
    const chatId = process.env['TELEGRAM_CHAT_ID'];
    const token = process.env['TELEGRAM_BOT_TOKEN'];
    if (!chatId || !token) return;
    try {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: `⚠️ OpenClaw: ${provider} API key has zero balance. Switched to fallback provider.`,
        }),
      });
    } catch (err) {
      console.error('[llm] failed to send zero-balance alert:', err);
    }
  });
}

async function main(): Promise<void> {
  initDb();
  console.log('[openclaw] database ready');

  registerZeroBalanceAlert();

  // Qdrant init is non-fatal — runs in background
  initQdrant().catch((err) => console.warn('[openclaw] Qdrant init failed (will retry on use):', err));

  startGateway();
  startHeartbeat();

  await startTelegramConnector();

  console.log('[openclaw] ready');
}

main().catch((err) => {
  console.error('[openclaw] fatal:', err);
  process.exit(1);
});
