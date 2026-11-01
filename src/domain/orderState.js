'use strict';

/**
 * Черновик заказа — порт domain/models.py (OrderState, OrderItem, PendingClarification)
 * из Python-эталона. В БД ничего не пишет: запись происходит на submit.
 */

const { ORDER_SCHEMA, STATUSES } = require('./orderSchema');

class OrderState {
  constructor(init = {}) {
    this.items = init.items ? init.items.map((item) => ({ ...item })) : [];
    this.pickupPointId = init.pickupPointId ?? null;
    this.pickupPointName = init.pickupPointName ?? null;
    this.pickupPointAddress = init.pickupPointAddress ?? null;
    this.pickupTime = init.pickupTime ?? null;
    this.paymentMethod = init.paymentMethod ?? null;
    this.phone = init.phone ?? null;
    this.status = init.status ?? STATUSES.COLLECTING;
    this.lastOrderId = init.lastOrderId ?? null;
    this.pendingClarifications = init.pendingClarifications ? [...init.pendingClarifications] : [];
    // пожелания клиента («без лука», «приборы») — не слоты заказа, но переживают ходы
    // и уходят в комментарий заказа для кухни
    this.notes = init.notes ? [...init.notes] : [];
    this.idempotencyKey = init.idempotencyKey ?? null;
  }

  resetForNewOrder() {
    this.items = [];
    this.pickupPointId = null;
    this.pickupPointName = null;
    this.pickupPointAddress = null;
    this.pickupTime = null;
    this.paymentMethod = null;
    this.phone = null;
    this.status = STATUSES.COLLECTING;
    this.lastOrderId = null;
    this.pendingClarifications = [];
    this.notes = [];
    this.idempotencyKey = null;
  }

  /** Поля из схемы, которых ещё нет (порядок как в order_agent_tools.py). */
  missingFields(schema = ORDER_SCHEMA) {
    const missing = [];
    if (schema.requiredFields.includes('items') && this.items.length === 0) missing.push('items');
    if (schema.requiredFields.includes('pickup_point_id') && !this.pickupPointId) missing.push('pickup_point_id');
    if (schema.requiredFields.includes('pickup_time') && !this.pickupTime) missing.push('pickup_time');
    if (schema.requiredFields.includes('payment_method') && !this.paymentMethod) missing.push('payment_method');
    if (schema.requiredFields.includes('phone') && !this.phone) missing.push('phone');
    return missing;
  }

  hasDraftProgress() {
    return Boolean(
      this.items.length ||
        this.pickupPointId ||
        this.pickupTime ||
        this.paymentMethod ||
        this.phone
    );
  }

  total() {
    return this.items.reduce((sum, item) => sum + item.unitPrice * item.qty, 0);
  }

  clone() {
    return new OrderState({
      items: this.items.map((item) => ({ ...item })),
      pickupPointId: this.pickupPointId,
      pickupPointName: this.pickupPointName,
      pickupPointAddress: this.pickupPointAddress,
      pickupTime: this.pickupTime,
      paymentMethod: this.paymentMethod,
      phone: this.phone,
      status: this.status,
      lastOrderId: this.lastOrderId,
      pendingClarifications: this.pendingClarifications.map((c) => ({ ...c })),
      notes: [...this.notes],
      idempotencyKey: this.idempotencyKey,
    });
  }

  /**
   * Поставить неразрешённую позицию в очередь вопросов. Повторный запрос той же позиции
   * обновляет запись, а не плодит дубли.
   * @param {{rawName: string, qty?: number, candidates?: Array<object>, kind?: string}} params
   */
  addClarification({ rawName, qty = 1, candidates = [], kind = 'item' }) {
    const name = String(rawName || '').trim();
    if (!name) return null;
    const existing = this.pendingClarifications.find(
      (entry) => entry.rawName.toLowerCase() === name.toLowerCase()
    );
    const record = {
      rawName: name,
      qty: Number.isInteger(qty) && qty > 0 ? qty : 1,
      candidates: (candidates || []).map((candidate) =>
        typeof candidate === 'string' ? { name: candidate, price: null } : { ...candidate }
      ),
      kind,
    };
    if (existing) {
      Object.assign(existing, record);
      return existing;
    }
    this.pendingClarifications.push(record);
    return record;
  }

  /**
   * Закрыть вопрос, если клиент назвал одного из кандидатов.
   * @returns {null|{rawName: string, qty: number, candidates: Array<object>}} закрытая запись
   */
  resolveClarification(chosenName) {
    const chosen = String(chosenName || '').trim().toLowerCase();
    if (!chosen) return null;
    const index = this.pendingClarifications.findIndex((entry) =>
      (entry.candidates || []).some((candidate) => String(candidate.name).toLowerCase() === chosen)
    );
    if (index === -1) return null;
    const [closed] = this.pendingClarifications.splice(index, 1);
    return closed;
  }

  /** Открытые вопросы: их задаёт бот по одному, пока очередь не опустеет. */
  openQuestions() {
    return this.pendingClarifications.map((entry) => ({
      raw_name: entry.rawName,
      qty: entry.qty,
      kind: entry.kind,
      candidates: (entry.candidates || []).map((candidate) => ({ ...candidate })),
    }));
  }

  toDraft() {
    return {
      items: this.items.map((item) => ({ ...item })),
      pickup_point_id: this.pickupPointId,
      pickup_point_name: this.pickupPointName,
      pickup_point_address: this.pickupPointAddress,
      pickup_time: this.pickupTime,
      payment_method: this.paymentMethod,
      phone: this.phone,
      status: this.status,
      last_order_id: this.lastOrderId,
      pending_clarifications: this.pendingClarifications.map((c) => ({ ...c })),
      notes: [...this.notes],
    };
  }
}

/** Порт merge_resolved_items: слияние по имени позиции (в эталоне — по sku_id). */
function mergeItems(state, newItems, { replace = false } = {}) {
  if (replace) {
    state.items = newItems.map((item) => ({ ...item }));
    return state.items;
  }
  for (const incoming of newItems) {
    const existing = state.items.find((item) => item.skuId === incoming.skuId);
    if (existing) {
      existing.qty += incoming.qty;
    } else {
      state.items.push({ ...incoming });
    }
  }
  return state.items;
}

module.exports = { OrderState, mergeItems };
