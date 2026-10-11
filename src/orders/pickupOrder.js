'use strict';

/**
 * Создание заказа самовывоза. Пишется кодом каркаса:
 *   db.getUserIdByTelegramChatId / db.addNewUser / db.addChatId — пользователь
 *   db.addItem   — позиции (строка на единицу, как корзина каркаса)
 *   db.saveOrder — заказ, ЕДИНСТВЕННЫЙ INSERT INTO orders в кодовой базе FeedMer
 *
 * Что остаётся на нашей стороне (в каркасе эти правила живут в scenarios.js saveOrder,
 * который целиком тянуть нельзя — он тянет сокеты/мессенджеры/печать):
 *   • дата заказа strdate в таймзоне кафе (cafes.timezone) со сдвигом на завтра,
 *     если время уже прошло — момент-логика 1:1 как в scenarios.js:5941-5953;
 *   • маппинг оплаты бота в enum payway_type;
 *   • deliverysum = 0 / deliveryTimeFinish = null / ASAP = false для самовывоза.
 */

const moment = require('moment-timezone'); // та же библиотека, что в каркасе
const { db } = require('../feedmer');
const { config } = require('../config');

const PAYWAY_BY_PAYMENT = {
  cash: 'наличными',
  card: 'картой при получении',
};

/** scenarios.js:5941-5953 — дата заказа в таймзоне кафе, прошедшее время → завтра. */
function orderDate(pickupTime, timezone) {
  const now = timezone ? moment().tz(timezone) : moment();
  const stamp = `${now.format('YYYY-MM-DD')} ${pickupTime}`;
  let planned = timezone
    ? moment.tz(stamp, 'YYYY-MM-DD HH:mm', timezone)
    : moment(stamp, 'YYYY-MM-DD HH:mm');
  if (planned.isBefore(now)) planned = planned.add(1, 'day');
  return planned.format('DD.MM.YYYY');
}

async function resolveUserId(telegramUserId) {
  const existing = await db.getUserIdByTelegramChatId(telegramUserId);
  if (existing) return existing;

  const userId = await db.addNewUser(`Клиент Telegram ${telegramUserId}`, null, null);
  if (!userId) throw new Error('db.addNewUser не вернул userid');

  await db.addChatId(userId, telegramUserId, 'telegram', null, null);

  // addChatId глушит ошибки (try/catch + console.log), поэтому проверяем результат сами:
  const mapped = await db.getUserIdByTelegramChatId(telegramUserId);
  if (!mapped) {
    throw new Error(
      `Связка chatids для telegram ${telegramUserId} не записалась: db.addChatId проглотил ошибку. ` +
        'Проверь схему БД каркаса (в тестовой базе не хватает колонки chatids.max_chatid).'
    );
  }
  return userId;
}

/**
 * @param {object} order
 * @param {number} order.telegramUserId
 * @param {number|string} order.cafeId
 * @param {string} order.pickupTime       HH:MM
 * @param {'cash'|'card'} order.payment
 * @param {string} order.phone
 * @param {Array<{name: string, price: number, qty: number}>} order.items
 * @param {string} [order.recipientName]
 */
async function createPickupOrder(order) {
  const cafeId = Number(order.cafeId ?? config.order.defaultCafeId);
  if (!Number.isInteger(cafeId)) {
    throw new Error('Не задан cafeId (ORDERS_DEFAULT_CAFE_ID или pickup_point_id)');
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(order.pickupTime || '')) {
    throw new Error(`Время должно быть HH:MM, получено: ${order.pickupTime}`);
  }
  const payway = PAYWAY_BY_PAYMENT[order.payment];
  if (!payway) throw new Error(`Неизвестный способ оплаты: ${order.payment}`);

  const cafeInfo = await db.getCafeInfo(cafeId); // информация кафе — тоже кодом каркаса
  if (!cafeInfo) throw new Error(`Кафе ${cafeId} не найдено в общей БД`);

  const date = orderDate(order.pickupTime, cafeInfo.timezone);
  const userId = await resolveUserId(order.telegramUserId);
  const recipientName = order.recipientName || `Клиент Telegram ${order.telegramUserId}`;
  const total = order.items.reduce((sum, item) => sum + item.price * item.qty, 0);

  // позиции: db.addItem — по строке на единицу, item_price = цена позиции
  for (const item of order.items) {
    for (let i = 0; i < item.qty; i += 1) {
      await db.addItem(item.name, date, userId, cafeId, item.price, null);
    }
  }

  const pkOrders = await db.saveOrder(
    userId,
    null, // formaladdr — самовывоз
    order.pickupTime, // deliveryTimeStart
    null, // deliveryTimeFinish — у самовывоза окна нет
    0, // deliverysum — доставки нет
    cafeId,
    payway,
    recipientName,
    order.phone,
    null, // addr
    false, // ASAP — время выбрано явно
    date,
    null, // className
    null, // howToGet
    null, // whatToDoIfNoAnswer
    null, // bToCContractNum
    false // isDelivery
  );

  if (!pkOrders) {
    throw new Error('db.saveOrder не вернул pk_orders (смотри лог каркаса выше)');
  }

  return { orderId: String(pkOrders), userId, cafeId, date, total, payway };
}

module.exports = { createPickupOrder, orderDate, resolveUserId, PAYWAY_BY_PAYMENT };
