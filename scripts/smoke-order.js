'use strict';

/**
 * Сквозная проверка: заказ создаётся кодом каркаса FeedMer из нашего сервиса.
 * Запуск: npm run smoke:order
 * Пишет тестовый заказ в общую БД, читает его обратно и удаляет за собой.
 */

const { Pool } = require('pg');
const { config } = require('../src/config');
const { db } = require('../src/feedmer');
const { createPickupOrder } = require('../src/orders/pickupOrder');

const TELEGRAM_ID = Number(process.env.SMOKE_TELEGRAM_ID || 990000004);
const CAFE_ID = Number(process.env.SMOKE_CAFE_ID || 68);
const CART = [
  { name: 'Куриная Стандарт 320г', price: 300, qty: 2 },
  { name: 'Воткинский лимонад', price: 110, qty: 1 },
];

(async () => {
  const pool = new Pool({ connectionString: config.db.url });
  try {
    const created = await createPickupOrder({
      telegramUserId: TELEGRAM_ID,
      cafeId: CAFE_ID,
      pickupTime: '23:55',
      payment: 'card',
      phone: '+79990001122',
      items: CART,
    });
    console.log('createPickupOrder →', created);

    const order = (
      await pool.query('SELECT * FROM orders WHERE pk_orders = $1', [created.orderId])
    ).rows[0];
    const items = (
      await pool.query(
        'SELECT id, item_name, item_price, pk_order FROM items WHERE pk_order = $1 ORDER BY id',
        [created.orderId]
      )
    ).rows;

    console.log('\n--- public.orders (прочитано обратно) ---');
    for (const key of [
      'pk_orders',
      'userid',
      'strdate',
      'deliveryTimeStart',
      'deliveryTimeFinish',
      'cafeId',
      'deliverysum',
      'printedDeliverySum',
      'payway',
      'recipientName',
      'tel',
      'ASAP',
      'isDelivery',
      'comment',
    ]) {
      console.log(`  ${key.padEnd(20)} ${order[key]}`);
    }
    console.log('\n--- public.items ---');
    for (const item of items) {
      console.log(`  id=${item.id} ${item.item_name} — ${item.item_price} ₽ (pk_order=${item.pk_order})`);
    }
    console.log(`\ndb.getOrderSum(${created.orderId}) = ${await db.getOrderSum(created.orderId)}`);

    // уборка
    await pool.query('DELETE FROM items WHERE pk_order = $1', [created.orderId]);
    await pool.query('DELETE FROM orders WHERE pk_orders = $1', [created.orderId]);
    await pool.query('DELETE FROM chatids WHERE telegram_chatid = $1', [TELEGRAM_ID]);
    await pool.query('DELETE FROM "userInfoExtra" WHERE "userId" = $1', [created.userId]);
    await pool.query('DELETE FROM users WHERE userid = $1', [created.userId]);
    console.log('тестовые строки удалены');
    process.exit(0);
  } catch (e) {
    console.error('SMOKE FAILED:', e.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
})();
