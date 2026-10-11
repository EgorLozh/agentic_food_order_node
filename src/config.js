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
};

function assertDbConfig() {
  required('DB_URL', config.db.url);
  required('DB_LOGS_URL', config.db.logsUrl);
}

module.exports = { config, assertDbConfig };
