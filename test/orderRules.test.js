'use strict';

// Правила заказа, которые остаются на нашей стороне (в каркасе они живут в
// scenarios.js saveOrder, который целиком не импортируется).
const test = require('node:test');
const assert = require('node:assert/strict');

const { orderDate, PAYWAY_BY_PAYMENT } = require('../src/orders/pickupOrder');
const moment = require('moment-timezone');

test('orderDate: в таймзоне кафе', () => {
  const tz = 'Europe/Samara'; // UTC+4, как у кафе в тестовой БД
  const now = moment.tz('2026-10-11 20:00', 'YYYY-MM-DD HH:mm', tz);
  const before = orderDate('23:00', tz);
  const after = orderDate('10:00', tz);
  assert.match(before, /^\d{2}\.\d{2}\.\d{4}$/);
  // 10:00 в таймзоне кафе уже прошло → заказ должен быть на завтра
  assert.equal(
    after,
    now.clone().add(1, 'day').format('DD.MM.YYYY'),
    'прошедшее время → следующий день'
  );
});

test('orderDate: без таймзоны (локальное время) не падает', () => {
  assert.match(orderDate('23:59', undefined), /^\d{2}\.\d{2}\.\d{4}$/);
});

test('payway: только метки enum payway_type каркаса', () => {
  assert.equal(PAYWAY_BY_PAYMENT.cash, 'наличными');
  assert.equal(PAYWAY_BY_PAYMENT.card, 'картой при получении');
  assert.deepEqual(Object.keys(PAYWAY_BY_PAYMENT).sort(), ['card', 'cash']);
});
