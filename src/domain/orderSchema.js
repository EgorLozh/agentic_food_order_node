'use strict';

/**
 * Схема обязательных полей заказа — порт config/order_schema.yaml Python-эталона.
 * Держим в коде: структура фиксированная, лишняя зависимость на YAML-парсер не нужна.
 * Формат совпадает с эталоном, чтобы промпт и поведение агента не расходились.
 */

const ORDER_SCHEMA = {
  requiredFields: ['items', 'pickup_point_id', 'pickup_time', 'payment_method', 'phone'],
  paymentMethods: ['cash', 'card'],
  fulfillment: 'pickup_only',
};

const FIELD_LABELS = {
  items: 'позиции',
  pickup_point_id: 'точку самовывоза',
  pickup_time: 'время (HH:MM)',
  payment_method: 'способ оплаты',
  phone: 'телефон',
};

const STATUSES = {
  COLLECTING: 'collecting',
  AWAITING_CONFIRMATION: 'awaiting_confirmation',
  CREATED: 'created',
};

module.exports = { ORDER_SCHEMA, FIELD_LABELS, STATUSES };
