'use strict';

// Порт тестов матчера из tests/test_audit_fixes.py Python-эталона.
const test = require('node:test');
const assert = require('node:assert/strict');

const { MenuMatcher, resolvePickupPoint, scoreMatch } = require('../src/tools/menuResolver');

const MENU = [
  { name: 'Кляр для шаурмы', price: 50, stopped: false },
  { name: 'Куриная Мини 200г', price: 250, stopped: false },
  { name: 'Куриная Стандарт 320г', price: 320, stopped: false },
  { name: 'Шаурма', price: 250, stopped: false, aliases: ['шаурму', 'шаверму'] },
];

test('матчер: «куриную шаурму» не привязывается к «Кляр для шаурмы»', () => {
  const { item, candidates } = new MenuMatcher(MENU).resolveItem('куриную шаурму', 1);
  if (item) {
    assert.notEqual(item.name, 'Кляр для шаурмы');
  } else {
    assert.ok(
      !candidates.includes('Кляр для шаурмы') || candidates[0] === 'Шаурма',
      `кандидаты: ${candidates.join(', ')}`
    );
  }
});

test('матчер: опечатка «Куринная мини» → «Куриная Мини 200г»', () => {
  const { item, candidates } = new MenuMatcher(MENU).resolveItem('Куринная мини', 1);
  assert.ok(item, `не разрезолвилось, кандидаты: ${candidates.join(', ')}`);
  assert.equal(item.name, 'Куриная Мини 200г');
  assert.equal(item.qty, 1);
  assert.equal(item.unitPrice, 250);
  assert.equal(item.skuId, 'Куриная Мини 200г');
});

test('матчер: «шаурмы» не подменяется кляром, алиас ведёт на «Шаурма»', () => {
  const { item, candidates } = new MenuMatcher(MENU).resolveItem('шаурмы', 1);
  if (item) assert.notEqual(item.name, 'Кляр для шаурмы');
  else assert.ok(!candidates.includes('Кляр для шаурмы') || candidates[0] === 'Шаурма');
});

test('матчер: точное название выигрывает сразу, stopped не предлагается', () => {
  const { item } = new MenuMatcher(MENU).resolveItem('Куриная Стандарт 320г', 2);
  assert.equal(item.name, 'Куриная Стандарт 320г');
  assert.equal(item.qty, 2);

  const withStopped = new MenuMatcher([...MENU, { name: 'Стоп-позиция', price: 100, stopped: true }]);
  const stopped = withStopped.resolveItem('Стоп-позиция', 1);
  assert.equal(stopped.item, null);
});

test('матчер: мусор не превращается в позицию', () => {
  const { item, candidates } = new MenuMatcher(MENU).resolveItem('абракадабра ксилофон', 1);
  assert.equal(item, null);
  assert.deepEqual(candidates, []);
});

test('точки самовывоза: «Raketa» неоднозначно → кандидаты', () => {
  const points = [
    { pointId: '68', name: 'Raketa на Молодежной 107б', active: true, aliases: [] },
    { pointId: '72', name: 'Raketa на Петрова 29ж', active: true, aliases: [] },
  ];
  const { point, candidates } = resolvePickupPoint('Raketa', points);
  assert.equal(point, null);
  assert.equal(candidates.length, 2);

  const exact = resolvePickupPoint('Raketa на Петрова 29ж', points);
  assert.equal(exact.point.pointId, '72');

  const none = resolvePickupPoint('пиццерия на луне', points);
  assert.equal(none.point, null);
  assert.deepEqual(none.candidates, []);
});

test('scoreMatch: точное совпадение — 1.0, разное — низко', () => {
  assert.equal(scoreMatch('Куриная Мини 200г', 'Куриная Мини 200г'), 1);
  assert.ok(scoreMatch('куриная мини', 'Куриная Мини 200г') > 0.75);
  assert.ok(scoreMatch('лимонад', 'Куриная Мини 200г') < 0.4);
});

test('точка кириллицей и в падеже: «Ракета»/«на Ракете» — та же неоднозначность, а не «не найдено»', () => {
  const points = [
    { pointId: '68', name: 'Raketa на Молодежной 107б', active: true, aliases: [] },
    { pointId: '72', name: 'Raketa на Петрова 29ж', active: true, aliases: [] },
    { pointId: '3', name: 'демо', active: true, aliases: [] },
  ];

  // Раньше прямое сравнение не находило кириллицу, и бот молча брал кафе по умолчанию
  for (const query of ['Ракета', 'Ракете', 'на Ракете']) {
    const { point, candidates } = resolvePickupPoint(query, points);
    assert.equal(point, null, `${query}: точка не должна выбираться молча`);
    assert.equal(candidates.length, 2, `${query}: должны быть обе «Ракеты»`);
  }

  // Уточнение улицей снимает неоднозначность даже в другом алфавите
  assert.equal(resolvePickupPoint('ракета на петрова', points).point.pointId, '72');
  assert.equal(resolvePickupPoint('Молодежной', points).point.pointId, '68');
  assert.equal(resolvePickupPoint('пиццерия на луне', points).point, null);
});
