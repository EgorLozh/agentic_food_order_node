'use strict';

// Этап 2: агент и оркестрация — детерминированные проверки с подменённой моделью (без сети).
const test = require('node:test');
const assert = require('node:assert/strict');

const { OrderAgent, MAX_TOOL_ROUNDS } = require('../src/llm/orderAgent');
const { OrderOrchestrator, AGENT_ERROR_REPLY } = require('../src/bootstrap/orchestrator');
const { validateCustomerResponse } = require('../src/tools/orderTools');
const { OrderState } = require('../src/domain/orderState');

const MENU = [
  { name: 'Куриная Стандарт 320г', price: 300, stopped: false },
  { name: 'Воткинский лимонад', price: 110, stopped: false },
];
const CAFES = [
  { cafeId: 68, cafeName: 'Raketa на Молодежной 107б', addrOfCafe: 'Молодежная 107б', isActive: true },
];

let callCounter = 0;
function toolCall(name, args) {
  callCounter += 1;
  return { id: `call_${callCounter}`, name, arguments: JSON.stringify(args) };
}
function answer(text, choices) {
  return { content: '', toolCalls: [toolCall('respond_to_customer', { text, choices })] };
}
function action(name, args) {
  return { content: '', toolCalls: [toolCall(name, args)] };
}

class FakeLLM {
  constructor(script) {
    this.script = [...script];
    this.calls = 0;
    this.seenMessages = [];
  }

  async completeWithTools({ messages }) {
    this.calls += 1;
    this.seenMessages.push(messages);
    if (!this.script.length) throw new Error('LLM script exhausted');
    const next = this.script.shift();
    return typeof next === 'function' ? next(messages) : next;
  }
}

function makeDeps(submitted) {
  return {
    getMenuItems: async () => MENU,
    listCafes: async () => CAFES,
    defaultCafeId: 68,
    submitOrder: async (order) => {
      submitted.push(order);
      return { orderId: '284950', total: order.items.reduce((s, i) => s + i.price * i.qty, 0) };
    },
  };
}

test('агент: полный ход — tools, сводка, submit и ответ клиенту', async () => {
  const submitted = [];
  const llm = new FakeLLM([
    action('set_pickup_point', { query: 'Молодежная' }),
    action('set_items', { items: [{ name: 'Куриная Стандарт 320г', qty: 2 }] }),
    action('set_pickup_time', { time: '15:00' }),
    action('set_payment_method', { payment_method: 'cash' }),
    action('set_phone', { phone: '89001234567' }),
    action('get_order_summary', {}),
    action('submit_order', {}),
    answer('Заказ 284950 принят, ждём вас к 15:00.', []),
  ]);
  const agent = new OrderAgent({ llm, deps: makeDeps(submitted) });
  const turn = await agent.respond({ telegramUserId: 42, text: 'Хочу 2 шаурмы на 15:00' });

  assert.equal(turn.replyText, 'Заказ 284950 принят, ждём вас к 15:00.');
  assert.equal(turn.toolRounds, 7);
  assert.equal(turn.clearHistory, true);
  assert.deepEqual(turn.choices, []);
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].cafeId, '68');
  assert.equal(submitted[0].items[0].qty, 2);
  assert.equal(submitted[0].pickupTime, '15:00');
});

test('агент: кнопки из respond_to_customer доходят до результата', async () => {
  const llm = new FakeLLM([
    action('get_menu', {}),
    answer('Что добавим? Если нужного варианта нет, напишите своими словами', ['Добавить ещё', 'К точке самовывоза']),
  ]);
  const agent = new OrderAgent({ llm, deps: makeDeps([]) });
  const turn = await agent.respond({ telegramUserId: 42, text: 'начать заказ' });
  assert.deepEqual(turn.choices, ['Добавить ещё', 'К точке самовывоза']);
});

test('агент: невалидные аргументы tool не роняют ход', async () => {
  const llm = new FakeLLM([
    { content: '', toolCalls: [{ id: 'bad', name: 'set_items', arguments: '{не json' }] },
    answer('Уточните, что добавить?', ['Шаурма', 'Лимонад']),
  ]);
  const agent = new OrderAgent({ llm, deps: makeDeps([]) });
  const turn = await agent.respond({ telegramUserId: 42, text: 'абракадабра' });
  assert.equal(turn.replyText, 'Уточните, что добавить?');
  assert.deepEqual(turn.choices, ['Шаурма', 'Лимонад']);
});

test('агент: respond_to_customer вместе с другими tools → безопасный отказ', async () => {
  const llm = new FakeLLM([
    {
      content: '',
      toolCalls: [toolCall('respond_to_customer', { text: 'ок', choices: [] }), toolCall('get_menu', {})],
    },
  ]);
  const agent = new OrderAgent({ llm, deps: makeDeps([]) });
  const turn = await agent.respond({ telegramUserId: 42, text: 'привет' });
  assert.match(turn.replyText, /Не удалось подготовить ответ/);
});

test('агент: модель ответила текстом — ответ восстанавливается через respond_to_customer', async () => {
  const llm = new FakeLLM([
    { content: 'Здравствуйте! Что хотите заказать?', toolCalls: [] },
    answer('Здравствуйте! Что хотите заказать?', ['Шаурма', 'Лимонад']),
  ]);
  const agent = new OrderAgent({ llm, deps: makeDeps([]) });
  const turn = await agent.respond({ telegramUserId: 42, text: 'привет' });
  assert.equal(turn.replyText, 'Здравствуйте! Что хотите заказать?');
  assert.deepEqual(turn.choices, ['Шаурма', 'Лимонад']);
});

test('агент: исчерпание раундов tools → просьба уточнить поля', async () => {
  const llm = new FakeLLM(Array.from({ length: MAX_TOOL_ROUNDS + 3 }, () => action('get_order_draft', {})));
  const agent = new OrderAgent({ llm, deps: makeDeps([]) });
  const turn = await agent.respond({ telegramUserId: 42, text: '...' });
  assert.equal(turn.toolRounds, MAX_TOOL_ROUNDS);
  assert.match(turn.replyText, /Не удалось завершить обработку|Уточните/);
});

test('агент: история диалога попадает в контекст модели', async () => {
  const llm = new FakeLLM([answer('Хорошо', ['Да', 'Нет'])]);
  const agent = new OrderAgent({ llm, deps: makeDeps([]) });
  await agent.respond({
    telegramUserId: 42,
    text: 'да',
    state: new OrderState(),
    history: [
      { role: 'user', content: 'хочу шаурму' },
      { role: 'assistant', content: 'Сколько?' },
    ],
  });
  const roles = llm.seenMessages[0].map((message) => message.role);
  assert.deepEqual(roles, ['system', 'user', 'assistant', 'user']);
});

test('orchestrator: переводит результат, таймаут и ошибки в ответ клиенту', async () => {
  const ok = new OrderOrchestrator({
    agent: { respond: async () => ({ replyText: 'ок', clearHistory: false, choices: ['Да', 'Нет'] }) },
    turnTimeoutSeconds: 5,
  });
  const result = await ok.handleMessage({ telegramUserId: 1, text: 'привет', state: new OrderState() });
  assert.equal(result.replyText, 'ок');
  assert.deepEqual(result.choices, ['Да', 'Нет']);

  const slow = new OrderOrchestrator({
    agent: { respond: () => new Promise((resolve) => setTimeout(() => resolve({ replyText: 'поздно' }), 300)) },
    turnTimeoutSeconds: 0.05,
  });
  const timedOut = await slow.handleMessage({ telegramUserId: 1, text: 'привет', state: new OrderState() });
  assert.equal(timedOut.replyText, AGENT_ERROR_REPLY);

  const broken = new OrderOrchestrator({
    agent: { respond: async () => { throw new Error('model down'); } },
    turnTimeoutSeconds: 5,
  });
  const errored = await broken.handleMessage({ telegramUserId: 1, text: 'привет', state: new OrderState() });
  assert.equal(errored.replyText, AGENT_ERROR_REPLY);
});

test('respond_to_customer: валидация choices как в эталоне', () => {
  assert.deepEqual(validateCustomerResponse({ text: 'привет', choices: [] }), {
    text: 'привет',
    choices: [],
  });
  assert.deepEqual(validateCustomerResponse({ text: 'привет', choices: ['Да', 'Нет'] }), {
    text: 'привет',
    choices: ['Да', 'Нет'],
  });
  assert.ok(validateCustomerResponse({ text: '', choices: [] }).error);
  assert.ok(validateCustomerResponse({ text: 'ок', choices: ['одна'] }).error);
  assert.ok(validateCustomerResponse({ text: 'ок', choices: ['Да', 'Да'] }).error);
  assert.ok(validateCustomerResponse({ text: 'ок', choices: ['Да', 'x'.repeat(41)] }).error);
  assert.ok(validateCustomerResponse({ text: 'ок', choices: ['1', '2', '3', '4', '5', '6', '7', '8', '9'] }).error);
});
