'use strict';

/**
 * Логика обработки сообщений — порт bot/handlers/{start,cancel,chat}.py эталона.
 * Специально не зависит от Telegram-библиотеки: её вызывает тонкий слой src/bot/telegram.js,
 * поэтому сервис можно проверять скриптами (smoke:bot) и юнит-тестами.
 */

const { config } = require('../config');

const START_TEXT =
  'Привет! Я помогу оформить заказ на самовывоз.\n\n' +
  'Нажмите «Начать заказ» или напишите заказ своими словами, например:\n' +
  '«Две шаурмы и колу к 14:00»';
const START_CHOICE = 'Начать заказ';
const CANCEL_TEXT = 'Заказ отменён. Можете начать новый.\n\nЧто заказываем?';
const BUSY_TEXT = 'Подождите, обрабатываю предыдущее сообщение...';
const MAIN_MENU_TEXT = 'Главное меню';
const NEW_ORDER_TEXT = 'Новый заказ';

/**
 * Кнопки не должны заменять текст: если подпись варианта не встречается в ответе, дописываем её
 * отдельным блоком. Так клиент видит варианты и в сообщении, и на кнопках.
 */
function ensureChoicesInText(text, choices) {
  if (!text || !choices || !choices.length) return text;
  const lowered = String(text).toLowerCase();
  const missing = choices.filter((choice) => !lowered.includes(String(choice).toLowerCase()));
  if (!missing.length) return text;
  return `${text}\n\nВарианты:\n${missing.map((choice) => `• ${choice}`).join('\n')}`;
}

const PAYMENT_LABELS = { cash: 'наличными', card: 'картой' };

/**
 * Текст уведомления админу — формат каркасного бота (эталон: adapters/telegram_orders.py
 * format_admin_order_message). Номер заказа — это pk_orders из общей БД, с префиксом ORD-,
 * чтобы админ видел тот же вид номера, что и у каркаса.
 */
const adminOrderText = ({ orderId, telegramUserId, state, total }) => {
  const items = (state && state.items) || [];
  const lines = [
    `Новый заказ ORD-${orderId}`,
    `Клиент Telegram ID: ${telegramUserId}`,
    '',
    'Позиции:',
  ];
  for (const item of items) {
    lines.push(`• ${item.qty}× ${item.name} — ${Math.round(item.unitPrice ?? 0)} ₽`);
  }
  const pickupName = (state && state.pickupPointName) || '—';
  const pickup =
    state && state.pickupPointAddress ? `${pickupName} (${state.pickupPointAddress})` : pickupName;
  lines.push(
    '',
    `Самовывоз: ${pickup}`,
    `Время: ${(state && state.pickupTime) || '—'}`,
    `Оплата: ${PAYMENT_LABELS[state && state.paymentMethod] || (state && state.paymentMethod) || '—'}`,
    `Телефон: ${(state && state.phone) || '—'}`,
    `Итого: ${Math.round(total ?? 0)} ₽`
  );
  return lines.join('\n');
};

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

    // «Новый заказ» — начать заново (со сбросом черновика), «Главное меню» — вернуться к разделам,
    // не теряя уже выбранное. Оба — обычные кнопки клавиатуры, а не команды Telegram.
    let effectiveText = userText;
    if (userText === NEW_ORDER_TEXT) {
      await this.sessions.clear(telegramUserId);
      effectiveText = MAIN_MENU_TEXT;
    }

    if (this._locks.has(telegramUserId)) {
      return { replyText: BUSY_TEXT, choices: [], busy: true };
    }
    this._locks.add(telegramUserId);
    try {
      const session = await this.sessions.get(telegramUserId);
      const result = await this.orchestrator.handleMessage({
        telegramUserId,
        text: effectiveText,
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
          await this.notifier({
            orderId: result.orderId,
            total: result.total ?? null,
            text: adminOrderText({
              orderId: result.orderId,
              telegramUserId,
              state: session.state,
              total: result.total ?? null,
            }),
          });
        } catch (e) {
          // уведомление админа не должно ломать ответ клиенту: заказ уже в общей БД
          console.warn('[bot] уведомление админа не отправлено:', e.message);
        }
      }

      const choices = result.choices || [];
      return {
        replyText: ensureChoicesInText(result.replyText, choices),
        choices,
        orderId: result.orderId || null,
        total: result.total ?? null,
      };
    } finally {
      this._locks.delete(telegramUserId);
    }
  }

  adminOrderText({ orderId, telegramUserId, state, total }) {
    return adminOrderText({ orderId, telegramUserId, state, total });
  }
}

module.exports = {
  BotService,
  START_TEXT,
  START_CHOICE,
  CANCEL_TEXT,
  BUSY_TEXT,
  MAIN_MENU_TEXT,
  NEW_ORDER_TEXT,
  ensureChoicesInText,
  adminOrderText,
};
