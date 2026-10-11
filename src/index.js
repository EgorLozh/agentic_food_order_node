'use strict';

/**
 * Точка входа: запуск Telegram-бота.
 * Заказ пишется кодом каркаса FeedMer (см. src/orders/pickupOrder.js).
 */

const fs = require('fs');
const path = require('path');

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

  const readyFile = path.resolve(__dirname, '..', '.bot-ready');
  try {
    fs.unlinkSync(readyFile);
  } catch (e) {
    /* файла нет — это нормально */
  }

  // ВАЖНО: у telegraf `startPolling()` возвращает loop(), который живёт весь срок работы бота,
  // поэтому await launch() не разрешается, пока бот не остановится. Готовность берём из onLaunch.
  bot
    .launch({ dropPendingUpdates: true }, () => {
      const info = { pid: process.pid, at: new Date().toISOString(), bot: bot.botInfo?.username };
      try {
        fs.writeFileSync(readyFile, JSON.stringify(info));
      } catch (e) {
        console.warn('не удалось записать файл готовности:', e.message);
      }
      console.log(
        `бот запущен: @${bot.botInfo?.username}, провайдер ${config.llm.provider}/${llm.model}, ` +
          `кафе по умолчанию ${
            config.order.defaultCafeId ?? 'берётся из выбранной точки'
          }, уведомления админу: ${config.bot.notifyAdmin && config.adminTelegramId ? 'вкл' : 'выкл'}`
      );
    })
    .catch((error) => {
      if (/409|Conflict/i.test(error.message)) {
        console.error(
          'Токен BOT_TOKEN уже слушает другая копия бота (Telegram 409 Conflict).\n' +
            'Останови её (например, Python-бота эталона — локально, в WSL или на сервере) ' +
            'или укажи в .env токен отдельного тестового бота и запусти снова.'
        );
        process.exit(3);
      }
      console.error('бот остановился с ошибкой:', error.message);
      process.exit(1);
    });

  const stop = (signal) => {
    console.log(`останавливаюсь (${signal})...`);
    try {
      fs.unlinkSync(readyFile);
    } catch (e) {
      /* уже нет */
    }
    bot.stop(signal);
  };
  process.once('SIGINT', () => stop('SIGINT'));
  process.once('SIGTERM', () => stop('SIGTERM'));
}

main().catch((error) => {
  console.error('не удалось запустить бота:', error.message);
  process.exit(1);
});
