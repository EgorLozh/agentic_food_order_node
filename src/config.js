'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

function required(name, value) {
  if (!value) throw new Error(`Не задана переменная окружения ${name} (см. .env.example)`);
  return value;
}

const config = {
  botToken: process.env.BOT_TOKEN || null,
  adminTelegramId: process.env.ADMIN_TELEGRAM_ID ? Number(process.env.ADMIN_TELEGRAM_ID) : null,

  llm: {
    provider: process.env.LLM_PROVIDER || 'deepseek',
    deepseekApiKey: process.env.DEEPSEEK_API_KEY || null,
    deepseekModel: process.env.DEEPSEEK_MODEL || 'deepseek-flash',
    deepseekBaseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
    openaiApiKey: process.env.OPENAI_API_KEY || null,
    openaiModel: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    openaiBaseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    ollamaApiKey: process.env.OLLAMA_API_KEY || 'ollama',
    ollamaModel: process.env.OLLAMA_MODEL || 'gemma4:26b',
    ollamaBaseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434/v1',
    timeoutSeconds: Number(process.env.LLM_TIMEOUT_SECONDS || 120),
    maxTokens: process.env.LLM_MAX_TOKENS ? Number(process.env.LLM_MAX_TOKENS) : null,
  },

  agent: {
    turnTimeoutSeconds: Number(process.env.AGENT_TURN_TIMEOUT_SECONDS || 90),
    historyLimit: Number(process.env.DIALOG_HISTORY_LIMIT || 6),
  },

  bot: {
    notifyAdmin: process.env.ORDER_NOTIFY_ADMIN === '1',
  },

  // Тот же код каркаса пишет заказ, поэтому и переменные те же.
  db: {
    url: process.env.DB_URL || null,
    logsUrl: process.env.DB_LOGS_URL || process.env.DB_URL || null,
    testing: process.env.TESTING === '1',
  },

  feedmer: {
    libDir: process.env.FEEDMER_LIB_DIR || path.resolve(__dirname, '..', '..', 'FeedMer'),
    dbFile: process.env.FEEDMER_DB_FILE || null,
  },

  order: {
    sourceTag: process.env.ORDER_SOURCE_TAG || 'agentic',
    defaultCafeId: process.env.ORDERS_DEFAULT_CAFE_ID ? Number(process.env.ORDERS_DEFAULT_CAFE_ID) : null,
  },

  google: {
    // Тот же service account, что у каркаса: из него синкается прайс кафе (лист «Общий справочник»)
    serviceAccountJson: process.env.GOOGLE_SERVICE_ACCOUNT_JSON || null,
    spreadsheetId: process.env.SPREADSHEET_ID || null,
    pricelistSheetTitle: process.env.PRICELIST_SHEET_TITLE || 'Общий справочник',
  },
};

function assertDbConfig() {
  required('DB_URL', config.db.url);
  required('DB_LOGS_URL', config.db.logsUrl);
}

module.exports = { config, assertDbConfig };
