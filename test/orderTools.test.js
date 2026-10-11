'use strict';

// Инструменты заказа: юнит-тесты без БД (источники подменяются через deps).
const test = require('node:test');
const assert = require('node:assert/strict');

const { OrderState } = require('../src/domain/orderState');
const { OrderToolbox, normalizeRuPhone, ORDER_TOOL_DEFINITIONS } = require('../src/tools/orderTools');
const { STATUSES } = require('../src/domain/orderSchema');

const MENU = [
  { name: 'Куриная Стандарт 320г', price: 300, stopped: false, description: 'шаурма', weight: '320' },
  { name: 'Воткинский лимонад', price: 110, stopped: false },
  { name: 'Стоп-позиция', price: 100, stopped: true },
];

const CAFES = [
  { cafeId: 68, cafeName: 'Raketa на Молодежной 107б', addrOfCafe: 'Молодежная 107б', isActive: true },
  { cafeId: 72, cafeName: 'Raketa на Петрова 29ж', addrOfCafe: 'Петрова 29ж', isActive: true },
];

function makeToolbox(overrides = {}) {
  const submitted = [];
  const toolbox = new OrderToolbox({
    state: overrides.state || new OrderState(),
    telegramUserId: 990000005,
    deps: {
      getMenuItems: async () => MENU,
      listCafes: async () => CAFES,
      defaultCafeId: 68,
      submitOrder: async (order) => {
        submitted.push(order);
        return { orderId: '284900', total: order.items.reduce((s, i) => s + i.price * i.qty, 0) };
      },
      ...overrides.deps,
    },
  });
  return { toolbox, submitted };
}

test('телефон: нормализация российских номеров', () => {
  assert.equal(normalizeRuPhone('89001234567'), '+79001234567');
  assert.equal(normalizeRuPhone('+7 900 123-45-67'), '+79001234567');
  assert.equal(normalizeRuPhone('9001234567'), '+79001234567');
  assert.equal(normalizeRuPhone('12345'), null);
});

test('описания инструментов совпадают по именам с эталоном', () => {
  const names = ORDER_TOOL_DEFINITIONS.map((tool) => tool.function.name);
  assert.deepEqual(names, [
    'get_order_draft',
    'respond_to_customer',
    'get_menu',
    'set_items',
    'list_pickup_points',
    'set_pickup_point',
    'set_pickup_time',
    'set_payment_method',
    'set_phone',
    'get_order_summary',
    'cancel_order',
    'submit_order',
  ]);
});

test('set_items: мусор и неоднозначность не пишутся в черновик', async () => {
  const { toolbox } = makeToolbox();
  const unknown = await toolbox.dispatch('set_items', { items: [{ name: 'абракадабра', qty: 1 }] });
  assert.equal(unknown.ok, false);
  assert.deepEqual(unknown.unknown, ['абракадабра']);
  assert.equal(toolbox.state.items.length, 0);

  // «куриная шаурма» близка к двум позициям одинаково → уточнение, а не молчаливый выбор
  const ambiguous = await toolbox.dispatch('set_items', { items: [{ name: 'куриная шаурма', qty: 1 }] });
  assert.equal(ambiguous.ok, false);
  assert.ok(Object.keys(ambiguous.ambiguous).length === 1, JSON.stringify(ambiguous));

  const stopped = await toolbox.dispatch('set_items', { items: [{ name: 'Стоп-позиция', qty: 1 }] });
  assert.equal(stopped.ok, false);
  assert.deepEqual(stopped.unknown, ['Стоп-позиция']);
});

test('set_items: односложный запрос с одним совпадением резолвится (поведение эталона)', async () => {
  const { toolbox } = makeToolbox();
  const result = await toolbox.dispatch('set_items', { items: [{ name: 'Стандарт', qty: 1 }] });
  assert.equal(result.ok, true);
  assert.equal(toolbox.state.items[0].name, 'Куриная Стандарт 320г');
});

test('set_items: мерж суммирует количество, replace — заменяет состав', async () => {
  const { toolbox } = makeToolbox();
  await toolbox.dispatch('set_items', { items: [{ name: 'Воткинский лимонад', qty: 1 }] });
  await toolbox.dispatch('set_items', { items: [{ name: 'Воткинский лимонад', qty: 2 }] });
  assert.equal(toolbox.state.items.length, 1);
  assert.equal(toolbox.state.items[0].qty, 3);

  await toolbox.dispatch('set_items', {
    items: [{ name: 'Куриная Стандарт 320г', qty: 1 }],
    replace: true,
  });
  assert.equal(toolbox.state.items.length, 1);
  assert.equal(toolbox.state.items[0].name, 'Куриная Стандарт 320г');
});

test('точка/время/оплата: валидация и неоднозначность', async () => {
  const { toolbox } = makeToolbox();

  const ambiguous = await toolbox.dispatch('set_pickup_point', { query: 'Raketa' });
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.candidates.length, 2);

  const point = await toolbox.dispatch('set_pickup_point', { query: 'Петрова' });
  assert.equal(point.ok, true);
  assert.equal(toolbox.state.pickupPointId, '72');

  assert.equal((await toolbox.dispatch('set_pickup_time', { time: '25:00' })).ok, false);
  assert.equal((await toolbox.dispatch('set_pickup_time', { time: '23:55' })).ok, true);

  assert.equal((await toolbox.dispatch('set_payment_method', { payment_method: 'карта' })).ok, false);
  assert.equal((await toolbox.dispatch('set_payment_method', { payment_method: 'card' })).ok, true);

  assert.equal((await toolbox.dispatch('set_phone', { phone: '8-900-123-45-67' })).ok, true);
  assert.equal(toolbox.state.phone, '+79001234567');
});

test('смена точки перепроверяет состав по меню нового кафе', async () => {
  const menus = {
    68: [{ name: 'Куриная Стандарт 320г', price: 340, stopped: false }],
    72: [{ name: 'Куриная Стандарт 320г', price: 250, stopped: false }, { name: 'Сыр', price: 50, stopped: false }],
  };
  const { toolbox } = makeToolbox({
    deps: {
      getMenuItems: async (cafeId) => menus[cafeId] || [],
      listCafes: async () => CAFES,
    },
  });

  await toolbox.dispatch('set_pickup_point', { query: 'Петрова' }); // кафе 72
  await toolbox.dispatch('set_items', { items: [{ name: 'Сыр', qty: 2 }] });
  assert.equal(toolbox.state.items.length, 1);

  // переезд в кафе 68: «Сыр» там есть, «Куриная» — тоже; проверим позицию, которой нет
  await toolbox.dispatch('set_items', { items: [{ name: 'Куриная Стандарт 320г', qty: 1 }] });
  const moved = await toolbox.dispatch('set_pickup_point', { query: 'Молодежная' }); // кафе 68
  assert.equal(moved.ok, true);
  assert.deepEqual(moved.dropped_items, ['Сыр']);
  assert.equal(toolbox.state.items.length, 1);
  assert.equal(toolbox.state.items[0].name, 'Куриная Стандарт 320г');
  assert.equal(toolbox.state.items[0].unitPrice, 340); // цена взята из меню нового кафе
  assert.match(moved.note, /недоступны/);
});

test('get_menu отдаёт только доступные позиции и кафе по выбранной точке', async () => {
  const { toolbox } = makeToolbox();
  const menu = await toolbox.dispatch('get_menu');
  assert.equal(menu.ok, true);
  assert.equal(menu.cafe_id, 68);
  assert.ok(!menu.items.some((item) => item.name === 'Стоп-позиция'));

  await toolbox.dispatch('set_pickup_point', { query: 'Петрова' });
  const menuAfter = await toolbox.dispatch('get_menu');
  assert.equal(menuAfter.cafe_id, 72);
});

test('сводка: перечисляет недостающие поля, затем считает итог', async () => {
  const { toolbox } = makeToolbox();
  const incomplete = await toolbox.dispatch('get_order_summary');
  assert.equal(incomplete.ok, false);
  assert.deepEqual(incomplete.missing_fields, [
    'items',
    'pickup_point_id',
    'pickup_time',
    'payment_method',
    'phone',
  ]);

  await toolbox.dispatch('set_items', { items: [{ name: 'Куриная Стандарт 320г', qty: 2 }] });
  await toolbox.dispatch('set_pickup_point', { query: 'Петрова' });
  await toolbox.dispatch('set_pickup_time', { time: '23:55' });
  await toolbox.dispatch('set_payment_method', { payment_method: 'card' });
  await toolbox.dispatch('set_phone', { phone: '89001234567' });

  const summary = await toolbox.dispatch('get_order_summary');
  assert.equal(summary.ok, true);
  assert.equal(summary.summary.total, 600);
  assert.equal(summary.requires_explicit_confirmation, true);
  assert.equal(toolbox.state.status, STATUSES.AWAITING_CONFIRMATION);
});

test('submit: требует сводку, пишет один раз и сбрасывает черновик', async () => {
  const { toolbox, submitted } = makeToolbox();

  const tooEarly = await toolbox.dispatch('submit_order');
  assert.equal(tooEarly.ok, false);

  await toolbox.dispatch('set_items', { items: [{ name: 'Куриная Стандарт 320г', qty: 2 }] });
  await toolbox.dispatch('set_pickup_point', { query: 'Петрова' });
  await toolbox.dispatch('set_pickup_time', { time: '23:55' });
  await toolbox.dispatch('set_payment_method', { payment_method: 'card' });
  await toolbox.dispatch('set_phone', { phone: '89001234567' });
  await toolbox.dispatch('get_order_summary');

  const created = await toolbox.dispatch('submit_order');
  assert.equal(created.ok, true);
  assert.equal(created.order_id, '284900');
  assert.equal(created.total, 600);

  assert.equal(submitted.length, 1);
  assert.deepEqual(submitted[0].items, [{ name: 'Куриная Стандарт 320г', price: 300, qty: 2 }]);
  assert.equal(submitted[0].cafeId, '72');
  assert.equal(submitted[0].payment, 'card');
  assert.equal(submitted[0].pickupTime, '23:55');
  assert.equal(submitted[0].phone, '+79001234567');

  assert.equal(toolbox.shouldClearHistory(), true);
  assert.equal(toolbox.state.items.length, 0);

  const again = await toolbox.dispatch('submit_order');
  assert.equal(again.ok, false);
  assert.match(again.error, /already submitted/);
});

test('cancel очищает черновик и просит очистить историю', async () => {
  const { toolbox } = makeToolbox();
  await toolbox.dispatch('set_items', { items: [{ name: 'Воткинский лимонад', qty: 1 }] });
  const cancelled = await toolbox.dispatch('cancel_order');
  assert.equal(cancelled.ok, true);
  assert.equal(toolbox.state.items.length, 0);
  assert.equal(toolbox.shouldClearHistory(), true);
});

test('неизвестный инструмент не роняет ход', async () => {
  const { toolbox } = makeToolbox();
  const result = await toolbox.dispatch('does_not_exist', {});
  assert.equal(result.ok, false);
  assert.match(result.error, /Unknown tool/);
});

test('ошибка источника не выходит наружу как исключение', async () => {
  const { toolbox } = makeToolbox({
    deps: {
      getMenuItems: async () => {
        throw new Error('БД недоступна');
      },
    },
  });
  const menu = await toolbox.dispatch('get_menu');
  assert.equal(menu.ok, false);
  assert.match(menu.error, /temporarily unavailable/);
});
