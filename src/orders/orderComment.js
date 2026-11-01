'use strict';

/**
 * Комментарий к заказу в общей БД.
 *
 * `db.saveOrder` каркаса комментарий не принимает (в его INSERT нет колонки comment), а кухне
 * нужны пометки клиента («без лука», «приборы») и метка источника. Поэтому пишем одну колонку
 * точечным UPDATE — тем же способом, каким сам каркас дописывает заказ после создания
 * (`db.saveDeliveryBody`: `UPDATE orders SET "deliveryBody" = $1 WHERE pk_orders = $2`).
 * Только эта колонка, ничего больше: остальной контракт заказа остаётся за `db.saveOrder`.
 */

const { Pool } = require('pg');
const { config } = require('../config');

const SOURCE_TAG = 'Заказ агентного бота (agentic)';

let pool = null;

function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: config.db.url,
      ssl: config.db.testing ? false : { rejectUnauthorized: false },
    });
    // отдельный пул ради одной колонки: не держим процесс живым после работы скриптов
    if (typeof pool.on === 'function') pool.on('error', () => {});
  }
  return pool;
}

/** Текст комментария: метка источника + пожелания клиента. */
function buildOrderComment(notes = []) {
  const clean = (notes || []).map((note) => String(note).trim()).filter(Boolean);
  if (!clean.length) return SOURCE_TAG;
  return `${SOURCE_TAG}; пожелания: ${clean.join(', ')}`;
}

/**
 * Записать комментарий заказа. Ошибка записи не должна отменять уже созданный заказ.
 * @returns {Promise<boolean>}
 */
async function setOrderComment(orderId, comment) {
  try {
    await getPool().query('UPDATE orders SET comment = $1 WHERE pk_orders = $2', [comment, orderId]);
    return true;
  } catch (e) {
    console.warn('[order] комментарий заказа не записан:', e.message);
    return false;
  }
}

async function closeOrderCommentPool() {
  if (!pool) return;
  const closing = pool;
  pool = null;
  await closing.end().catch(() => {});
}

module.exports = { buildOrderComment, setOrderComment, closeOrderCommentPool, SOURCE_TAG };
