'use strict';

/**
 * Инструменты агента — порт tools/order_agent_tools.py Python-эталона.
 * Имена и семантика инструментов совпадают с эталоном (промпт и описания не расходятся),
 * отличие одно: в FeedMer-pricelist идентификатор позиции — её название, поэтому
 * set_items принимает названия из get_menu (в эталоне — sku_id из Google-таблицы).
 */

const { ORDER_SCHEMA, FIELD_LABELS, STATUSES } = require('../domain/orderSchema');
const { mergeItems } = require('../domain/orderState');
const { MenuMatcher, resolvePickupPoint } = require('./menuResolver');
const { config } = require('../config');

// feedmerMenu подключается лениво: он тянет DBlib.js каркаса, который поднимает пул pg
// при require. В юнит-тестах источники подменяются через deps, и пул не нужен —
// иначе процесс не завершается (пул каркаса не экспортируется и держит event loop).
function feedmerMenuSource() {
  return require('../menu/feedmerMenu'); // eslint-disable-line global-require
}

const PICKUP_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

const MIN_CHOICES = 2;
// Было 8 как в эталоне, но из-за этого позиции больших групп («Соусы и добавки») выпадали
// из кнопок и оставались только текстом. 20 кнопок хватает на целую категорию меню.
const MAX_CHOICES = 20;
const MAX_CHOICE_LABEL_LEN = 40;

/**
 * Добавки и соусы: их нельзя заказывать сами по себе, только к основному блюду.
 * Штатный источник признака — классификация каркаса (pricelist.classification), но в тестовой
 * БД она пустая (каркас заполняет её из своей таблицы классификаций), поэтому пока по названию.
 * Паттерны подобраны по реальному меню кафе 68: «Сыр», «Оливки», «…соус…», «Доп.порция…»,
 * «Поменьше соуса», «Без фирменного соуса» — добавки; «4 сыра» (пицца) — основное блюдо.
 */
const ADDON_PATTERNS = [
  /соус/i,
  /оливк/i,
  /добавк/i,
  /приправ/i,
  /кетчуп/i,
  /майонез/i,
  /горчиц/i,
  /^сыр\s*$/i,
  /^сыр\s*\(/i,
  /^доп\./i,
  /поменьше/i,
  /без .*соус/i,
  /^хлеб\s*$/i,
];

const isAddonItem = (name) => ADDON_PATTERNS.some((re) => re.test(String(name || '').trim()));
const hasMainItem = (items) => items.some((item) => !isAddonItem(item.name));

/** Порт _validate_choices: список подписей кнопок или текст ошибки. */
function validateChoices(raw) {
  if (!Array.isArray(raw)) {
    return `choices must be a list of ${MIN_CHOICES} to ${MAX_CHOICES} strings`;
  }
  const labels = [];
  for (const item of raw) {
    if (typeof item !== 'string') return 'Each choice must be a string';
    const label = item.trim();
    if (!label) return 'Choice labels must be non-empty';
    if (label.length > MAX_CHOICE_LABEL_LEN) {
      return `Choice label must be at most ${MAX_CHOICE_LABEL_LEN} characters`;
    }
    labels.push(label);
  }
  if (labels.length < MIN_CHOICES || labels.length > MAX_CHOICES) {
    return `choices must contain ${MIN_CHOICES} to ${MAX_CHOICES} items`;
  }
  if (new Set(labels).size !== labels.length) return 'Choice labels must be unique';
  return labels;
}

/** Порт validate_customer_response: { text, choices, error }. */
function validateCustomerResponse(arguments_) {
  const text = arguments_?.text;
  if (typeof text !== 'string' || !text.trim()) {
    return { error: 'text must be a non-empty string' };
  }
  const replyText = text.trim();
  const rawChoices = arguments_.choices;
  if (Array.isArray(rawChoices) && rawChoices.length === 0) {
    return { text: replyText, choices: [] };
  }
  const choices = validateChoices(rawChoices);
  if (typeof choices === 'string') return { error: choices };
  return { text: replyText, choices };
}

/** Порт normalize_ru_phone. */
function normalizeRuPhone(raw) {
  const digits = String(raw ?? '').replace(/\D/g, '');
  if (digits.length === 11 && (digits[0] === '7' || digits[0] === '8')) {
    return `+7${digits.slice(1)}`;
  }
  if (digits.length === 10) return `+7${digits}`;
  return null;
}

const ORDER_TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'get_order_draft',
      description:
        'Черновик уже есть в current_draft. Вызывай только чтобы сверить состояние после tool calls в этом ходе.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'respond_to_customer',
      description:
        'Завершить текущий ход и отправить клиенту ответ. Вызывай после всех нужных tools вместо ' +
        'обычного текста. choices=[] допустим только для времени HH:MM, телефона и сообщения после ' +
        'успешного submit_order. Во всех остальных ответах передай 2–20 коротких уникальных подписей. ' +
        'Сразу после set_items, если точка ещё не выбрана, choices ровно «Добавить ещё» и ' +
        '«К точке самовывоза». Иначе: категории из реальных позиций, реальные позиции, точки, ' +
        '«наличные»/«карта» или «да»/«нет». Всё, что попало в choices, перечисли и в text ' +
        '(позиции — с ценами, каждая с новой строки). Не передавай одну кнопку и не пиши служебные ' +
        'маркеры кнопок в text.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', minLength: 1 },
          choices: {
            type: 'array',
            maxItems: 20,
            items: { type: 'string', minLength: 1, maxLength: 40 },
          },
        },
        required: ['text', 'choices'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_menu',
      description:
        'Получить доступное меню кафе с названиями, ценами, описанием и весом. Вызывай перед set_items, ' +
        'если названий ещё нет в результатах tools этого хода. Не выдумывай позиции.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_items',
      description:
        'Добавить или заменить позиции по названиям из get_menu. По умолчанию позиции мержатся: ' +
        'количество того же блюда суммируется. Передай replace=true, если клиент заново перечислил весь состав заказа.',
      parameters: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'Название позиции из get_menu' },
                qty: { type: 'integer', minimum: 1 },
              },
              required: ['name', 'qty'],
              additionalProperties: false,
            },
          },
          replace: { type: 'boolean', default: false },
        },
        required: ['items'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_pickup_points',
      description: 'Получить доступные точки самовывоза (название и адрес). Не выдумывай точки.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_pickup_point',
      description:
        'Установить точку самовывоза по названию или адресу из list_pickup_points. Если tool вернул ' +
        'candidates — перечисли их клиенту и спроси, какую выбрать; не выбирай первую молча.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_pickup_time',
      description:
        'Установить время самовывоза строго HH:MM, 24 часа. Не вызывай, если клиент сказал только ' +
        '«вечером» / «утром» / «через час» без конкретного HH:MM — сначала уточни время.',
      parameters: {
        type: 'object',
        properties: { time: { type: 'string' } },
        required: ['time'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_payment_method',
      description: 'Установить оплату: внутренние значения cash или card. Клиенту говори «наличные» / «карта».',
      parameters: {
        type: 'object',
        properties: { payment_method: { type: 'string', enum: ['cash', 'card'] } },
        required: ['payment_method'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_phone',
      description:
        'Сохранить телефон клиента для заказа. Передай номер, как сказал клиент; tool нормализует в +7XXXXXXXXXX. ' +
        'Не выдумывай номер.',
      parameters: {
        type: 'object',
        properties: { phone: { type: 'string' } },
        required: ['phone'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_order_summary',
      description:
        'Проверить полноту (позиции, точка, время, оплата, телефон) и получить итог. Если всё заполнено, ' +
        'статус станет awaiting_confirmation — после этого можно просить согласие и при согласии ' +
        'в текущем сообщении вызывать submit_order.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cancel_order',
      description: 'Отменить и очистить текущий черновик, если клиент отменяет заказ целиком.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'submit_order',
      description:
        'Передать заказ на кухню. Вызывай только после успешного get_order_summary и только если текущее ' +
        'сообщение клиента — согласие со сводкой. Не вызывай при вопросах, правках или неуверенности.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
];

class OrderToolbox {
  /**
   * @param {object} params
   * @param {import('../domain/orderState').OrderState} params.state
   * @param {number} params.telegramUserId
   * @param {object} [params.deps] — переопределение источников (для тестов):
   *        getMenuItems(cafeId), listCafes(), submitOrder(order), defaultCafeId
   */
  constructor({ state, telegramUserId, deps = {} }) {
    this.state = state;
    this.telegramUserId = telegramUserId;
    this.deps = {
      getMenuItems: deps.getMenuItems || ((cafeId) => feedmerMenuSource().getAvailableMenu(cafeId)),
      listCafes: deps.listCafes || (() => feedmerMenuSource().listCafes()),
      submitOrder: deps.submitOrder || null,
      defaultCafeId: deps.defaultCafeId ?? config.order.defaultCafeId,
    };
    this.submittedOrderId = null;
    this.clearHistory = false;
  }

  shouldClearHistory() {
    return this.clearHistory;
  }

  /** Кафе, по которому берём меню: выбранная точка → дефолт → первое активное. */
  async menuCafeId() {
    if (this.state.pickupPointId) return Number(this.state.pickupPointId);
    if (this.deps.defaultCafeId) return Number(this.deps.defaultCafeId);
    const cafes = await this.deps.listCafes();
    if (cafes.length) return Number(cafes[0].cafeId);
    throw new Error('В БД нет активных кафе');
  }

  missingFields() {
    return this.state.missingFields(ORDER_SCHEMA);
  }

  markCollecting() {
    if (this.state.status !== STATUSES.CREATED) this.state.status = STATUSES.COLLECTING;
  }

  /** Порт reply_on_tool_limit: что сказать клиенту, если раунды tools кончились. */
  replyOnToolLimit() {
    const missing = this.missingFields();
    const fallback =
      'Не удалось завершить обработку запроса за один шаг. Пожалуйста, уточните заказ или попробуйте ещё раз.';
    if (!this.state.hasDraftProgress() || !missing.length) return fallback;
    const labels = missing.map((field) => FIELD_LABELS[field]).filter(Boolean);
    if (!labels.length) return fallback;
    return `Уточните, пожалуйста: ${labels.join(', ')}.`;
  }

  async dispatch(name, args = {}) {
    const handlers = {
      get_order_draft: () => this.getOrderDraft(),
      get_menu: () => this.getMenu(),
      set_items: (a) => this.setItems(a),
      list_pickup_points: () => this.listPickupPoints(),
      set_pickup_point: (a) => this.setPickupPoint(a),
      set_pickup_time: (a) => this.setPickupTime(a),
      set_payment_method: (a) => this.setPaymentMethod(a),
      set_phone: (a) => this.setPhone(a),
      get_order_summary: () => this.getOrderSummary(),
      cancel_order: () => this.cancelOrder(),
      submit_order: () => this.submitOrder(),
    };
    const handler = handlers[name];
    if (!handler) return { ok: false, error: `Unknown tool: ${name}` };
    try {
      return await handler(args);
    } catch (e) {
      console.error('[order tool error]', name, e.message);
      return { ok: false, error: 'Tool temporarily unavailable. Do not assume it succeeded.' };
    }
  }

  async getOrderDraft() {
    return { ok: true, draft: this.state.toDraft(), missing_fields: this.missingFields() };
  }

  async getMenu() {
    const cafeId = await this.menuCafeId();
    const items = await this.deps.getMenuItems(cafeId);
    return {
      ok: true,
      cafe_id: cafeId,
      items: items
        .filter((item) => item.name && item.name.trim() && !item.stopped)
        .map((item) => ({
          name: item.name,
          price: item.price,
          description: item.description || '',
          weight: item.weight || '',
        })),
    };
  }

  async setItems(args = {}) {
    const rawItems = args.items;
    if (!Array.isArray(rawItems) || !rawItems.length) {
      return { ok: false, error: 'items must be a non-empty list' };
    }
    const cafeId = await this.menuCafeId();
    const menu = await this.deps.getMenuItems(cafeId);
    const matcher = new MenuMatcher(menu);

    const resolved = [];
    const unknown = [];
    const ambiguous = {};
    for (const raw of rawItems) {
      const name = String(raw?.name ?? '').trim();
      const qty = raw?.qty;
      if (!name) return { ok: false, error: 'Each item must have a name' };
      if (!Number.isInteger(qty) || qty < 1) {
        return { ok: false, error: `Invalid quantity for «${name}»` };
      }
      const { item, candidates } = matcher.resolveItem(name, qty);
      if (item) resolved.push(item);
      else if (candidates.length) ambiguous[name] = candidates;
      else unknown.push(name);
    }

    if (unknown.length || Object.keys(ambiguous).length) {
      return {
        ok: false,
        error: 'Some items were not resolved. Ask the customer to clarify.',
        unknown,
        ambiguous,
      };
    }

    // Добавки/соусы не заказывают сами по себе: в корзине должно быть основное блюдо.
    const before = this.state.items.map((item) => ({ ...item }));
    mergeItems(this.state, resolved, { replace: Boolean(args.replace) });
    if (!hasMainItem(this.state.items)) {
      this.state.items = before; // состав не меняем — отказ атомарный
      return {
        ok: false,
        error: 'Add-ons cannot be ordered without a main dish.',
        addons: resolved.map((item) => item.name),
        hint:
          'Соусы и добавки идут только к основному блюду. Спроси клиента, к какому блюду добавить, ' +
          'и предложи блюда из меню (get_menu).',
      };
    }

    this.markCollecting();
    return { ok: true, items: this.state.items.map((item) => ({ ...item })) };
  }

  async listPickupPoints() {
    const cafes = await this.deps.listCafes();
    return {
      ok: true,
      pickup_points: cafes
        .filter((cafe) => cafe.isActive !== false)
        .map((cafe) => ({
          point_id: String(cafe.cafeId),
          name: cafe.cafeName,
          address: cafe.addrOfCafe || null,
        })),
    };
  }

  async setPickupPoint(args = {}) {
    const query = String(args.query ?? '').trim();
    const cafes = await this.deps.listCafes();
    const points = cafes.map((cafe) => ({
      pointId: String(cafe.cafeId),
      name: cafe.cafeName,
      address: cafe.addrOfCafe || null,
      active: cafe.isActive !== false,
      aliases: [cafe.city, cafe.addrOfCafe].filter(Boolean),
    }));
    const { point, candidates } = resolvePickupPoint(query, points);

    if (candidates.length) {
      return {
        ok: false,
        error: 'Ambiguous pickup point. Ask the customer which one.',
        candidates: candidates.map((c) => ({ name: c.name, address: c.address })),
      };
    }
    if (!point) {
      return { ok: false, error: 'Pickup point not found. Call list_pickup_points.' };
    }

    this.state.pickupPointId = point.pointId;
    this.state.pickupPointName = point.name;
    this.state.pickupPointAddress = point.address;
    this.markCollecting();

    // Кафе изменилось → состав мог быть набран из меню другого кафе.
    // Перепроверяем позиции по меню выбранного кафе, чтобы в заказ не попали чужие блюда
    // (иначе в общей БД заказ кафе 68 может содержать позицию, которой у 68 нет).
    let droppedItems = [];
    try {
      const menu = await this.deps.getMenuItems(Number(point.pointId));
      const matcher = new MenuMatcher(menu);
      const kept = [];
      for (const item of this.state.items) {
        const { item: resolved } = matcher.resolveItem(item.name, item.qty);
        if (resolved) kept.push({ ...item, skuId: resolved.skuId, unitPrice: resolved.unitPrice });
        else droppedItems.push(item.name);
      }
      this.state.items = kept;
    } catch (e) {
      console.warn('[order tool] не удалось перепроверить состав по меню кафе:', e.message);
    }

    return {
      ok: true,
      pickup_point: { name: point.name, address: point.address },
      dropped_items: droppedItems,
      note: droppedItems.length
        ? `Позиции недоступны в кафе «${point.name}»: ${droppedItems.join(', ')}. ` +
          'Сообщи клиенту и предложи заменить их по меню этого кафе.'
        : undefined,
    };
  }

  async setPickupTime(args = {}) {
    const time = String(args.time ?? '').trim();
    if (!PICKUP_TIME_PATTERN.test(time)) {
      return { ok: false, error: 'Time must use HH:MM in 24-hour format' };
    }
    this.state.pickupTime = time;
    this.markCollecting();
    return { ok: true, pickup_time: time };
  }

  async setPaymentMethod(args = {}) {
    const value = String(args.payment_method ?? '').toLowerCase();
    if (!ORDER_SCHEMA.paymentMethods.includes(value)) {
      return { ok: false, error: `Payment method must be one of ${ORDER_SCHEMA.paymentMethods.join(', ')}` };
    }
    this.state.paymentMethod = value;
    this.markCollecting();
    return { ok: true, payment_method: value };
  }

  async setPhone(args = {}) {
    const normalized = normalizeRuPhone(args.phone);
    if (!normalized) {
      return { ok: false, error: 'Phone must be a Russian number: +7XXXXXXXXXX or 8XXXXXXXXXX' };
    }
    this.state.phone = normalized;
    this.markCollecting();
    return { ok: true, phone: normalized };
  }

  async getOrderSummary() {
    const missing = this.missingFields();
    if (missing.length) {
      return { ok: false, missing_fields: missing, error: 'Order is incomplete' };
    }
    this.state.status = STATUSES.AWAITING_CONFIRMATION;
    return {
      ok: true,
      summary: {
        items: this.state.items.map((item) => ({ ...item })),
        pickup_point: this.state.pickupPointName,
        pickup_address: this.state.pickupPointAddress,
        pickup_time: this.state.pickupTime,
        payment_method: this.state.paymentMethod,
        phone: this.state.phone,
        total: this.state.total(),
      },
      requires_explicit_confirmation: true,
    };
  }

  async cancelOrder() {
    this.state.resetForNewOrder();
    this.clearHistory = true;
    return { ok: true, message: 'Order draft cleared' };
  }

  async submitOrder() {
    if (this.submittedOrderId) {
      return { ok: false, error: 'Order already submitted in this message' };
    }
    const missing = this.missingFields();
    if (missing.length) {
      return { ok: false, error: 'Order is incomplete', missing_fields: missing };
    }
    if (this.state.status !== STATUSES.AWAITING_CONFIRMATION) {
      return { ok: false, error: 'Call get_order_summary and wait for customer confirmation first' };
    }
    if (!this.deps.submitOrder) {
      return { ok: false, error: 'Order sink is not configured' };
    }

    const created = await this.deps.submitOrder({
      telegramUserId: this.telegramUserId,
      cafeId: this.state.pickupPointId,
      pickupTime: this.state.pickupTime,
      payment: this.state.paymentMethod,
      phone: this.state.phone,
      items: this.state.items.map((item) => ({
        name: item.name,
        price: item.unitPrice,
        qty: item.qty,
      })),
    });

    this.submittedOrderId = created.orderId;
    this.submittedTotal = created.total ?? null;
    // как в эталоне: state.last_order_id не выставляем (в Python это поле только сбрасывается)
    this.state.resetForNewOrder();
    this.clearHistory = true;
    return { ok: true, order_id: created.orderId, total: created.total };
  }
}

module.exports = {
  OrderToolbox,
  ORDER_TOOL_DEFINITIONS,
  normalizeRuPhone,
  PICKUP_TIME_PATTERN,
  FIELD_LABELS,
  validateCustomerResponse,
  validateChoices,
  MIN_CHOICES,
  MAX_CHOICES,
  MAX_CHOICE_LABEL_LEN,
};
