'use strict';

/**
 * Этап 5: живая проверка статусов хода в «черновике» (sendMessageDraft).
 * Запуск: npm run smoke:draft
 *
 * Шлёт в приватный чат ADMIN_TELEGRAM_ID последовательность статусов с интервалом и
 * затем финальное сообщение — ровно так же, как это делает бот на ходе агента.
 * Печатает ответ Telegram на каждый вызов: если бот не включил Forum Topic Mode или метод
 * недоступен на сервере, здесь будет видно текст ошибки, а не молчание.
 */

const { Telegraf } = require('telegraf');

const { config } = require('../src/config');
const { STATUS_LABELS } = require('../src/bot/draftStream');
const { withDraft } = require('../src/bot/telegram');

const chatId = Number(process.env.SMOKE_CHAT_ID || config.adminTelegramId);
const STEPS = ['thinking', 'get_menu', 'set_items', 'get_order_summary', 'writing'];
const STEP_DELAY_MS = Number(process.env.SMOKE_DRAFT_DELAY_MS || 1200);

async function main() {
  if (!config.botToken) {
    console.log('BOT_TOKEN не задан — живая проверка пропущена (см. .env.example)');
    process.exit(2);
  }
  if (!chatId) {
    console.log('Не задан ADMIN_TELEGRAM_ID (или SMOKE_CHAT_ID) — некуда слать черновик');
    process.exit(2);
  }

  const telegram = new Telegraf(config.botToken).telegram;
  const me = await telegram.getMe();
  console.log(`бот @${me.username} → чат ${chatId}`);

  // Прямые вызовы: видно ответ API на каждый статус, а не только итог.
  const draftId = Math.floor(Date.now() / 1000) % 2147483646 + 1;
  for (const step of STEPS) {
    const text = STATUS_LABELS[step];
    try {
      const ok = await telegram.callApi('sendMessageDraft', {
        chat_id: chatId,
        draft_id: draftId,
        text,
      });
      console.log(`  sendMessageDraft «${text}» → ${ok}`);
    } catch (e) {
      console.error(`  sendMessageDraft «${text}» → ошибка: ${e.message}`);
      process.exit(1);
    }
    await new Promise((resolve) => setTimeout(resolve, STEP_DELAY_MS));
  }

  // Финальное сообщение: черновик исчезает, в чате остаётся обычная реплика бота.
  await telegram.sendMessage(
    chatId,
    'Статусы хода проверены: черновик обновлялся в этом чате, теперь он заменён сообщением.'
  );
  console.log('финальное сообщение отправлено — черновик должен исчезнуть');

  // Тот же путь, что у бота на ходе: withDraft (статусы → черновик = текст ответа → сообщение).
  const ctx = { chat: { id: chatId, type: 'private' }, telegram };
  const reply = 'Проверка боевого пути: статусы шли в черновике, а этот текст его заменил.';
  await withDraft(
    ctx,
    async (onProgress) => {
      for (const step of ['thinking', 'get_menu', 'get_order_summary']) {
        onProgress(step);
        await new Promise((resolve) => setTimeout(resolve, 900));
      }
      return { replyText: reply, choices: [] };
    },
    { draft: config.bot.draft }
  );
  await telegram.sendMessage(chatId, reply);
  console.log('ход через withDraft отрисован: статусы → черновик с текстом ответа → сообщение');
  console.log('в чате не должно остаться пузыря со статусом');
  console.log('OK');
  process.exit(0);
}

main().catch((e) => {
  console.error('проверка не прошла:', e.message);
  process.exit(1);
});
