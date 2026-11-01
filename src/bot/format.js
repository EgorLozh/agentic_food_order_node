'use strict';

/**
 * Структурное форматирование ответа агента (плоский текст, без parse_mode).
 *
 * Модель пишет содержательно верно, но структуру соблюдает нестабильно: склеивает список
 * в одну строку («Добавил:  • Куриная — 340 ₽  Самовывоз: …»), забывает пустую строку перед
 * итогом и вопросом, ставит по два пробела. Форматтер приводит это к одному виду, не меняя
 * ни слов, ни цен, ни названий — только пробелы и переводы строк.
 *
 * Правила:
 * 1) CRLF/табы → LF и пробелы, хвостовые пробелы убираются, 2+ пробела внутри строки → один;
 * 2) маркер «•» всегда начинает новую строку (в том числе если модель написала «• A • B»);
 * 3) известные поля заказа («Самовывоз», «Оплата», «Телефон», «Время», «Итого», …) — с новой строки;
 * 4) перед «Итого», перед вопросом клиенту и перед блоком «Варианты:» — пустая строка;
 * 5) больше одной пустой строки подряд не бывает, ведущие/хвостовые пустые строки срезаются.
 */

const MAX_REPLY_TEXT = 4096;

/** Поля заказа и служебные метки, которые обязаны стоять с начала строки (длинные — раньше). */
const OWN_LINE_LABELS = [
  'Точка самовывоза',
  'Время самовывоза',
  'Самовывоз',
  'Телефон',
  'Позиции',
  'Оплата',
  'Состав',
  'Клиент',
  'Итого',
  'Адрес',
  'Время',
].sort((a, b) => b.length - a.length);

const OWN_LINE_PATTERN = new RegExp(`\\s+(${OWN_LINE_LABELS.join('|')})\\s*:`, 'g');

/** Начала фраз, которые должны стоять отдельным блоком, а не в хвосте абзаца. */
const QUESTION_STARTERS = [
  'Всё верно',
  'Все верно',
  'Если нужного варианта нет',
  'Что дальше',
  'Что заказываем',
  'С чего начнём',
  'Варианты',
  'Спасибо',
];

const QUESTION_PATTERN = new RegExp(`\\s+(${QUESTION_STARTERS.join('|')})`, 'g');

/** Блоки, перед которыми нужна пустая строка. */
const BLANK_LINE_BEFORE = [
  /^Итого\s*:/i,
  /^Всё верно\?/i,
  /^Всё верно\b/i,
  /^Все верно/i,
  /^Подтверд/i,
  /^Если нужного варианта нет/i,
  /^Варианты\s*:/i,
  /^Осталось\b/i,
  /^Что дальше\?/i,
  /^Спасибо\b/i,
];

/** Строка с «•» в начале: «• Название — 340 ₽», «• 2× Название — 680 ₽». */
const BULLET_LINE = /^\s*•/;

function normalizeSpaces(line) {
  return line
    .replace(/\u00a0/g, ' ')
    .replace(/\t/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trimEnd();
}

/** «Добавил: • A • B» → по строке на каждый пункт. */
function splitInlineBullets(line) {
  if (!line.includes('•')) return [line];
  // уже в начале строки и других маркеров нет — оставляем как есть
  const parts = line.split(/\s*•\s*/);
  const head = parts.shift().trim();
  const items = parts.map((part) => part.trim()).filter(Boolean);
  if (!items.length) return [line];
  if (!head) return items.map((item) => `• ${item}`);
  // заголовок («Добавил:», «Выберите:») остаётся отдельной строкой
  return [head, ...items.map((item) => `• ${item}`)];
}

/**
 * «…, в 14:00 Самовывоз: Raketa… Итого: 340 ₽ … Всё верно?» → по строке на блок.
 * Маркер «•» остаётся приклеенным к своему пункту, а не превращается в отдельную строку.
 */
function breakBlocks(line) {
  const bullet = /^•\s*/.exec(line);
  const prefix = bullet ? bullet[0] : '';
  const rest = bullet ? line.slice(prefix.length) : line;
  const broken = rest
    .replace(OWN_LINE_PATTERN, '\n$1:')
    .replace(QUESTION_PATTERN, '\n$1')
    .split('\n');
  return [prefix + broken[0], ...broken.slice(1).map((piece) => piece.trim())];
}

function collapseBlankLines(lines) {
  const out = [];
  for (const line of lines) {
    const blank = !line.trim();
    if (blank && (!out.length || !out[out.length - 1].trim())) {
      // ведущие пустые строки и повторы схлопываем в одну
      if (!out.length) continue;
      if (!out[out.length - 1].trim()) continue;
    }
    out.push(blank ? '' : line);
  }
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out;
}

/**
 * Пустая строка перед «Итого», вопросом и блоком «Варианты:», а также между списком
 * позиций и следующим блоком (поля, вопрос) — так состав заказа читается отдельно.
 */
function ensureBlankLinesBeforeBlocks(lines) {
  const out = [];
  for (const line of lines) {
    const previous = out.length ? out[out.length - 1] : '';
    const startsBlock =
      line.trim() &&
      previous.trim() &&
      (BLANK_LINE_BEFORE.some((pattern) => pattern.test(line.trim())) ||
        (BULLET_LINE.test(previous) && !BULLET_LINE.test(line)));
    if (startsBlock) out.push('');
    out.push(line);
  }
  return out;
}

/**
 * Приводит текст ответа к читаемому виду. Ничего не перефразирует: только пробелы,
 * переводы строк и позиция «•».
 * @param {string} raw
 * @returns {string}
 */
function formatReply(raw) {
  const text = String(raw ?? '')
    .replace(/\r\n?/g, '\n')
    .slice(0, MAX_REPLY_TEXT);
  if (!text.trim()) return '';

  const lines = [];
  for (const rawLine of text.split('\n')) {
    const line = normalizeSpaces(rawLine);
    for (const part of splitInlineBullets(line)) {
      for (const piece of breakBlocks(part.trimEnd())) {
        lines.push(piece.trimEnd());
      }
    }
  }

  let result = collapseBlankLines(lines);
  result = ensureBlankLinesBeforeBlocks(result);
  result = collapseBlankLines(result);
  return result.join('\n').trim();
}

module.exports = { formatReply, MAX_REPLY_TEXT, OWN_LINE_LABELS, BULLET_LINE, OWN_LINE_PATTERN };
