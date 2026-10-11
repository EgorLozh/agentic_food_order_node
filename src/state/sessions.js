'use strict';

/**
 * Диалоговые сессии — порт storage/sessions.py эталона (in-memory, чистится при рестарте).
 */

const { OrderState } = require('../domain/orderState');

class SessionData {
  constructor({ state, history, pendingChoices, choicesMessageId } = {}) {
    this.state = state || new OrderState();
    this.history = history || []; // [{ role: 'user'|'assistant', content }]
    this.pendingChoices = pendingChoices || [];
    this.choicesMessageId = choicesMessageId ?? null;
  }

  clone() {
    return new SessionData({
      state: this.state.clone(),
      history: this.history.map((message) => ({ ...message })),
      pendingChoices: [...this.pendingChoices],
      choicesMessageId: this.choicesMessageId,
    });
  }
}

class SessionStore {
  constructor({ historyLimit = 6 } = {}) {
    this.historyLimit = Math.max(0, historyLimit);
    this._sessions = new Map();
  }

  async init() {
    return undefined;
  }

  async get(telegramUserId) {
    const session = this._sessions.get(telegramUserId);
    return session ? session.clone() : new SessionData();
  }

  async save(telegramUserId, session) {
    this._sessions.set(telegramUserId, session.clone());
  }

  appendTurn(session, { userText, assistantText }) {
    if (this.historyLimit <= 0) {
      session.history = [];
      return session;
    }
    session.history.push({ role: 'user', content: userText });
    session.history.push({ role: 'assistant', content: assistantText });
    session.history = session.history.slice(-this.historyLimit);
    return session;
  }

  async clear(telegramUserId) {
    this._sessions.set(telegramUserId, new SessionData());
  }

  async delete(telegramUserId) {
    this._sessions.delete(telegramUserId);
  }

  size() {
    return this._sessions.size;
  }
}

module.exports = { SessionStore, SessionData };
