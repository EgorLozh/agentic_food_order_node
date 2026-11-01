'use strict';

// Этап 5: ход бота с «черновиком» — статусы в чате и одно финальное сообщение с клавиатурой.
const test = require('node:test');
const assert = require('node:assert/strict');

const { withDraft } = require('../src/bot/telegram');
const { DraftStream, STATUS_LABELS } = require('../src/bot/draftStream');

function fakeCtx({ chatType = 'private', failDraft = false } = {}) {
  const events = [];
  return {
    events,
    chat: { id: 42, type: chatType },
    from: { id: 42 },
    telegram: {
      async callApi(method, payload) {
        events.push({ kind: 'draft', method, text: payload.text, chatId: payload.chat_id });
        if (failDraft) throw new Error('Bad Request: not enough rights');
        return true;
      },
      async sendChatAction(chatId, action) {
        events.push({ kind: 'typing', chatId, action });
      },
    },
  };
}

test('ход: статусы идут в черновик, «печатает…» не дублирует его', async () => {
  const ctx = fakeCtx();
  const seen = [];
  const result = await withDraft(
    ctx,
    async (onProgress) => {
      onProgress('thinking');
      onProgress('get_menu');
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { replyText: 'ответ', choices: [] };
    },
    { refreshMs: 5, draft: { enabled: true, intervalMs: 0 } }
  );

  assert.equal(result.replyText, 'ответ');
  assert.deepEqual(
    ctx.events.filter((e) => e.kind === 'draft').map((e) => e.text),
    // статусы, затем сам ответ — иначе Telegram оставит в чате пузырь со статусом
    [STATUS_LABELS.thinking, 'Смотрю меню', 'ответ']
  );
  assert.equal(ctx.events.filter((e) => e.kind === 'typing').length, 0);
  assert.ok(ctx.events.every((e) => e.chatId === 42));
});

test('ход: при ошибке статусов остаётся «печатает…»', async () => {
  const ctx = fakeCtx({ failDraft: true });
  const result = await withDraft(
    ctx,
    async (onProgress) => {
      onProgress('get_menu');
      await new Promise((resolve) => setTimeout(resolve, 40));
      return { replyText: 'ответ', choices: [] };
    },
    { refreshMs: 10, draft: { enabled: true, intervalMs: 0 } }
  );

  assert.equal(result.replyText, 'ответ');
  assert.ok(ctx.events.some((e) => e.kind === 'typing' && e.action === 'typing'));
  assert.equal(ctx.events.filter((e) => e.kind === 'draft').length, 1, 'после ошибки — ни одного статуса');
});

test('ход: в группе статусы не отправляются, работает «печатает…»', async () => {
  const ctx = fakeCtx({ chatType: 'group' });
  await withDraft(ctx, async (onProgress) => {
    onProgress('get_menu');
    return 'ответ';
  }, { refreshMs: 10, draft: { enabled: true, intervalMs: 0 } });

  assert.equal(ctx.events.filter((e) => e.kind === 'draft').length, 0);
  assert.ok(ctx.events.some((e) => e.kind === 'typing'));
});

test('ход: пустой ответ в черновик не попадает', async () => {
  const ctx = fakeCtx();
  await withDraft(
    ctx,
    async (onProgress) => {
      onProgress('get_menu');
      return { replyText: '', choices: [] };
    },
    { refreshMs: 1000, draft: { enabled: true, intervalMs: 0 } }
  );
  assert.deepEqual(
    ctx.events.filter((e) => e.kind === 'draft').map((e) => e.text),
    [STATUS_LABELS.thinking, 'Смотрю меню']
  );
});

test('черновик: поток гасится после хода', async () => {
  const ctx = fakeCtx();
  const stream = new DraftStream({
    telegram: ctx.telegram,
    chatId: 42,
    enabled: true,
    intervalMs: 0,
  });
  await stream.start();
  await stream.stop();
  assert.equal(stream.active, false);
});
