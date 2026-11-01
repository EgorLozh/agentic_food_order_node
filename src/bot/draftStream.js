'use strict';

/**
 * Статусы хода в «черновике» сообщения — Telegram Bot API `sendMessageDraft`.
 *
 * Зачем: ход агента на живой модели занимает несколько секунд (свой таймаут — 90 с),
 * и всё это время клиент видел только «печатает…». Черновик показывает, что бот делает
 * прямо сейчас: «Думаю» → «Ищу в меню» → «Формирую заказ». Многоточие в подписи НЕ ставим:
 * клиент сам рисует бегущие точки у черновика, иначе они дублируются.
 *
 * Ограничения метода, которые учтены здесь:
 * - только приватные чаты (в группах/каналах метод не работает) — иначе стрим не включаем;
 * - `draft_id` не может быть 0; обновления с тем же id анимируются;
 * - черновик эфемерный (~30 с) и исчезает, как только бот пришлёт настоящее сообщение,
 *   поэтому финальный ответ по-прежнему отправляет обычный `ctx.reply(...)` с клавиатурой;
 * - вызовы идут не чаще `intervalMs` (флуд-лимиты Telegram) и без повторов одного текста;
 * - перед отправкой ответа черновик принудительно получает ТЕКСТ ЭТОГО ОТВЕТА (`setText`):
 *   Telegram Desktop оставляет последний черновик в чате пузырём до 30 с, если его текст
 *   отличается от присланного сообщения, а при совпадении — заменяет черновик сообщением, и
 *   ничего лишнего не остаётся (проверено вживую на вариантах A/B/D/E);
 * - любая ошибка API (нет Forum Topic Mode у бота, бот заблокирован, старый сервер) не должна
 *   ломать ход: стрим гаснет, дальше работает прежний индикатор «печатает…».
 */

const DEFAULT_INTERVAL_MS = 400;
const MAX_TEXT = 4096;

/** Человеческие подписи: ключ — имя инструмента агента или служебный статус. */
const STATUS_LABELS = {
  thinking: 'Думаю',
  writing: 'Пишу ответ',
  get_menu: 'Ищу в меню',
  list_pickup_points: 'Смотрю точки самовывоза',
  set_pickup_point: 'Уточняю точку самовывоза',
  set_items: 'Проверяю состав заказа',
  set_pickup_time: 'Записываю время',
  set_phone: 'Записываю телефон',
  set_payment_method: 'Записываю оплату',
  get_order_summary: 'Формирую заказ',
  submit_order: 'Оформляю заказ',
  cancel_order: 'Отменяю заказ',
};

let draftCounter = Math.floor(Math.random() * 1000);

/** Свежий ненулевой id черновика: один на ход, чтобы анимация обновлений работала. */
function nextDraftId() {
  draftCounter = (draftCounter + 1) % 2147483647;
  if (draftCounter === 0) draftCounter = 1;
  return draftCounter;
}

class DraftStream {
  /**
   * @param {object} params
   * @param {{callApi: Function}} params.telegram — ctx.telegram (telegraf)
   * @param {number} params.chatId — id приватного чата
   * @param {string} [params.chatType] — 'private', если не передан — считаем приватным
   * @param {boolean} [params.enabled]
   * @param {number} [params.intervalMs] — минимальный интервал между обновлениями
   * @param {object} [params.labels]
   * @param {() => number} [params.now] — время (подменяется в тестах)
   * @param {number|null} [params.draftId]
   * @param {object} [params.logger]
   */
  constructor({
    telegram,
    chatId,
    chatType = 'private',
    enabled = true,
    intervalMs = DEFAULT_INTERVAL_MS,
    labels = STATUS_LABELS,
    now = Date.now,
    draftId = null,
    logger = console,
  }) {
    this.telegram = telegram;
    this.chatId = chatId;
    this.enabled = Boolean(enabled) && chatType === 'private' && Boolean(telegram) && Boolean(chatId);
    this.intervalMs = Math.max(0, Number(intervalMs) || 0);
    this.labels = labels;
    this.now = now;
    this.logger = logger;
    this.draftId = draftId || nextDraftId();

    this.failed = false;
    this.closed = false;
    this._warned = false;
    this._lastSentText = null;
    this._lastSentAt = 0;
    this._pendingText = null;
    this._timer = null;
    this._chain = Promise.resolve();
  }

  /** Стрим реально что-то отправляет (включён, приватный чат, API не падал). */
  get active() {
    return this.enabled && !this.failed && !this.closed;
  }

  /** Подпись статуса: неизвестный инструмент показывает нейтральное «Думаю». */
  label(status) {
    if (!status) return this.labels.thinking;
    return this.labels[status] || this.labels.thinking;
  }

  /** Первый статус хода. Возвращает true, если черновик реально отправлен. */
  async start() {
    if (!this.active) return false;
    await this.status('thinking', { immediate: true });
    return this.active;
  }

  /**
   * Показать статус. Не блокирует ход: вызов ставится в очередь и троттлится.
   * @param {string} status
   * @param {{immediate?: boolean}} [options]
   */
  status(status, { immediate = false } = {}) {
    if (!this.active) return Promise.resolve(false);
    const text = String(this.label(status) || '').slice(0, MAX_TEXT);
    if (!text) return Promise.resolve(false);
    if (text === this._pendingText) return Promise.resolve(false); // уже в очереди
    if (text === this._lastSentText && this._pendingText == null) return Promise.resolve(false);

    this._pendingText = text;
    if (immediate || this.intervalMs === 0) return this._flush();

    const elapsed = this.now() - this._lastSentAt;
    const wait = Math.max(0, this.intervalMs - elapsed);
    if (wait === 0) return this._flush();
    if (!this._timer) {
      this._timer = setTimeout(() => {
        this._timer = null;
        this._flush();
      }, wait);
      if (typeof this._timer.unref === 'function') this._timer.unref();
    }
    return Promise.resolve(true);
  }

  /**
   * Показать произвольный текст вместо статуса — используется для финального ответа:
   * черновик с текстом ответа клиент заменяет самим сообщением, без «хвоста» в чате.
   */
  setText(text) {
    if (!this.active) return Promise.resolve(false);
    const value = String(text ?? '').trim().slice(0, MAX_TEXT);
    if (!value) return Promise.resolve(false);
    this._pendingText = value;
    return this._flush();
  }

  /** Гасит таймеры и дожидается последнего вызова API (финальное сообщение шлёт бот). */
  async stop() {
    this.closed = true;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    this._pendingText = null;
    await this._chain.catch(() => {});
  }

  _flush() {
    if (!this.active) return Promise.resolve(false);
    const text = this._pendingText;
    this._pendingText = null;
    if (!text || text === this._lastSentText) return Promise.resolve(false);
    const next = this._chain.then(() => this._send(text));
    this._chain = next.catch(() => {});
    return next;
  }

  async _send(text) {
    if (!this.active) return false;
    this._lastSentText = text;
    this._lastSentAt = this.now();
    try {
      await this.telegram.callApi('sendMessageDraft', {
        chat_id: this.chatId,
        draft_id: this.draftId,
        text,
      });
      return true;
    } catch (e) {
      this.failed = true;
      if (!this._warned) {
        this._warned = true;
        const warn = typeof this.logger.warn === 'function' ? this.logger.warn.bind(this.logger) : () => {};
        warn(`[draft] статусы недоступны, остаётся «печатает…»: ${e.message}`);
      }
      return false;
    }
  }
}

module.exports = { DraftStream, STATUS_LABELS, DEFAULT_INTERVAL_MS, MAX_TEXT, nextDraftId };
