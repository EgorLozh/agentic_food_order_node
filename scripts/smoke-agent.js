'use strict';

/**
 * Этап 2: живая проверка агента на реальной модели (нужен ключ в .env).
 * Запуск: npm run smoke:agent
 *
 * Прогоняет короткую переписку: заказ двух позиций → выбор точки → время → оплата →
 * телефон → подтверждение; печатает ответы и проверяет, что заказ появился в БД
 * (его записывает код каркаса). Затем удаляет тестовые строки.
 */

const { Pool } = require('pg');
const { config } = require('../src/config');
const { LLMClient } = require('../src/llm/client');
const { OrderAgent } = require('../src/llm/orderAgent');
const { OrderOrchestrator } = require('../src/bootstrap/orchestrator');
const { SessionStore } = require('../src/state/sessions');
const { createPickupOrder } = require('../src/orders/pickupOrder');

const TELEGRAM_ID = Number(process.env.SMOKE_TELEGRAM_ID || 990000007);
const DISH = process.env.SMOKE_DISH || '"Эскимо" куриное на палочке';
const CAFE_QUERY = process.env.SMOKE_CAFE || 'демо';
const PICKUP_TIME = process.env.SMOKE_TIME || '15:00';
const PHONE = '89001234567';

const SCRIPT = [
  `Здравствуйте! Хочу заказать 2 порции «${DISH}»`,
  'Точка самовывоза — ' + CAFE_QUERY,
  `Заберу в ${PICKUP_TIME}`,
  'Оплата наличными',
  `Телефон ${PHONE}`,
  'Да, всё верно, оформляйте',
];

(async () => {
  let llm;
  try {
    llm = LLMClient.fromConfig(config.llm);
  } catch (e) {
    console.error(`SMOKE AGENT: ${e.message}`);
    console.error('Впиши ключ в .env (см. .env.example) и повтори запуск.');
    process.exit(2);
  }

  const agent = new OrderAgent({ llm, deps: { submitOrder: createPickupOrder } });
  const orchestrator = new OrderOrchestrator({ agent });
  const sessions = new SessionStore({ historyLimit: config.agent.historyLimit });

  console.log(`провайдер: ${config.llm.provider}, модель: ${llm.model}\n`);

  let session = await sessions.get(TELEGRAM_ID);
  try {
    for (const userText of SCRIPT) {
      const result = await orchestrator.handleMessage({
        telegramUserId: TELEGRAM_ID,
        text: userText,
        state: session.state,
        history: session.history,
      });
      console.log(`клиент: ${userText}`);
      console.log(`агент : ${result.replyText}`);
      if (result.choices.length) console.log(`кнопки: ${result.choices.join(' | ')}`);
      console.log('');

      sessions.appendTurn(session, { userText, assistantText: result.replyText });
      if (result.clearHistory) session.history = [];
      await sessions.save(TELEGRAM_ID, session);
      session = await sessions.get(TELEGRAM_ID);
    }

    // заказ ищем в БД по связке telegram id → userid (в черновике его уже нет: черновик сброшен)
    const pool = new Pool({ connectionString: config.db.url });
    try {
      const order = (
        await pool.query(
          'SELECT o.* FROM orders o JOIN chatids c ON c.userid = o.userid' +
            ' WHERE c.telegram_chatid = $1 ORDER BY o.pk_orders DESC LIMIT 1',
          [TELEGRAM_ID]
        )
      ).rows[0];
      if (!order) {
        console.error('SMOKE AGENT FAILED: агент не оформил заказ за сценарий');
        process.exit(1);
      }
      const items = (
        await pool.query('SELECT id, item_name, item_price FROM items WHERE pk_order = $1 ORDER BY id', [
          order.pk_orders,
        ])
      ).rows;
      console.log(
        `заказ в БД: pk_orders=${order.pk_orders} cafeId=${order.cafeId} strdate=${order.strdate} ` +
          `time=${order.deliveryTimeStart} payway=${order.payway} sum=${items.reduce((s, i) => s + i.item_price, 0)}`
      );
      for (const item of items) console.log(`  ${item.item_name} — ${item.item_price} ₽`);

      await pool.query('DELETE FROM items WHERE pk_order = $1', [order.pk_orders]);
      await pool.query('DELETE FROM orders WHERE pk_orders = $1', [order.pk_orders]);
      await pool.query('DELETE FROM chatids WHERE telegram_chatid = $1', [TELEGRAM_ID]);
      await pool.query('DELETE FROM "userInfoExtra" WHERE "userId" = $1', [order.userid]);
      await pool.query('DELETE FROM users WHERE userid = $1', [order.userid]);
      console.log('тестовые строки удалены');
    } finally {
      await pool.end();
    }
    process.exit(0);
  } catch (e) {
    console.error('SMOKE AGENT FAILED:', e.message);
    process.exit(1);
  }
})();
