'use strict';

/**
 * Проверка окружения перед запуском сервиса: где код каркаса, какие версии,
 * есть ли нужные зависимости и колонки в БД.
 * Запуск: npm run check:feedmer
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { config } = require('../src/config');

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
}

// 1. Чекаут каркаса
const libDir = config.feedmer.libDir;
const dbFile = config.feedmer.dbFile || path.join(libDir, 'DBlib.js');
check('FeedMer: найден DBlib.js', fs.existsSync(dbFile), dbFile);
for (const extra of ['utils.js', path.join('helper_modules', 'validations.js'), path.join('helper_modules', 'logger.js')]) {
  check(`FeedMer: ${extra}`, fs.existsSync(path.join(libDir, extra)), path.join(libDir, extra));
}

// 2. Коммит каркаса — его надо фиксировать в деплое
let commit = '—';
try {
  commit = execFileSync('git', ['-C', libDir, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
} catch (e) {
  commit = `не определить (${e.message.split('\n')[0]})`;
}
check('FeedMer: коммит', commit !== '—', commit);

// 3. Зависимости, которые требует DBlib.js
for (const dep of ['pg', 'moment-timezone', 'pg-format', 'chalk', 'node-fetch', 'pino', '@google/maps']) {
  let version = null;
  try {
    version = require(`${dep}/package.json`).version; // eslint-disable-line global-require, import/no-dynamic-require
  } catch (e) {
    version = null;
  }
  check(`зависимость ${dep}`, Boolean(version), version || 'не установлена');
}

// 4. Конфиг БД
check('DB_URL задан', Boolean(config.db.url), config.db.url ? 'задан' : 'нет');
check('DB_LOGS_URL задан', Boolean(config.db.logsUrl), config.db.logsUrl ? 'задан' : 'нет');

// 5. Схема БД, без которой функции каркаса падают (иногда молча)
(async () => {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: config.db.url });
  try {
    const q = async (sql, params = []) => (await pool.query(sql, params)).rows;
    const hasColumn = async (table, column) =>
      (await q(
        `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
        [table, column]
      )).length > 0;

    check('orders.pk_orders имеет sequence/default', (await q(`
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'orders' AND column_name = 'pk_orders' AND column_default IS NOT NULL
    `)).length > 0, 'иначе db.saveOrder упадёт');

    check('items.id — identity', (await q(`
      SELECT 1 FROM pg_attribute
      WHERE attrelid = 'items'::regclass AND attname = 'id' AND attidentity <> ''
    `)).length > 0, 'иначе db.addItem упадёт');

    check('chatids.max_chatid существует', await hasColumn('chatids', 'max_chatid'), 'иначе db.addChatId молча не создаст связку');

    const items = await q(`SELECT count(*)::int AS n FROM pricelist`);
    check('pricelist не пуст', items[0].n > 0, `позиций: ${items[0].n}`);

    const missing = await q(`
      SELECT "cafeId", count(*)::int AS n FROM pricelist GROUP BY 1 ORDER BY 1
    `);
    const cafes = await q('SELECT "cafeId" FROM cafes WHERE "isActive" ORDER BY "cafeId"');
    const withMenu = new Set(missing.map((r) => r.cafeId));
    const empty = cafes.map((c) => c.cafeId).filter((id) => !withMenu.has(id));
    check('у всех активных кафе есть прайс', empty.length === 0, empty.length ? `пусто у: ${empty.join(', ')}` : 'да');
  } catch (e) {
    check('подключение к БД', false, e.message);
  } finally {
    await pool.end();
  }

  console.log('Проверка окружения (npm run check:feedmer)\n');
  const width = Math.max(...checks.map((c) => c.name.length));
  for (const c of checks) {
    console.log(`  ${c.ok ? '✅' : '❌'} ${c.name.padEnd(width)}  ${c.detail}`);
  }
  const failed = checks.filter((c) => !c.ok);
  console.log(`\nИтого: ${checks.length - failed.length}/${checks.length} ok`);
  process.exit(failed.length ? 1 : 0);
})();
