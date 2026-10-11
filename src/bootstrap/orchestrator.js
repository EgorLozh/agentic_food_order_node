'use strict';

/**
 * Оркестрация хода — порт orchestration/orchestrator.py эталона:
 * один ход клиента ограничен по времени, любая ошибка превращается в извинение.
 */

const { config } = require('../config');

const AGENT_ERROR_REPLY = 'Извините, произошла ошибка. Попробуйте ещё раз.';

class OrderOrchestrator {
  constructor({ agent, turnTimeoutSeconds = config.agent.turnTimeoutSeconds }) {
    this.agent = agent;
    this.turnTimeoutSeconds = turnTimeoutSeconds;
  }

  /**
   * @returns {Promise<{replyText: string, clearHistory: boolean, choices: string[]}>}
   */
  async handleMessage({ telegramUserId, text, state, history }) {
    let timer;
    try {
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('agent turn timeout')),
          this.turnTimeoutSeconds * 1000
        );
      });
      const turn = await Promise.race([
        this.agent.respond({ telegramUserId, text, state, history }),
        timeout,
      ]);
      return {
        replyText: turn.replyText,
        clearHistory: turn.clearHistory,
        choices: turn.choices || [],
      };
    } catch (e) {
      console.warn('[orchestrator]', telegramUserId, e.message);
      return { replyText: AGENT_ERROR_REPLY, clearHistory: false, choices: [] };
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = { OrderOrchestrator, AGENT_ERROR_REPLY };
