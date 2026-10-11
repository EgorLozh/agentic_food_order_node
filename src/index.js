'use strict';

/**
 * Точка входа: запуск Telegram-бота.
 * Заказ пишется кодом каркаса FeedMer (см. src/orders/pickupOrder.js).
 */

const { config } = require('./config');
const { LLMClient } = require('./llm/client');
const { OrderAgent } = require('./llm/orderAgent');
const { OrderOrchestrator } = require('./bootstrap/orchestrator');
const { SessionStore } = require('./state/sessions');
const { BotService } = require('./bot/service');
const { createBot } = require('./bot/telegram');
const { createPickupOrder } = require('./orders/pickupOrder');

async function main() {
  if (!config.botToken) throw new Error('Не задан BOT_TOKEN (см. .env.example)');

  const llm = LLMClient.fromConfig(config.llm);
  const agent = new OrderAgent({ llm, deps: { submitOrder: createPickupOrder } });
  const orchestrator = new OrderOrchestrator({ agent });
  const sessions = new SessionStore({ historyLimit: config.agent.historyLimit });
  await sessions.init();

  const service = new BotService({ orchestrator, sessions });
  const bot = createBot({ token: config.botToken, service });

  if (config.bot.notifyAdmin && config.adminTelegramId) {
    service.notifier = async ({ orderId, total }) => {
      await bot.telegram.sendMessage(
        config.adminTelegramId,
        service.adminOrderText(orderId, total)
      );
    };
  } else if (config.bot.notifyAdmin) {
    console.warn('ORDER_NOTIFY_ADMIN=1, но ADMIN_TELEGRAM_ID не задан — уведомления выключены');
  }

  try {
    await bot.launch({ dropPendingUpdates: true });
  } catch (error) {
    if (/409|Conflict/i.test(error.message)) {
      console.error(
        'Токен BOT_TOKEN уже слушает другая копия бота (Telegram 409 Conflict).\n' +
          'Останови её (например, Python-бота эталона — локально, в WSL или на сервере) ' +
          'или укажи в .env токен отдельного тестового бота и запусти снова.'
      );
      process.exit(3);
    }
    throw error;
  }
  console.log(
    `бот запущен: провайдер ${config.llm.provider}/${llm.model}, кафе по умолчанию ${
      config.order.defaultCafeId ?? 'берётся из выбранной точки'
    }, уведомления админу: ${config.bot.notifyAdmin && config.adminTelegramId ? 'вкл' : 'выкл'}`
  );

  const stop = (signal) => {
    console.log(`останавливаюсь (${signal})...`);
    bot.stop(signal);
  };
  process.once('SIGINT', () => stop('SIGINT'));
  process.once('SIGTERM', () => stop('SIGTERM'));
}

main().catch((error) => {
  console.error('не удалось запустить бота:', error.message);
  process.exit(1);
});
