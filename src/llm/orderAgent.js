'use strict';

/**
 * Агент заказа — порт llm/order_agent.py эталона: цикл «модель → tools → модель»,
 * терминальный инструмент respond_to_customer, восстановление ответа из текста
 * и сообщение при исчерпании раундов.
 */

const { OrderState } = require('../domain/orderState');
const { ORDER_SCHEMA } = require('../domain/orderSchema');
const { ORDER_TOOL_DEFINITIONS, OrderToolbox, validateCustomerResponse } = require('../tools/orderTools');
const { ORDER_AGENT_SYSTEM } = require('./prompt');

const MAX_TOOL_ROUNDS = 12;
const INVALID_REPLY = 'Не удалось подготовить ответ. Попробуйте ещё раз.';

class OrderAgent {
  /**
   * @param {object} params
   * @param {import('./client').LLMClient} params.llm
   * @param {object} [params.schema]
   * @param {object} [params.deps] — источники для инструментов (пробрасываются в OrderToolbox)
   */
  constructor({ llm, schema = ORDER_SCHEMA, deps = {} }) {
    this.llm = llm;
    this.schema = schema;
    this.deps = deps;
  }

  /**
   * @returns {Promise<{replyText: string, toolRounds: number, clearHistory: boolean, choices: string[]}>}
   */
  async respond({ telegramUserId, text, state = new OrderState(), history = [] }) {
    const toolbox = new OrderToolbox({ state, telegramUserId, deps: this.deps });
    // добавить в результат сведения о созданном заказе (нужно боту для уведомления админа)
    const finish = (turn) => ({
      ...turn,
      orderId: toolbox.submittedOrderId || null,
      total: toolbox.submittedTotal ?? null,
    });

    const messages = [{ role: 'system', content: ORDER_AGENT_SYSTEM }];
    for (const item of history) messages.push({ role: item.role, content: item.content });
    messages.push({
      role: 'user',
      content: JSON.stringify({
        user_message: text,
        current_draft: state.toDraft(),
        required_fields: this.schema.requiredFields,
        payment_methods: this.schema.paymentMethods,
        fulfillment: 'самовывоз, доставки нет',
      }),
    });

    for (let toolRound = 1; toolRound <= MAX_TOOL_ROUNDS; toolRound += 1) {
      const message = await this.llm.completeWithTools({
        messages,
        tools: ORDER_TOOL_DEFINITIONS,
      });
      const toolCalls = message.toolCalls || [];

      if (!toolCalls.length) {
        return finish(
          await this.recoverTerminalResponse({
            messages,
            draft: (message.content || '').trim(),
            toolRounds: toolRound - 1,
            clearHistory: toolbox.shouldClearHistory(),
          })
        );
      }

      const terminalCalls = toolCalls.filter((call) => call.name === 'respond_to_customer');
      if (terminalCalls.length) {
        if (toolCalls.length !== 1) {
          console.warn(
            '[agent] respond_to_customer смешан с действиями:',
            toolCalls.map((call) => call.name).join(', ')
          );
          return finish(this.invalidTerminalResponse(toolRound - 1, toolbox.shouldClearHistory()));
        }
        return finish(
          this.terminalResponse(
            terminalCalls[0].arguments,
            toolRound - 1,
            toolbox.shouldClearHistory()
          )
        );
      }

      messages.push({
        role: 'assistant',
        content: message.content || '',
        tool_calls: toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.arguments },
        })),
      });

      for (const call of toolCalls) {
        let args;
        try {
          args = JSON.parse(call.arguments || '{}');
        } catch (e) {
          args = null;
        }
        const result = args
          ? await toolbox.dispatch(call.name, args)
          : { ok: false, error: 'Tool arguments were not valid JSON' };
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(result),
        });
      }
    }

    return finish({
      replyText: toolbox.replyOnToolLimit(),
      toolRounds: MAX_TOOL_ROUNDS,
      clearHistory: toolbox.shouldClearHistory(),
      choices: [],
    });
  }

  terminalResponse(rawArguments, toolRounds, clearHistory) {
    let parsedArgs = null;
    try {
      parsedArgs = JSON.parse(rawArguments || '{}');
    } catch (e) {
      parsedArgs = null;
    }
    if (!parsedArgs || typeof parsedArgs !== 'object') {
      return this.invalidTerminalResponse(toolRounds, clearHistory);
    }
    const parsed = validateCustomerResponse(parsedArgs);
    if (parsed.error) {
      console.warn('[agent] неверный respond_to_customer:', parsed.error);
      return this.invalidTerminalResponse(toolRounds, clearHistory);
    }
    return {
      replyText: parsed.text,
      toolRounds,
      clearHistory,
      choices: parsed.choices,
    };
  }

  /** Порт _recover_terminal_response: модель ответила текстом вместо вызова инструмента. */
  async recoverTerminalResponse({ messages, draft, toolRounds, clearHistory }) {
    messages.push({ role: 'assistant', content: draft });
    messages.push({
      role: 'user',
      content:
        'Оформи предыдущий черновик ответа вызовом respond_to_customer. Не добавляй новый текст вне вызова tool.',
    });
    const message = await this.llm.completeWithTools({
      messages,
      tools: ORDER_TOOL_DEFINITIONS,
    });
    const toolCalls = message.toolCalls || [];
    if (toolCalls.length === 1 && toolCalls[0].name === 'respond_to_customer') {
      return this.terminalResponse(toolCalls[0].arguments, toolRounds, clearHistory);
    }
    const reply = (message.content || '').trim() || draft;
    if (!reply) return this.invalidTerminalResponse(toolRounds, clearHistory);
    return { replyText: reply, toolRounds, clearHistory, choices: [] };
  }

  invalidTerminalResponse(toolRounds, clearHistory) {
    return { replyText: INVALID_REPLY, toolRounds, clearHistory, choices: [] };
  }
}

module.exports = { OrderAgent, MAX_TOOL_ROUNDS };
