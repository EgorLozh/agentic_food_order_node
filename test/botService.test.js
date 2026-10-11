'use strict';

// Этап 3: сервис бота — старт/отмена, блокировка на время хода, история, уведомление админа.
const test = require('node:test');
const assert = require('node:assert/strict');

const { BotService, START_TEXT, START_CHOICE, CANCEL_TEXT, BUSY_TEXT } = require('../src/bot/service');
const { SessionStore } = require('../src/state/sessions');
const { OrderState } = require('../src/domain/orderState');

function makeService({ orchestrate, notifier = null } = {}) {
  const sessions = new SessionStore({ historyLimit: 6 });
  const service = new BotService({
    orchestrator: { handleMessage: orchestrate || (async () => ({ replyText: 'ок', choices: [] })) },
    sessions,
    notifier,
  });
  return { service, sessions };
}

test('start: чистит сессию и предлагает «Начать заказ»', async () => {
  const { service, sessions } = makeService();
  await sessions.save(1, { state: new OrderState({ phone: '+79001234567' }), history: [] });
  const result = await service.start({ telegramUserId: 1 });
  assert.equal(result.replyText, START_TEXT);
  assert.deepEqual(result.choices, [START_CHOICE]);
  const session = await sessions.get(1);
  assert.equal(session.state.phone, null);
  assert.equal(session.history.length, 0);
});

test('cancel: чистит сессию и отвечает текстом эталона', async () => {
  const { service, sessions } = makeService();
  await sessions.save(1, {
    state: new OrderState({ phone: '+79001234567' }),
    history: [{ role: 'user', content: 'привет' }],
  });
  const result = await service.cancel({ telegramUserId: 1 });
  assert.equal(result.replyText, CANCEL_TEXT);
  const session = await sessions.get(1);
  assert.equal(session.state.phone, null);
  assert.equal(session.history.length, 0);
});

test('текст: история пишется, choices прокидываются', async () => {
  const orchestratorCalls = [];
  const { service, sessions } = makeService({
    orchestrate: async (params) => {
      orchestratorCalls.push(params);
      return { replyText: 'Что добавим?', choices: ['Шаурма', 'Лимонад'], clearHistory: false };
    },
  });

  const result = await service.handleText({ telegramUserId: 7, text: 'привет' });
  assert.equal(result.replyText, 'Что добавим?');
  assert.deepEqual(result.choices, ['Шаурма', 'Лимонад']);

  const session = await sessions.get(7);
  assert.deepEqual(session.history, [
    { role: 'user', content: 'привет' },
    { role: 'assistant', content: 'Что добавим?' },
  ]);
  assert.equal(orchestratorCalls[0].telegramUserId, 7);
});

test('clearHistory очищает историю вместо записи хода', async () => {
  const { service, sessions } = makeService({
    orchestrate: async () => ({ replyText: 'Заказ оформлен', choices: [], clearHistory: true }),
  });
  await sessions.save(7, {
    state: new OrderState(),
    history: [{ role: 'user', content: 'старое' }],
  });
  await service.handleText({ telegramUserId: 7, text: 'да' });
  const session = await sessions.get(7);
  assert.equal(session.history.length, 0);
});

test('уведомление админа уходит только когда есть заказ', async () => {
  const sent = [];
  const { service } = makeService({
    orchestrate: async () => ({ replyText: 'Заказ оформлен', choices: [], orderId: '284950', total: 240 }),
    notifier: async (payload) => sent.push(payload),
  });
  const result = await service.handleText({ telegramUserId: 7, text: 'да' });
  assert.equal(result.orderId, '284950');
  assert.deepEqual(sent, [{ orderId: '284950', total: 240 }]);
  assert.equal(service.adminOrderText('284950', 240), 'Новый заказ №284950 на 240 ₽ принят через агентного бота.');
});

test('ошибка уведомления не ломает ответ клиенту', async () => {
  const { service } = makeService({
    orchestrate: async () => ({ replyText: 'Заказ оформлен', choices: [], orderId: '1', total: 100 }),
    notifier: async () => {
      throw new Error('telegram недоступен');
    },
  });
  const result = await service.handleText({ telegramUserId: 7, text: 'да' });
  assert.equal(result.replyText, 'Заказ оформлен');
});

test('пока идёт ход, второе сообщение получает «Подождите»', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { service } = makeService({
    orchestrate: async () => {
      await gate;
      return { replyText: 'готово', choices: [] };
    },
  });

  const first = service.handleText({ telegramUserId: 7, text: 'первое' });
  const second = await service.handleText({ telegramUserId: 7, text: 'второе' });
  assert.equal(second.replyText, BUSY_TEXT);
  assert.equal(second.busy, true);
  release();
  assert.equal((await first).replyText, 'готово');
});

test('пустой текст игнорируется', async () => {
  const { service } = makeService();
  const result = await service.handleText({ telegramUserId: 7, text: '   ' });
  assert.equal(result.skipped, true);
  assert.equal(result.replyText, '');
});
