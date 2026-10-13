'use strict';

/**
 * Диалог с ботом без Telegram: те же BotService + LLM, что у telegraf.
 * Нужен, чтобы быстро проверять формулировки, кнопки и новые правила после фидбэка.
 *
 * Запуск:
 *   node scripts/dialog.js "соус сырный" "Куриная Стандарт 320г" ...
 *   node scripts/dialog.js --cafe 68 --user 990000010 "реплика 1" "реплика 2"
 *
 * Печатает: реплика клиента → ответ бота → кнопки. Заказы НЕ удаляются (тестовые данные
 * в общей БД остаются, как договорились).
 */

const { config } = require('../src/config');
const { LLMClient } = require('../src/llm/client');
const { OrderAgent } = require('../src/llm/orderAgent');
const { OrderOrchestrator } = require('../src/bootstrap/orchestrator');
const { SessionStore } = require('../src/state/sessions');
const { BotService } = require('../src/bot/service');
const { createPickupOrder } = require('../src/orders/pickupOrder');

function parseArgs(argv) {
  const messages = [];
  let user = 990000009;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--user') {
      user = Number(argv[i + 1]);
      i += 1;
    } else if (argv[i] === '--cafe') {
      i += 1; // кафе берётся из точки самовывоза/дефолта — параметр оставлен для совместимости
    } else {
      messages.push(argv[i]);
    }
  }
  return { user, messages };
}

(async () => {
  const { user, messages } = parseArgs(process.argv.slice(2));
  if (!messages.length) {
    console.error('нужны реплики: node scripts/dialog.js "текст" "текст"');
    process.exit(2);
  }

  let llm;
  try {
    llm = LLMClient.fromConfig(config.llm);
  } catch (e) {
    console.error(`DIALOG: ${e.message}`);
    process.exit(2);
  }

  const sessions = new SessionStore({ historyLimit: config.agent.historyLimit });
  const service = new BotService({
    orchestrator: new OrderOrchestrator({
      agent: new OrderAgent({ llm, deps: { submitOrder: createPickupOrder } }),
    }),
    sessions,
    notifier: async (payload) => {
      console.log(`--- уведомление админу ---\n${payload.text}\n`);
    },
  });

  console.log(`провайдер ${llm.provider}/${llm.model}, кафе по умолчанию ${config.order.defaultCafeId ?? '—'}\n`);
  console.log(`клиент: /start\nбот   : ${(await service.start({ telegramUserId: user })).replyText}\n`);

  for (const text of messages) {
    const result = await service.handleText({ telegramUserId: user, text });
    console.log(`клиент: ${text}`);
    console.log(`бот   : ${result.replyText}`);
    if (result.choices.length) console.log(`кнопки: ${result.choices.join(' | ')}`);
    if (result.orderId) console.log(`>>> ЗАКАЗ ${result.orderId} на ${result.total} ₽`);
    console.log('');
  }

  process.exit(0);
})();
