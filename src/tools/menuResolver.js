'use strict';

/**
 * Разрешение названий позиций и точек самовывоза — порт tools/menu.py Python-эталона
 * (MenuMatcher._score_match, resolve_pickup_point, resolve_items_from_names).
 * Пороги сохранены (0.4 / 0.75 / 0.85), чтобы поведение совпадало с эталоном.
 */

const STOPWORDS = new Set(['для', 'и', 'с', 'на', 'в', 'из', 'по', 'без', 'или', 'the', 'a', 'of']);

const PROTEIN_TOKENS = [
  'куриная', 'куриный', 'куриную', 'куриной',
  'свиная', 'свиной', 'свиную',
  'говяжья', 'говяжий', 'говяжью',
  'сырная', 'сырный', 'сырную',
  'веган', 'веганская',
];

const SUFFIXES = [
  'ами', 'ями', 'ов', 'ев', 'ам', 'ям', 'ах', 'ях', 'ую', 'ая', 'ое', 'ые', 'ие', 'ый', 'ий', 'ой',
  'у', 'ы', 'и', 'а', 'я', 'е', 'о',
];

function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function significantTokens(text) {
  const tokens = new Set();
  for (const token of normalize(text).split(' ')) {
    if (!token || STOPWORDS.has(token)) continue;
    if (/^\d+г?$/.test(token)) continue;
    if (token.length < 2) continue;
    tokens.add(token);
  }
  return tokens;
}

function stemToken(token) {
  if (token.length <= 4) return token;
  for (const suffix of SUFFIXES) {
    if (token.endsWith(suffix) && token.length - suffix.length >= 4) {
      return token.slice(0, -suffix.length);
    }
  }
  return token;
}

function stemmed(tokens) {
  return new Set([...tokens].map(stemToken));
}

/** Аналог difflib.SequenceMatcher(None, a, b).ratio() через LCS. */
function ratio(a, b) {
  if (!a.length && !b.length) return 1;
  if (!a.length || !b.length) return 0;
  const prev = new Array(b.length + 1).fill(0);
  const curr = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1]);
    }
    for (let j = 0; j <= b.length; j += 1) {
      prev[j] = curr[j];
      curr[j] = 0;
    }
  }
  let matched = 0;
  for (let j = 0; j <= b.length; j += 1) matched = Math.max(matched, prev[j]);
  return (2 * matched) / (a.length + b.length);
}

function stemsCompatible(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 2) return false;
  return ratio(a, b) >= 0.85;
}

function fuzzyStemOverlap(queryStems, nameStems) {
  if (!queryStems.size) return 0;
  let matched = 0;
  for (const qs of queryStems) {
    if ([...nameStems].some((ns) => stemsCompatible(qs, ns))) matched += 1;
  }
  return matched / queryStems.size;
}

function proteinStems(stems) {
  const proteins = new Set(PROTEIN_TOKENS.map(stemToken));
  return new Set([...stems].filter((s) => [...proteins].some((p) => stemsCompatible(s, p))));
}

/** Точный счёт совпадения (порт _score_match). */
function scoreMatch(query, candidate, aliases = []) {
  const q = normalize(query);
  if (!q) return 0;
  const names = [normalize(candidate), ...aliases.map(normalize)];
  if (names.includes(q)) return 1;

  for (const name of names) {
    if (q === name) return 1;
    if (q.length >= 4 && (name.startsWith(`${q} `) || name.endsWith(` ${q}`))) return 0.9;
    if (name.length >= 4 && (q.startsWith(`${name} `) || q.endsWith(` ${name}`))) return 0.9;
  }

  const qTokens = significantTokens(query);
  const qStems = stemmed(qTokens);
  if (!qTokens.size) return 0;

  let best = 0;
  for (const name of names) {
    const nameTokens = significantTokens(name);
    const nameStems = stemmed(nameTokens);
    if (!nameTokens.size) continue;

    const stemOverlap = fuzzyStemOverlap(qStems, nameStems);
    const intersect = [...qTokens].filter((t) => nameTokens.has(t)).length;
    const tokenOverlap = intersect / Math.max(qTokens.size, 1);
    let overlap = Math.max(stemOverlap, tokenOverlap);

    const qProteins = proteinStems(qStems);
    const nameProteins = proteinStems(nameStems);
    let proteinOk = true;
    if (qProteins.size) {
      const anyCompatible = (a, b) => [...a].some((x) => [...b].some((y) => stemsCompatible(x, y)));
      if (nameProteins.size && !anyCompatible(qProteins, nameProteins)) {
        proteinOk = false;
        overlap *= 0.35;
      } else if (!anyCompatible(qProteins, nameStems)) {
        proteinOk = false;
        overlap *= 0.45;
      }
    }

    const raw = ratio(q, name);
    let ratioScore = raw * 0.85;
    if (!proteinOk) ratioScore = Math.min(ratioScore, 0.32);
    if (stemOverlap === 0) ratioScore = Math.min(ratioScore, 0.38);

    let score = Math.max(overlap, ratioScore);
    if (overlap < 0.35 && raw < 0.72) score = Math.min(score, 0.35);
    best = Math.max(best, score);
  }
  return best;
}

class MenuMatcher {
  /** menu: [{ name, price, aliases? }]; доступные — у кого stopped !== true */
  constructor(menu) {
    this.menu = menu.filter((item) => !item.stopped && item.name && item.name.trim());
  }

  resolveItem(name, qty) {
    const query = String(name ?? '').trim();
    if (!query) return { item: null, candidates: [] };

    const exact = this.menu.find((item) => item.name === query);
    if (exact) return { item: this.toOrderItem(exact, qty), candidates: [] };

    const scored = this.menu
      .map((item) => ({ item, score: scoreMatch(query, item.name, item.aliases || []) }))
      .filter((row) => row.score > 0.4)
      .sort((a, b) => b.score - a.score);

    if (!scored.length) return { item: null, candidates: [] };

    const [best, runnerUp] = scored;
    if (best.score >= 0.85) return { item: this.toOrderItem(best.item, qty), candidates: [] };
    if (best.score >= 0.75 && (scored.length === 1 || best.score - runnerUp.score >= 0.15)) {
      return { item: this.toOrderItem(best.item, qty), candidates: [] };
    }

    const floor = Math.max(0.45, best.score * 0.85);
    const candidates = scored
      .slice(0, 5)
      .filter((row) => row.score >= floor)
      .slice(0, 3)
      .map((row) => row.item.name);
    return { item: null, candidates };
  }

  static toOrderItem(item, qty) {
    return {
      skuId: item.name, // в FeedMer-pricelist идентификатор позиции — её название
      name: item.name,
      qty,
      unitPrice: item.price,
    };
  }

  toOrderItem(item, qty) {
    return MenuMatcher.toOrderItem(item, qty);
  }
}

/** Порт resolve_pickup_point: (point, []) | (null, candidates) | (null, []). */
function resolvePickupPoint(query, points) {
  if (!query) return { point: null, candidates: [] };
  const stripped = String(query).trim();
  const active = points.filter((point) => point.active !== false);

  const exact = active.filter((point) => point.name === stripped);
  if (exact.length === 1) return { point: exact[0], candidates: [] };
  if (exact.length > 1) return { point: null, candidates: exact };

  const scored = active
    .map((point) => ({ point, score: scoreMatch(stripped, point.name, point.aliases || []) }))
    .filter((row) => row.score >= 0.75)
    .sort((a, b) => b.score - a.score);

  if (!scored.length) return { point: null, candidates: [] };
  const [best, runnerUp] = scored;
  if (scored.length === 1 || best.score - runnerUp.score >= 0.15) {
    return { point: best.point, candidates: [] };
  }
  const floor = Math.max(0.75, best.score - 0.15);
  return { point: null, candidates: scored.filter((row) => row.score >= floor).map((row) => row.point) };
}

/** Порт resolve_items_from_names: [{name, qty}] → { resolved, clarifications }. */
function resolveItemsFromNames(menu, rawItems) {
  const matcher = new MenuMatcher(menu);
  const resolved = [];
  const clarifications = [];
  for (const { name, qty } of rawItems) {
    const { item, candidates } = matcher.resolveItem(name, qty);
    if (item) resolved.push(item);
    else clarifications.push({ rawName: name, candidates });
  }
  return { resolved, clarifications };
}

module.exports = {
  normalize,
  ratio,
  scoreMatch,
  MenuMatcher,
  resolvePickupPoint,
  resolveItemsFromNames,
};
