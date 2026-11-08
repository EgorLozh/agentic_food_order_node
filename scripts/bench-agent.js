'use strict';

/**
 * Замер времени ответа бота и статистика по ходам агента.
 *
 * Гоняет те же BotService + OrderOrchestrator + OrderAgent, что и telegraf (без Telegram),
 * поэтому мерит ровно то, что клиент ждёт между своим сообщением и ответом:
 * LLM-раунды с инструментами, чтение меню из БД каркаса, запись заказа.
 *
 * Запуск:
 *   npm run bench:agent                                   # 2 повтора всех сценариев
 *   BENCH_REPEATS=5 npm run bench:agent                   # больше повторов
 *   BENCH_SCENARIOS=order_happy npm run bench:agent       # только заказ
 *   BENCH_PING=10 npm run bench:agent                     # чистая задержка модели, 10 запросов
 *
 * Пишет: bench/reports/agent-<timestamp>.json и .md, печатает сводку в консоль.
 * Заказы, созданные прогоном, удаляются за собой (как smoke:order).
 */

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const { config } = require('../src/config');
const { LLMClient } = require('../src/llm/client');
const { OrderAgent } = require('../src/llm/orderAgent');
const { OrderOrchestrator } = require('../src/bootstrap/orchestrator');
const { SessionStore } = require('../src/state/sessions');
const { BotService } = require('../src/bot/service');
const { createPickupOrder } = require('../src/orders/pickupOrder');

const REPEATS = Number(process.env.BENCH_REPEATS || 2);
const PING_COUNT = Number(process.env.BENCH_PING || 5);
const ONLY = (process.env.BENCH_SCENARIOS || '').split(',').map((s) => s.trim()).filter(Boolean);
const DISH = process.env.BENCH_DISH || '"Эскимо" куриное на палочке';
const CAFE_QUERY = process.env.BENCH_CAFE || 'демо';
const PICKUP_TIME = process.env.BENCH_TIME || '15:00';
const PHONE = '89001234567';

const SCENARIOS = {
  // Полный заказ: столько ходов клиент реально делает в диалоге
  order_happy: [
    `Здравствуйте! Хочу заказать 2 порции «${DISH.replace(/"/g, '')}»`,
    `Точка самовывоза — ${CAFE_QUERY}`,
    `Заберу в ${PICKUP_TIME}`,
    'Оплата наличными',
    `Телефон ${PHONE}`,
    'Да, всё верно, оформляйте',
  ],
  // Только вопросы по меню — оценка дешёвых ходов без записи заказа
  menu_question: [
    'А что у вас есть из салатов?',
    'Сколько стоит «Оливье»?',
    'А что-нибудь без мяса найдётся?',
  ],
};

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function describe(values) {
  const clean = values.filter((v) => Number.isFinite(v));
  if (!clean.length) return null;
  const sorted = [...clean].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const mean = sum / sorted.length;
  const variance = sorted.reduce((a, b) => a + (b - mean) ** 2, 0) / sorted.length;
  return {
    n: sorted.length,
    min: Math.round(sorted[0]),
    p50: Math.round(percentile(sorted, 0.5)),
    mean: Math.round(mean),
    p90: Math.round(percentile(sorted, 0.9)),
    p95: Math.round(percentile(sorted, 0.95)),
    max: Math.round(sorted[sorted.length - 1]),
    std: Math.round(Math.sqrt(variance)),
  };
}

const fmt = (ms) => (ms == null ? '—' : `${(ms / 1000).toFixed(2)} c`);

async function cleanup(pool, orderIds, telegramIds) {
  const userIds = new Set();
  for (const orderId of orderIds) {
    const row = (await pool.query('SELECT userid FROM orders WHERE pk_orders = $1', [orderId])).rows[0];
    if (row) userIds.add(row.userid);
    await pool.query('DELETE FROM items WHERE pk_order = $1', [orderId]);
    await pool.query('DELETE FROM orders WHERE pk_orders = $1', [orderId]);
  }
  for (const tid of telegramIds) {
    const rows = (await pool.query('SELECT userid FROM chatids WHERE telegram_chatid = $1', [tid])).rows;
    rows.forEach((r) => userIds.add(r.userid));
    await pool.query('DELETE FROM chatids WHERE telegram_chatid = $1', [tid]);
  }
  for (const uid of userIds) {
    await pool.query('DELETE FROM "userInfoExtra" WHERE "userId" = $1', [uid]);
    await pool.query(
      'DELETE FROM users WHERE userid = $1 AND NOT EXISTS (SELECT 1 FROM chatids WHERE userid = $1)',
      [uid]
    );
  }
  return userIds.size;
}

(async () => {
  let llm;
  try {
    llm = LLMClient.fromConfig(config.llm);
  } catch (e) {
    console.error(`BENCH: ${e.message}`);
    process.exit(2);
  }

  const scenarios = ONLY.length
    ? Object.fromEntries(Object.entries(SCENARIOS).filter(([name]) => ONLY.includes(name)))
    : SCENARIOS;
  if (!Object.keys(scenarios).length) {
    console.error(`BENCH: неизвестные сценарии: ${ONLY.join(', ')}`);
    process.exit(2);
  }

  const sessions = new SessionStore({ historyLimit: config.agent.historyLimit });
  const service = new BotService({
    orchestrator: new OrderOrchestrator({
      agent: new OrderAgent({ llm, deps: { submitOrder: createPickupOrder } }),
    }),
    sessions,
    notifier: null, // уведомление админа — сетевой вызов Telegram, в замер ответа не входит
  });

  // Считаем LLM-раунды на ход: это главный драйвер задержки (каждый раунд = один запрос к модели)
  let llmCalls = 0;
  const rawComplete = llm.completeWithTools.bind(llm);
  llm.completeWithTools = async (args) => {
    llmCalls += 1;
    return rawComplete(args);
  };

  const startedAt = new Date();
  console.log(
    `бенч: провайдер ${llm.provider}/${llm.model}, кафе по умолчанию ${
      config.order.defaultCafeId ?? '—'
    }, повторов ${REPEATS}, сценарии: ${Object.keys(scenarios).join(', ')}\n`
  );

  const turns = [];
  const orderIds = [];
  const telegramIds = [];
  let seq = 0;

  for (let repeat = 1; repeat <= REPEATS; repeat += 1) {
    for (const [name, texts] of Object.entries(scenarios)) {
      const telegramUserId = 990010000 + repeat * 100 + (seq % 90);
      seq += 1;
      telegramIds.push(telegramUserId);
      await service.start({ telegramUserId });
      console.log(`--- ${name} #${repeat} (telegram id ${telegramUserId}) ---`);

      for (let i = 0; i < texts.length; i += 1) {
        const text = texts[i];
        const callsBefore = llmCalls;
        const t0 = process.hrtime.bigint();
        const result = await service.handleText({ telegramUserId, text });
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        turns.push({
          scenario: name,
          repeat,
          turn: i + 1,
          text,
          ms: Math.round(ms),
          llmCalls: llmCalls - callsBefore,
          replyLength: (result.replyText || '').length,
          choices: (result.choices || []).length,
          orderId: result.orderId || null,
          error: /произошла ошибка/i.test(result.replyText || '') ? 'agent_error' : null,
        });
        if (result.orderId) orderIds.push(result.orderId);
        console.log(
          `  ход ${i + 1}: ${fmt(Math.round(ms))} (${llmCalls - callsBefore} LLM)  «${text}» → ${(result.replyText || '')
            .slice(0, 70)
            .replace(/\n/g, ' ')}`
        );
      }
    }
  }

  // чистая задержка модели без инструментов — чтобы отделить «модель» от «агент + БД»
  const ping = [];
  for (let i = 0; i < PING_COUNT; i += 1) {
    const t0 = process.hrtime.bigint();
    try {
      await llm.completeWithTools({ messages: [{ role: 'user', content: 'Ответь одним словом: ок' }] });
      ping.push(Math.round(Number(process.hrtime.bigint() - t0) / 1e6));
    } catch (e) {
      console.warn(`ping ${i + 1}: ${e.message}`);
    }
  }

  const all = turns.map((t) => t.ms);
  const firstTurns = turns.filter((t) => t.turn === 1).map((t) => t.ms);
  const restTurns = turns.filter((t) => t.turn > 1).map((t) => t.ms);
  const orderTurns = turns.filter((t) => t.scenario === 'order_happy').map((t) => t.ms);

  const perScenario = {};
  for (const name of Object.keys(scenarios)) {
    perScenario[name] = describe(turns.filter((t) => t.scenario === name).map((t) => t.ms));
  }

  // Распределение числа LLM-раундов на ход: показывает, где задержка растёт
  const callsSorted = turns.map((t) => t.llmCalls).sort((a, b) => a - b);
  const callsDist = {};
  for (const c of callsSorted) callsDist[c] = (callsDist[c] || 0) + 1;
  const llmCallsStats = {
    mean: callsSorted.length ? callsSorted.reduce((a, b) => a + b, 0) / callsSorted.length : null,
    median: percentile(callsSorted, 0.5),
    max: callsSorted.length ? callsSorted[callsSorted.length - 1] : null,
    distribution: callsDist,
  };
  const msPerLlmCall = describe(
    turns.filter((t) => t.llmCalls > 0).map((t) => t.ms / t.llmCalls)
  );

  const totalOrderTimes = [];
  for (let repeat = 1; repeat <= REPEATS; repeat += 1) {
    const series = turns.filter((t) => t.scenario === 'order_happy' && t.repeat === repeat);
    if (series.length) totalOrderTimes.push(series.reduce((a, b) => a + b.ms, 0));
  }

  const report = {
    meta: {
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      host: require('os').hostname(),
      provider: llm.provider,
      model: llm.model,
      defaultCafeId: config.order.defaultCafeId,
      repeats: REPEATS,
      scenarios: Object.keys(scenarios),
      db: String(config.db.url || '').replace(/:\/\/[^@]*@/, '://***@'),
    },
    stats: {
      allTurns: describe(all),
      firstTurn: describe(firstTurns),
      laterTurns: describe(restTurns),
      orderScenarioTurns: describe(orderTurns),
      modelPing: describe(ping),
      fullOrderSum: describe(totalOrderTimes),
      llmCallsPerTurn: llmCallsStats,
      msPerLlmCall,
      perScenario,
    },
    totals: {
      turns: turns.length,
      errors: turns.filter((t) => t.error).length,
      ordersCreated: orderIds.length,
      orderIds,
    },
    turns,
  };

  // уборка: заказы и связи, созданные прогоном
  const pool = new Pool({ connectionString: config.db.url });
  try {
    const removedUsers = await cleanup(pool, orderIds, telegramIds);
    report.totals.cleanedUsers = removedUsers;
    console.log(`\nзаказов создано: ${orderIds.length}, убрано за собой пользователей: ${removedUsers}`);
  } catch (e) {
    console.error('уборка не удалась:', e.message);
  } finally {
    await pool.end().catch(() => {});
  }

  const dir = path.resolve(__dirname, '..', 'bench', 'reports');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = startedAt.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const jsonPath = path.join(dir, `agent-${stamp}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));

  const row = (label, s) =>
    s ? `| ${label} | ${s.n} | ${fmt(s.min)} | ${fmt(s.p50)} | ${fmt(s.mean)} | ${fmt(s.p90)} | ${fmt(s.p95)} | ${fmt(s.max)} | ±${(s.std / 1000).toFixed(2)} c |` : `| ${label} | 0 | — | — | — | — | — | — | — |`;

  const md = [
    `# Время ответа агента (${report.meta.model}, ${report.meta.host})`,
    '',
    `Прогон: ${report.meta.startedAt} → ${report.meta.finishedAt}, повторов ${REPEATS}, ходов ${turns.length}.`,
    '',
    '| Срез | ходов | min | p50 | mean | p90 | p95 | max | σ |',
    '|---|---|---|---|---|---|---|---|---|',
    row('Все ходы', report.stats.allTurns),
    row('Первый ход (холодный)', report.stats.firstTurn),
    row('Последующие ходы', report.stats.laterTurns),
    row('Ходы сценария заказа', report.stats.orderScenarioTurns),
    row('Модель без инструментов', report.stats.modelPing),
    '',
    `LLM-раундов на ход: медиана ${report.stats.llmCallsPerTurn.median}, в среднем ${report.stats
      .llmCallsPerTurn.mean?.toFixed(2)}, максимум ${report.stats.llmCallsPerTurn.max}` +
      ` (распределение: ${Object.entries(report.stats.llmCallsPerTurn.distribution)
        .map(([k, v]) => `${k} раунд(а) × ${v}`)
        .join(', ')}).`,
    `Время на один LLM-раунд: p50 ${fmt(report.stats.msPerLlmCall?.p50)}, p95 ${fmt(report.stats.msPerLlmCall?.p95)}.`,
    '',
    `Полный заказ (сумма всех ходов): ${fmt(report.stats.fullOrderSum?.p50)} медиана, ${fmt(
      report.stats.fullOrderSum?.max
    )} максимум.`,
    '',
    '| Сценарий | ходов | p50 | p95 | max |',
    '|---|---|---|---|---|',
    ...Object.entries(perScenario).map(
      ([name, s]) => `| ${name} | ${s ? s.n : 0} | ${fmt(s?.p50)} | ${fmt(s?.p95)} | ${fmt(s?.max)} |`
    ),
    '',
    `Ошибок агента: ${report.totals.errors}. Создано заказов: ${report.totals.ordersCreated}.`,
    '',
  ].join('\n');
  const mdPath = jsonPath.replace(/\.json$/, '.md');
  fs.writeFileSync(mdPath, md);

  console.log(`\n${md}`);
  console.log(`JSON: ${jsonPath}`);
  console.log(`MD:   ${mdPath}`);
  process.exit(0);
})().catch((e) => {
  console.error('бенч упал:', e.stack || e.message);
  process.exit(1);
});
