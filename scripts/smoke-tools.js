'use strict';

/**
 * Этап 1: скриптовая «беседа» без LLM — инструменты заказа от начала до записи в БД.
 * Запуск: npm run smoke:tools
 * Меню берётся у того кафе, где в тестовой БД есть прайс (кафе 3 «демо»).
 */

const { Pool } = require('pg');
const { config } = require('../src/config');
const { OrderState } = require('../src/domain/orderState');
const { OrderToolbox } = require('../src/tools/orderTools');
const { createPickupOrder } = require('../src/orders/pickupOrder');

const TELEGRAM_ID = Number(process.env.SMOKE_TELEGRAM_ID || 990000006);
const PICKUP_TIME = '23:55';
const PHONE = '89001234567';
const PAYMENT = 'cash';

function show(label, value) {
  console.log(`\n${label}\n${JSON.stringify(value, null, 2)}`);
}

(async () => {
  const pool = new Pool({ connectionString: config.db.url });
  const toolbox = new OrderToolbox({
    state: new OrderState(),
    telegramUserId: TELEGRAM_ID,
    deps: { submitOrder: createPickupOrder },
  });

  try {
    const points = await toolbox.dispatch('list_pickup_points');
    show('1) list_pickup_points', points.pickup_points);

    // ищем кафе, у которого в тестовой БД есть меню (прайс заполнен только у «демо»)
    let chosen = null;
    let menu = null;
    for (const point of points.pickup_points) {
      await toolbox.dispatch('set_pickup_point', { query: point.name });
      const candidate = await toolbox.dispatch('get_menu');
      if (candidate.items.length) {
        chosen = point;
        menu = candidate;
        break;
      }
    }
    if (!chosen) throw new Error('ни у одного кафе нет позиций в прайсе');
    console.log(`\n2) выбрана точка «${chosen.name}» (cafeId=${chosen.point_id}), позиций в меню: ${menu.items.length}`);

    const dish = menu.items.find((item) => item.name.trim());
    const result = await toolbox.dispatch('set_items', { items: [{ name: dish.name, qty: 2 }] });
    show(`3) set_items «${dish.name}» × 2`, result);

    show('4) set_pickup_time', await toolbox.dispatch('set_pickup_time', { time: PICKUP_TIME }));
    show('5) set_payment_method', await toolbox.dispatch('set_payment_method', { payment_method: PAYMENT }));
    show('6) set_phone', await toolbox.dispatch('set_phone', { phone: PHONE }));

    const summary = await toolbox.dispatch('get_order_summary');
    show('7) get_order_summary', summary);
    if (!summary.ok) throw new Error('сводка не собралась');

    const created = await toolbox.dispatch('submit_order');
    show('8) submit_order', created);
    if (!created.ok) throw new Error('заказ не отправлен');

    const order = (await pool.query('SELECT * FROM orders WHERE pk_orders = $1', [created.order_id])).rows[0];
    const items = (
      await pool.query('SELECT id, item_name, item_price FROM items WHERE pk_order = $1 ORDER BY id', [created.order_id])
    ).rows;
    console.log('\n9) в БД:');
    console.log(
      `   pk_orders=${order.pk_orders} userid=${order.userid} cafeId=${order.cafeId} strdate=${order.strdate} ` +
        `time=${order.deliveryTimeStart} payway=${order.payway} tel=${order.tel} sum=${items.reduce((s, i) => s + i.item_price, 0)}`
    );
    for (const item of items) console.log(`   позиция id=${item.id} ${item.item_name} — ${item.item_price} ₽`);

    await pool.query('DELETE FROM items WHERE pk_order = $1', [created.order_id]);
    await pool.query('DELETE FROM orders WHERE pk_orders = $1', [created.order_id]);
    await pool.query('DELETE FROM chatids WHERE telegram_chatid = $1', [TELEGRAM_ID]);
    await pool.query('DELETE FROM "userInfoExtra" WHERE "userId" = $1', [order.userid]);
    await pool.query('DELETE FROM users WHERE userid = $1', [order.userid]);
    console.log('\n10) тестовые строки удалены');
    process.exit(0);
  } catch (e) {
    console.error('SMOKE TOOLS FAILED:', e.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
})();
