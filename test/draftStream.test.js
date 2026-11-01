'use strict';

// Этап 5: статусы хода в «черновике» сообщения (sendMessageDraft).
// Проверяем поведение, от которого зависит UX: первый статус виден сразу, обновления
// не флудят, повтор того же текста не отправляется, ошибка API отключает стрим, а не ход.
const test = require('node:test');
const assert = require('node:assert/strict');

const { DraftStream, STATUS_LABELS, MAX_TEXT } = require('../src/bot/draftStream');

function fakeTelegram({ fail = false } = {}) {
  const calls = [];
  return {
    calls,
    async callApi(method, payload) {
      calls.push({ method, ...payload });
      if (fail) throw new Error('Bad Request: chat not found');
      return true;
    },
  };
}

const silentLogger = { warn: () => {} };

function makeStream(overrides = {}) {
  const telegram = overrides.telegram || fakeTelegram();
  const stream = new DraftStream({
    telegram,
    chatId: 42,
    chatType: 'private',
    intervalMs: 400,
    logger: silentLogger,
    ...overrides,
  });
  return { stream, telegram };
}

test('черновик: первый статус уходит сразу и по-русски', async () => {
  const { stream, telegram } = makeStream();
  await stream.start();
  assert.equal(telegram.calls.length, 1);
  assert.equal(telegram.calls[0].method, 'sendMessageDraft');
  assert.equal(telegram.calls[0].chat_id, 42);
  assert.equal(telegram.calls[0].text, STATUS_LABELS.thinking);
  assert.ok(telegram.calls[0].draft_id !== 0, 'draft_id не может быть нулевым');
  await stream.stop();
});

test('черновик: инструменты агента переводятся в человеческие статусы', async () => {
  const { stream, telegram } = makeStream({ intervalMs: 0 });
  await stream.start();
  await stream.status('get_menu');
  await stream.status('get_order_summary');
  await stream.status('нет_такого_инструмента');
  assert.deepEqual(
    telegram.calls.map((call) => call.text),
    [STATUS_LABELS.thinking, 'Ищу в меню…', 'Формирую заказ…', STATUS_LABELS.thinking]
  );
  // один и тот же draft_id в рамках хода — иначе Telegram не анимирует обновления
  assert.equal(new Set(telegram.calls.map((call) => call.draft_id)).size, 1);
  await stream.stop();
});

test('черновик: повтор того же статуса не отправляется', async () => {
  const { stream, telegram } = makeStream({ intervalMs: 0 });
  await stream.start();
  await stream.status('thinking');
  await stream.status('get_menu');
  await stream.status('get_menu');
  assert.deepEqual(
    telegram.calls.map((call) => call.text),
    [STATUS_LABELS.thinking, 'Ищу в меню…']
  );
  await stream.stop();
});

test('черновик: обновления не чаще интервала, последний статус не теряется', async () => {
  let clock = 1000;
  const { stream, telegram } = makeStream({ now: () => clock });
  await stream.start(); // 1000 — сразу
  clock = 1100;
  await stream.status('get_menu'); // слишком рано — в очередь
  assert.equal(telegram.calls.length, 1);

  clock = 1500; // таймер сработал
  await new Promise((resolve) => setTimeout(resolve, 320));
  assert.deepEqual(
    telegram.calls.map((call) => call.text),
    [STATUS_LABELS.thinking, 'Ищу в меню…']
  );
  await stream.stop();
});

test('черновик: ошибка API гасит статусы, но не бросает наружу', async () => {
  const telegram = fakeTelegram({ fail: true });
  const warnings = [];
  const stream = new DraftStream({
    telegram,
    chatId: 42,
    chatType: 'private',
    logger: { warn: (message) => warnings.push(message) },
  });
  assert.equal(await stream.start(), false);
  assert.equal(stream.active, false);
  assert.equal(warnings.length, 1);
  await stream.status('get_menu');
  assert.equal(telegram.calls.length, 1, 'после ошибки новых вызовов быть не должно');
  await stream.stop();
});

test('черновик: выключен, группа или нет chatId — ни одного вызова', async () => {
  for (const overrides of [
    { enabled: false },
    { chatType: 'group' },
    { chatId: undefined },
  ]) {
    const telegram = fakeTelegram();
    const stream = new DraftStream({ telegram, chatId: 42, chatType: 'private', ...overrides });
    assert.equal(stream.active, false, JSON.stringify(overrides));
    assert.equal(await stream.start(), false);
    await stream.status('get_menu');
    assert.equal(telegram.calls.length, 0, JSON.stringify(overrides));
    await stream.stop();
  }
});

test('черновик: текст обрезается до лимита Telegram', async () => {
  const telegram = fakeTelegram();
  const stream = new DraftStream({
    telegram,
    chatId: 42,
    intervalMs: 0,
    logger: silentLogger,
    labels: { thinking: 'я'.repeat(MAX_TEXT + 100) },
  });
  await stream.start();
  assert.equal(telegram.calls[0].text.length, MAX_TEXT);
  await stream.stop();
});

test('черновик: после stop статусы не отправляются', async () => {
  let clock = 1000;
  const { stream, telegram } = makeStream({ now: () => clock });
  await stream.start();
  clock = 1100;
  await stream.status('get_menu'); // попал в таймер
  await stream.stop();
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(telegram.calls.length, 1);
});
