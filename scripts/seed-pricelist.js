'use strict';

/**
 * Заливка прайса кафе из его Google-таблицы (лист «Общий справочник») — штатным писателем каркаса
 * db.updatePricelist (DBlib.js:437). Читаем таблицу так же, как это делает каркас
 * (google_sheets_module/speadsheet.js getPricelist: те же колонки, фильтры и формат строк).
 *
 * Запуск: node scripts/seed-pricelist.js [cafeId ...]     (по умолчанию 68 72)
 */

const { GoogleSpreadsheet } = require('google-spreadsheet');
const { config } = require('../src/config');
const { db } = require('../src/feedmer');

const DEFAULT_CAFES = [68, 72];
const INTERNAL_COLUMN = 4; // «Наименование в Headline»

function toRows(rawData, cafeId, internalSystem) {
  const name = (rawData[0] ?? '').trim();
  const description = rawData[1] ?? '';
  const weight = rawData[2] ?? '';
  const parsed = parseInt(rawData[3], 10);
  const price = Number.isNaN(parsed) ? 0 : parsed;
  let internalName = rawData[INTERNAL_COLUMN] ?? null;
  if (internalSystem === 'rkeeper') internalName = rawData[6] ?? null;
  // порядок колонок как в db.updatePricelist: name, description, weight, price, cafeId,
  // internalId, classification, cookingTime, status
  return [name, description, weight, price, cafeId, internalName, null, null, 'available'];
}

async function readPricelistFromSheet(ssBackId) {
  const credentials = JSON.parse(config.google.serviceAccountJson);
  const doc = new GoogleSpreadsheet(ssBackId);
  await doc.useServiceAccountAuth(credentials);
  await doc.loadInfo();

  const sheet = doc.sheetsByTitle[config.google.pricelistSheetTitle];
  if (!sheet) {
    throw new Error(
      `в таблице нет листа «${config.google.pricelistSheetTitle}» (есть: ${Object.keys(doc.sheetsByTitle).join(', ')})`
    );
  }
  const rows = await sheet.getRows();
  if (!rows || !rows.length) return { rows: [], internalSystem: null };

  const first = rows[0];
  let internalSystem = null;
  const headers = Object.keys(first).concat(first._rawData ? [] : []);
  const headerRow = (first._sheet?.headerValues || headers).join('|');
  if (headerRow.includes('Наименование в RKeeper')) internalSystem = 'rkeeper';
  else if (headerRow.includes('Наименование в Headline')) internalSystem = 'headline';

  // фильтр каркаса: есть цена и есть название
  const filled = rows.filter(
    (row) => row._rawData && row._rawData.length >= 3 && row._rawData[3] !== '' && (row._rawData[0] ?? '').trim() !== ''
  );
  return { rows: filled.map((row) => toRows(row._rawData, 0, internalSystem)), internalSystem, total: rows.length };
}

(async () => {
  const cafeIds = process.argv.slice(2).map(Number).filter(Boolean);
  const targets = cafeIds.length ? cafeIds : DEFAULT_CAFES;

  if (!config.google.serviceAccountJson) {
    console.error('Не задан GOOGLE_SERVICE_ACCOUNT_JSON в .env — читать таблицу нечем');
    process.exit(2);
  }

  let failed = 0;
  for (const cafeId of targets) {
    try {
      const cafe = await db.getCafeInfo(cafeId);
      if (!cafe) {
        console.error(`кафе ${cafeId}: не найдено`);
        failed += 1;
        continue;
      }
      if (!cafe.ssBackId) {
        console.error(`кафе ${cafeId}: нет ssBackId — таблицы нет`);
        failed += 1;
        continue;
      }

      const { rows, internalSystem, total } = await readPricelistFromSheet(cafe.ssBackId);
      if (!rows.length) {
        console.error(`кафе ${cafeId}: в листе «${config.google.pricelistSheetTitle}» нет позиций с ценой`);
        failed += 1;
        continue;
      }

      const forCafe = rows.map((row) => {
        const copy = [...row];
        copy[4] = cafeId; // cafeId в строке
        return copy;
      });

      const message = await db.updatePricelist(forCafe, cafeId); // писатель каркаса
      const after = await db.getPricelist(cafeId);
      console.log(
        `кафе ${cafeId} «${cafe.cafeName}»: в листе строк ${total}, к записи ${forCafe.length}, ` +
          `internalSystem=${internalSystem ?? '—'}, в БД после синка ${after.length}` +
          (message ? ` | сообщение каркаса: ${message.trim()}` : '')
      );
      if (after.length !== forCafe.length) {
        console.error(`  ВНИМАНИЕ: записали ${forCafe.length}, а в БД ${after.length}`);
        failed += 1;
      }
    } catch (e) {
      console.error(`кафе ${cafeId}: ошибка — ${e.message}`);
      failed += 1;
    }
  }

  console.log(failed ? `\nкафе с ошибками: ${failed}` : '\nпрайсы залиты');
  process.exit(failed ? 1 : 0);
})();
