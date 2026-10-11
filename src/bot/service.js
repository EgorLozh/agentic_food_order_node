'use strict';

/**
 * Логика обработки сообщений — порт bot/handlers/{start,cancel,chat}.py эталона.
 * Специально не зависит от Telegram-библиотеки: её вызывает тонкий слой src/bot/telegram.js,
 * поэтому сервис можно проверять скриптами (smoke:bot) и юнит-тестами.
 */

const { config } = require('../config');

const START_TEXT =
  'Привет! Я помогу оформить заказ на самовывоз.\n' +
  'Нажмите «Начать заказ» или напишите заказ своими словами, например:\n' +
  '«Две шаурмы и колу к 14:00»';
const START_CHOICE = 'Начать заказ';
const CANCEL_TEXT = 'Заказ отменён. Можете начать новый.';
const BUSY_TEXT = 'Подождите, обрабатываю предыдущее сообщение...';

const adminOrderText = (orderId, total) =>
  `Новый заказ №${orderId}${total ? ` на ${total} ₽` : ''} принят через агентного бота.`;

class BotService {
  /**
   * @param {object} params
   * @param {import('../bootstrap/orchestrator').OrderOrchestrator} params.orchestrator
   * @param {import('../state/sessions').SessionStore} params.sessions
   * @param {null|((payload: {orderId: string, total: number|null}) => Promise<void>)} [params.notifier]
   */
  constructor({ orchestrator, sessions, notifier = null }) {
    this.orchestrator = orchestrator;
    this.sessions = sessions;
    this.notifier = notifier;
    this._locks = new Set();
  }

  async start({ telegramUserId }) {
    await this.sessions.clear(telegramUserId);
    return { replyText: START_TEXT, choices: [START_CHOICE] };
  }

  async cancel({ telegramUserId }) {
    await this.sessions.clear(telegramUserId);
    return { replyText: CANCEL_TEXT, choices: [] };
  }

  async handleText({ telegramUserId, text }) {
    const userText = String(text ?? '').trim();
    if (!userText) return { replyText: '', choices: [], skipped: true };

    if (this._locks.has(telegramUserId)) {
      return { replyText: BUSY_TEXT, choices: [], busy: true };
    }
    this._locks.add(telegramUserId);
    try {
      const session = await this.sessions.get(telegramUserId);
      const result = await this.orchestrator.handleMessage({
        telegramUserId,
        text: userText,
        state: session.state,
        history: session.history,
      });

      if (result.clearHistory) session.history = [];
      else
        this.sessions.appendTurn(session, {
          userText,
          assistantText: result.replyText,
        });
      await this.sessions.save(telegramUserId, session);

      if (result.orderId && this.notifier) {
        try {
          await this.notifier({ orderId: result.orderId, total: result.total ?? null });
        } catch (e) {
          // уведомление админа не должно ломать ответ клиенту: заказ уже в общей БД
          console.warn('[bot] уведомление админа не отправлено:', e.message);
        }
      }

      return {
        replyText: result.replyText,
        choices: result.choices || [],
        orderId: result.orderId || null,
        total: result.total ?? null,
      };
    } finally {
      this._locks.delete(telegramUserId);
    }
  }

  adminOrderText(orderId, total) {
    return adminOrderText(orderId, total);
  }
}

module.exports = { BotService, START_TEXT, START_CHOICE, CANCEL_TEXT, BUSY_TEXT, adminOrderText };
