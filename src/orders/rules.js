'use strict';

/**
 * Правила заказа, которые не зависят от кода каркаса и от БД.
 * Вынесены отдельно, чтобы тестироваться без поднятия пула pg (пул DBlib.js
 * не экспортируется и держит event loop — тест бы завис).
 *
 * Источник правил: scenarios.js FeedMer, функция saveOrder (5899-5981) —
 * целиком она не импортируется (тянет сокеты/мессенджеры/печать).
 */

const moment = require('moment-timezone'); // та же библиотека времени, что в каркасе

/**
 * scenarios.js:5941-5953 — дата заказа в таймзоне кафе, прошедшее время → завтра.
 * `now` — точка отсчёта; параметр нужен только тестам (иначе проверка зависит от календарной даты).
 */
function orderDate(pickupTime, timezone, now = null) {
  const reference = now || (timezone ? moment().tz(timezone) : moment());
  const stamp = `${reference.format('YYYY-MM-DD')} ${pickupTime}`;
  let planned = timezone
    ? moment.tz(stamp, 'YYYY-MM-DD HH:mm', timezone)
    : moment(stamp, 'YYYY-MM-DD HH:mm');
  if (planned.isBefore(reference)) planned = planned.add(1, 'day');
  return planned.format('DD.MM.YYYY');
}

/** Метки enum payway_type каркаса (migrations FeedMer:436). */
const PAYWAY_BY_PAYMENT = {
  cash: 'наличными',
  card: 'картой при получении',
};

const PICKUP_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

module.exports = { orderDate, PAYWAY_BY_PAYMENT, PICKUP_TIME_PATTERN };
