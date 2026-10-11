'use strict';

/**
 * Меню и кафе — функциями каркаса, без своих запросов:
 *   db.getAllCafesInfo()        — список кафе (миграции/кастомизация каркаса)
 *   db.getCafeInfo(cafeId)      — одно кафе (там же таймзона, нужная для даты заказа)
 *   db.getPricelist(cafeId)     — прайс кафе (меню)
 *   db.getActualPricelist(...)  — только то, что реально есть в графе бота
 *   db.getItemByNameFromDB(...) — позиция по точному названию
 *   db.getPricelistAsString()   — имена позиций строкой (для промпта LLM)
 *
 * Своих SQL-запросов к pricelist/cafes здесь нет — это и есть смысл перехода:
 * источник меню один и тот же, что у каркаса.
 */

const { db } = require('../feedmer');

function toMenuItem(row) {
  return {
    name: row.name,
    price: row.price,
    description: row.description || '',
    weight: row.weight || '',
    stopped: Boolean(row.stopped),
    internalId: row.internalId || null,
    classification: row.classification || null,
    cookingTime: row.cookingTime || null,
  };
}

/** Список кафе. activeOnly — только с isActive !== false. */
async function listCafes({ activeOnly = true } = {}) {
  const cafes = (await db.getAllCafesInfo()) || [];
  const prepared = cafes.map((cafe) => ({
    cafeId: cafe.cafeId,
    cafeName: cafe.cafeName,
    city: cafe.city || null,
    timezone: cafe.timezone || null,
    addrOfCafe: cafe.addrOfCafe || null,
    defaultOrderType: cafe.defaultOrderType || null,
    isActive: cafe.isActive !== false,
  }));
  return activeOnly ? prepared.filter((cafe) => cafe.isActive) : prepared;
}

async function getCafe(cafeId) {
  const cafe = await db.getCafeInfo(Number(cafeId));
  if (!cafe) return null;
  return {
    cafeId: cafe.cafeId,
    cafeName: cafe.cafeName,
    city: cafe.city || null,
    timezone: cafe.timezone || null,
    addrOfCafe: cafe.addrOfCafe || null,
    formalAddrOfCafe: cafe.formalAddrOfCafe || null,
    deliveryPrice: cafe.deliveryPrice ?? null,
    minOrderSum: cafe.minOrderSum ?? null,
  };
}

/** onlyOrderable=true → позиции из графа бота (то, что бот реально предлагает). */
async function getMenu(cafeId, { onlyOrderable = false, superBotId = null } = {}) {
  const rows = onlyOrderable
    ? await db.getActualPricelist(Number(cafeId), superBotId)
    : await db.getPricelist(Number(cafeId));
  return (rows || []).map(toMenuItem);
}

async function getAvailableMenu(cafeId, options = {}) {
  const menu = await getMenu(cafeId, options);
  return menu.filter((item) => !item.stopped);
}

async function findMenuItem(name, cafeId) {
  const row = await db.getItemByNameFromDB(name, Number(cafeId));
  return row ? toMenuItem(row) : null;
}

/** Строка с названиями позиций для промпта агента (как в каркасе для ИИ-сценариев). */
async function menuNamesForPrompt(cafeId) {
  return (await db.getPricelistAsString(Number(cafeId))) || '';
}

module.exports = {
  listCafes,
  getCafe,
  getMenu,
  getAvailableMenu,
  findMenuItem,
  menuNamesForPrompt,
};
