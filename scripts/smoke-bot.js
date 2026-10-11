'use strict';

/**
 * Этап 3: проверка бота без Telegram — тот же BotService, что дёргает telegraf,
 * с реальной моделью и реальной БД. Запуск: npm run smoke:bot
 *
 * Проверяем то, что зависит от нашего кода: /start, ход диалога через сервис,
 * создание заказа кодом каркаса и уведомление «админа» (заглушка).
 * Ручная проверка в самом Telegram: npm start и написать боту.
 */

const { Pool } = require('pg');
const { config } = require('../src/config');
const { LLMClient } = require('../src/llm/client');
const { OrderAgent } = require('../src/llm/orderAgent');
const { OrderOrchestrator } = require('../src/bootstrap/orchestrator');
const { SessionStore } = require('../src/state/sessions');
const { BotService } = require('../src/bot/service');
const { createPickupOrder } = require('../src/orders/pickupOrder');

const TELEGRAM_ID = Number(process.env.SMOKE_TELEGRAM_ID || 990000008);
const DISH = process.env.SMOKE_DISH || '"Эскимо" куриное на палочке';
const CAFE_QUERY = process.env.SMOKE_CAFE || 'демо';
const PICKUP_TIME = process.env.SMOKE_TIME || '15:00';
const PHONE = '89001234567';

const SCRIPT = [
  `Хочу 2 порции «${DISH}»`,
  `Заберу в ${CAFE_QUERY === 'демо' ? 'демо' : CAFE_QUERY}`,
  `Время ${PICKUP_TIME}`,
  'Наличными',
  `Телефон ${PHONE}`,
  'Да, подтверждаю',
];

(async () => {
  let llm;
  try {
    llm = LLMClient.fromConfig(config.llm);
  } catch (e) {
    console.error(`SMOKE BOT: ${e.message}`);
    process.exit(2);
  }

  const adminMessages = [];
  const sessions = new SessionStore({ historyLimit: config.agent.historyLimit });
  const service = new BotService({
    orchestrator: new OrderOrchestrator({
      agent: new OrderAgent({ llm, deps: { submitOrder: createPickupOrder } }),
    }),
    sessions,
    notifier: async (payload) => adminMessages.push(payload),
  });

  console.log(`провайдер: ${llm.provider}/${llm.model} (тот же сервис, что у telegraf)\n`);

  const started = await service.start({ telegramUserId: TELEGRAM_ID });
  console.log(`/start → ${started.replyText.split('\n')[0]}… кнопки: ${started.choices.join(' | ')}\n`);

  try {
    let orderId = null;
    for (const userText of SCRIPT) {
      const result = await service.handleText({ telegramUserId: TELEGRAM_ID, text: userText });
      console.log(`клиент: ${userText}`);
      console.log(`бот   : ${result.replyText}`);
      if (result.choices.length) console.log(`кнопки: ${result.choices.join(' | ')}`);
      console.log('');
      if (result.orderId) orderId = result.orderId;
    }
    if (!orderId) {
      console.error('SMOKE BOT FAILED: заказ не создан');
      process.exit(1);
    }

    const pool = new Pool({ connectionString: config.db.url });
    try {
      const order = (
        await pool.query('SELECT * FROM orders WHERE pk_orders = $1', [orderId])
      ).rows[0];
      const items = (
        await pool.query('SELECT item_name, item_price FROM items WHERE pk_order = $1 ORDER BY id', [orderId])
      ).rows;
      console.log(
        `заказ в БД: pk_orders=${order.pk_orders} cafeId=${order.cafeId} strdate=${order.strdate} ` +
          `time=${order.deliveryTimeStart} payway=${order.payway} sum=${items.reduce((s, i) => s + i.item_price, 0)}`
      );
      console.log(`уведомление админа (заглушка): ${JSON.stringify(adminMessages)}`);

      await pool.query('DELETE FROM items WHERE pk_order = $1', [orderId]);
      await pool.query('DELETE FROM orders WHERE pk_orders = $1', [orderId]);
      await pool.query('DELETE FROM chatids WHERE telegram_chatid = $1', [TELEGRAM_ID]);
      await pool.query('DELETE FROM "userInfoExtra" WHERE "userId" = $1', [order.userid]);
      await pool.query('DELETE FROM users WHERE userid = $1', [order.userid]);
      console.log('тестовые строки удалены');
    } finally {
      await pool.end();
    }
    process.exit(0);
  } catch (e) {
    console.error('SMOKE BOT FAILED:', e.message);
    process.exit(1);
  }
})();
