'use strict';

// Клавиатура шага: раскладка кнопок и постоянные «Главное меню»/«Новый заказ».
const test = require('node:test');
const assert = require('node:assert/strict');

const { buildKeyboard, keyboardRows, withTyping } = require('../src/bot/telegram');
const { MAIN_MENU_TEXT, NEW_ORDER_TEXT } = require('../src/bot/service');

test('до шести кнопок — по одной в ряд, больше — по две', () => {
  assert.deepEqual(keyboardRows(['a', 'b', 'c']), [['a'], ['b'], ['c']]);
  const rows = keyboardRows(['1', '2', '3', '4', '5', '6', '7']);
  assert.deepEqual(rows, [['1', '2'], ['3', '4'], ['5', '6'], ['7']]);
});

test('на каждом шаге есть «Главное меню», после оформления — ещё и «Новый заказ»', () => {
  const rows = buildKeyboard({ choices: ['наличные', 'карта'] }).reply_markup.keyboard;
  assert.deepEqual(rows[rows.length - 1], [MAIN_MENU_TEXT]);
  assert.ok(rows.flat().includes('наличные'));

  const done = buildKeyboard({ choices: [], completed: true }).reply_markup.keyboard;
  assert.deepEqual(done[done.length - 1], [NEW_ORDER_TEXT, MAIN_MENU_TEXT]);
});

test('«печатает…» отправляется сразу и обновляется, пока идёт ход', async () => {
  const actions = [];
  const ctx = { chat: { id: 42 }, telegram: { sendChatAction: async (id, action) => actions.push([id, action]) } };
  const result = await withTyping(ctx, () => new Promise((resolve) => setTimeout(() => resolve('готово'), 60)), 10);
  assert.equal(result, 'готово');
  assert.ok(actions.length >= 3, `ожидали не меньше трёх обновлений, получили ${actions.length}`);
  assert.ok(actions.every(([id, action]) => id === 42 && action === 'typing'));
});
