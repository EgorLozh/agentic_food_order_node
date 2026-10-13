'use strict';

/**
 * Тонкий слой Telegram (telegraf). Вся логика — в src/bot/service.js.
 * Кнопки — reply-клавиатура: нажатие приходит обычным текстом, как в каркасе.
 *
 * Что здесь решается (по фидбэку с тестирования):
 * - «Главное меню» есть на каждом шаге, после оформленного заказа добавляется «Новый заказ»;
 * - индикатор «печатает…» держится всё время, пока агент формирует ответ (Telegram гасит его
 *   через ~5 секунд, поэтому обновляем раз в 4 с);
 * - длинные наборы кнопок (категории меню) раскладываются в две колонки, чтобы сообщение
 *   не превращалось в простыню.
 */

const { Telegraf, Markup } = require('telegraf');
const { MAIN_MENU_TEXT, NEW_ORDER_TEXT } = require('./service');

const TYPING_REFRESH_MS = 4000;
const TWO_COLUMNS_FROM = 6; // больше шести кнопок — раскладываем по две в ряд

function keyboardRows(choices) {
  const labels = choices.map((choice) => String(choice));
  const rows = labels.length > TWO_COLUMNS_FROM
    ? labels.reduce((acc, label, index) => {
        if (index % 2 === 0) acc.push([label]);
        else acc[acc.length - 1].push(label);
        return acc;
      }, [])
    : labels.map((label) => [label]);
  return rows;
}

/** Клавиатура шага: варианты + постоянные кнопки навигации. */
function buildKeyboard({ choices = [], completed = false }) {
  const rows = keyboardRows(choices);
  const persistent = completed ? [NEW_ORDER_TEXT, MAIN_MENU_TEXT] : [MAIN_MENU_TEXT];
  rows.push(persistent);
  return Markup.keyboard(rows).resize();
}

async function replyWithChoices(ctx, result) {
  if (!result.replyText) return;
  const keyboard = buildKeyboard({
    choices: result.choices || [],
    completed: Boolean(result.orderId),
  });
  await ctx.reply(result.replyText, keyboard);
}

/** «печатает…» на всё время обработки хода (refreshMs — для тестов). */
async function withTyping(ctx, fn, refreshMs = TYPING_REFRESH_MS) {
  const chatId = ctx.chat?.id;
  const tick = () => ctx.telegram.sendChatAction(chatId, 'typing').catch(() => {});
  await tick();
  const timer = setInterval(tick, refreshMs);
  try {
    return await fn();
  } finally {
    clearInterval(timer);
  }
}

function createBot({ token, service }) {
  const bot = new Telegraf(token);

  bot.start(async (ctx) => {
    const result = await withTyping(ctx, () => service.start({ telegramUserId: ctx.from.id }));
    await replyWithChoices(ctx, result);
  });

  bot.command('cancel', async (ctx) => {
    const result = await withTyping(ctx, () => service.cancel({ telegramUserId: ctx.from.id }));
    await replyWithChoices(ctx, result);
  });

  bot.on('text', async (ctx) => {
    const text = (ctx.message?.text || '').trim();
    if (!text) return;
    if (text === '/start' || text === '/cancel') return; // обработано выше
    const result = await withTyping(ctx, () =>
      service.handleText({ telegramUserId: ctx.from.id, text })
    );
    await replyWithChoices(ctx, result);
  });

  bot.catch((error) => {
    console.error('[bot] ошибка обработки апдейта:', error.message);
  });

  return bot;
}

module.exports = { createBot, buildKeyboard, keyboardRows, withTyping };
