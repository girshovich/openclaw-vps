import 'dotenv/config';
import { initDb } from './memory/sqlite.js';
import { onZeroBalance } from './llm/index.js';
import { startGateway } from './gateway/index.js';
import { startTelegramConnector } from './channels/telegram/index.js';

// Alert the user via Telegram when an API key hits zero balance.
// Uses a direct Telegram Bot API call to avoid circular dependencies.
function registerZeroBalanceAlert(): void {
  onZeroBalance(async (provider) => {
    console.warn(`[llm] ${provider} has zero balance — switching to fallback provider`);
    const chatId = process.env['TELEGRAM_CHAT_ID'];
    const token = process.env['TELEGRAM_BOT_TOKEN'];
    if (!chatId || !token) return;
    try {
      const url = `https://api.telegram.org/bot${token}/sendMessage`;
      await fetch(url, {
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

  startGateway();

  await startTelegramConnector();

  console.log('[openclaw] ready');
}

main().catch((err) => {
  console.error('[openclaw] fatal:', err);
  process.exit(1);
});
