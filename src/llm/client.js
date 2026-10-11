'use strict';

/**
 * Клиент модели — порт llm/client.py Python-эталона, но без SDK: обычный fetch
 * к OpenAI-совместимому /chat/completions (так работают и deepseek, и ollama, и openai).
 */

const { config } = require('../config');

const PROVIDERS = {
  deepseek: (cfg) => ({
    apiKey: cfg.deepseekApiKey,
    baseUrl: cfg.deepseekBaseUrl,
    model: cfg.deepseekModel,
  }),
  openai: (cfg) => ({
    apiKey: cfg.openaiApiKey,
    baseUrl: cfg.openaiBaseUrl,
    model: cfg.openaiModel,
  }),
  ollama: (cfg) => ({
    apiKey: cfg.ollamaApiKey,
    baseUrl: cfg.ollamaBaseUrl,
    model: cfg.ollamaModel,
  }),
};

class LLMClient {
  constructor({ provider, apiKey, baseUrl, model, timeoutSeconds = 120, maxTokens = null }) {
    this.provider = provider;
    this.apiKey = apiKey;
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.model = model;
    this.timeoutSeconds = timeoutSeconds;
    this.maxTokens = maxTokens;
  }

  static fromConfig(llm = config.llm) {
    const build = PROVIDERS[llm.provider];
    if (!build) throw new Error(`Неизвестный LLM_PROVIDER: ${llm.provider}`);
    const { apiKey, baseUrl, model } = build(llm);
    if (!apiKey) {
      throw new Error(
        `Не задан ключ для LLM_PROVIDER=${llm.provider} (см. .env.example → *_API_KEY)`
      );
    }
    return new LLMClient({
      provider: llm.provider,
      apiKey,
      baseUrl,
      model,
      timeoutSeconds: llm.timeoutSeconds,
      maxTokens: llm.maxTokens,
    });
  }

  /** Порт _token_limit_kwargs: у openai другое имя поля. */
  tokenLimitArgs() {
    if (this.maxTokens == null) return {};
    if (this.provider === 'openai') return { max_completion_tokens: this.maxTokens };
    return { max_tokens: this.maxTokens };
  }

  /**
   * Один запрос к модели с инструментами.
   * @returns {Promise<{content: string, toolCalls: Array<{id: string, name: string, arguments: string}>}>}
   */
  async completeWithTools({ messages, tools, toolChoice = 'auto' }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutSeconds * 1000);
    let response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          tools,
          tool_choice: toolChoice,
          ...this.tokenLimitArgs(),
        }),
        signal: controller.signal,
      });
    } catch (e) {
      if (e.name === 'AbortError') throw new Error(`LLM request timed out after ${this.timeoutSeconds}s`);
      throw new Error(`LLM request failed: ${e.message}`);
    } finally {
      clearTimeout(timer);
    }

    const bodyText = await response.text();
    if (!response.ok) {
      throw new Error(`LLM HTTP ${response.status}: ${bodyText.slice(0, 300)}`);
    }
    let payload;
    try {
      payload = JSON.parse(bodyText);
    } catch (e) {
      throw new Error(`LLM returned non-JSON: ${bodyText.slice(0, 200)}`);
    }
    if (!payload.choices?.length) throw new Error('LLM returned no completion choices');

    const message = payload.choices[0].message || {};
    const toolCalls = (message.tool_calls || []).map((call) => ({
      id: call.id,
      name: call.function?.name,
      arguments: call.function?.arguments || '{}',
    }));
    return { content: message.content || '', toolCalls };
  }
}

module.exports = { LLMClient };
