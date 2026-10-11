'use strict';

/**
 * Проверка: меню и кафе читаются функциями каркаса.
 * Запуск: npm run smoke:menu
 */

const { db } = require('../src/feedmer');
const menu = require('../src/menu/feedmerMenu');

(async () => {
  const cafes = await menu.listCafes({ activeOnly: false });
  console.log(`кафе в общей БД (db.getAllCafesInfo): ${cafes.length}`);
  for (const cafe of cafes) {
    console.log(
      `  cafeId=${cafe.cafeId} «${cafe.cafeName}» tz=${cafe.timezone || '—'} city=${cafe.city || '—'} active=${cafe.isActive}`
    );
  }

  console.log('\nпрайс по кафе (db.getPricelist):');
  let demoCafeId = null;
  for (const cafe of cafes) {
    const items = await menu.getMenu(cafe.cafeId);
    const named = items.filter((item) => item.name && item.name.trim()).length;
    console.log(`  cafeId=${cafe.cafeId}: позиций ${items.length} (с названием ${named})`);
    if (!demoCafeId && named) demoCafeId = cafe.cafeId;
  }

  if (!demoCafeId) {
    console.log('\nНи у одного кафе нет позиций в pricelist — синк меню из таблицы не выполнялся.');
    process.exit(0);
  }

  const items = (await menu.getMenu(demoCafeId)).filter((item) => item.name && item.name.trim());
  console.log(`\nпозиции кафе ${demoCafeId} (первые 5 из ${items.length} с непустым названием):`);
  for (const item of items.slice(0, 5)) {
    console.log(
      `  «${item.name}» — ${item.price} ₽, вес «${item.weight}», stopped=${item.stopped}, internalId=${item.internalId}`
    );
  }

  const probe = items[0].name;
  const found = await menu.findMenuItem(probe, demoCafeId);
  console.log(`\nпоиск позиции по названию (db.getItemByNameFromDB «${probe}») → ${found.price} ₽`);

  const names = await menu.menuNamesForPrompt(demoCafeId);
  console.log(`\nстрока названий для промпта (db.getPricelistAsString): ${names.slice(0, 120)}...`);

  const orderable = await menu.getAvailableMenu(demoCafeId, { onlyOrderable: true });
  console.log(`позиции из графа бота (db.getActualPricelist): ${orderable.length}`);

  // заказ пишем кодом каркаса — здесь проверяем только чтение, поэтому закрываем процесс
  void db;
  process.exit(0);
})().catch((e) => {
  console.error('SMOKE MENU FAILED:', e.message);
  process.exit(1);
});
