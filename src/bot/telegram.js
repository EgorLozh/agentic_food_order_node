'use strict';

/**
 * Тонкий слой Telegram (telegraf). Вся логика — в src/bot/service.js.
 * Кнопки — как в эталоне: reply-клавиатура, нажатие приходит обычным текстом.
 */

const { Telegraf, Markup } = require('telegraf');

async function replyWithChoices(ctx, result) {
  if (!result.replyText) return;
  if (result.choices && result.choices.length) {
    const keyboard = Markup.keyboard(result.choices.map((choice) => [choice]))
      .resize()
      .oneTime();
    await ctx.reply(result.replyText, keyboard);
    return;
  }
  await ctx.reply(result.replyText, Markup.removeKeyboard());
}

function createBot({ token, service }) {
  const bot = new Telegraf(token);

  bot.start(async (ctx) => {
    await replyWithChoices(ctx, await service.start({ telegramUserId: ctx.from.id }));
  });

  bot.command('cancel', async (ctx) => {
    await replyWithChoices(ctx, await service.cancel({ telegramUserId: ctx.from.id }));
  });

  bot.on('text', async (ctx) => {
    const text = (ctx.message?.text || '').trim();
    if (!text) return;
    if (text === '/start' || text === '/cancel') return; // обработано выше
    const result = await service.handleText({
      telegramUserId: ctx.from.id,
      text,
    });
    await replyWithChoices(ctx, result);
  });

  bot.catch((error) => {
    console.error('[bot] ошибка обработки апдейта:', error.message);
  });

  return bot;
}

module.exports = { createBot };
