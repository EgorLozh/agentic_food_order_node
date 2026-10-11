# План миграции на Node.js с использованием кода FeedMer как библиотеки

Дата: 11.10.2026. Orig: `D:\agentic_food_order` (Python). Новый проект: `D:\agentic_food_order_node`.
FeedMer (`D:\FeedMer`) и graphEditor не изменяются ни в одном пункте плана.

## 1. Зачем миграция

Требование заказчика — не дублировать код создания заказа. В Python-версии логика каркаса была
воспроизведена (SQL + правила): паритет проверен, но это всё равно две реализации. В Node-версии
заказ пишет **сам код каркаса**, поэтому бизнес-логика заказа существует в одном месте.

## 2. Что уже проверено экспериментом

```
src/feedmer.js  → require('D:\FeedMer\DBlib.js')   (FeedMer не патчится)
src/orders/pickupOrder.js
  → db.getUserIdByTelegramChatId / db.addNewUser / db.addChatId
  → db.addItem ×N
  → db.saveOrder(...)  → pk_orders (единственный INSERT INTO orders в кодовой базе FeedMer)
  → db.getOrderSum(pk) = сумма позиций
```

Результат `npm run smoke:order`: заказ `pk_orders=284853`, `strdate=11.10.2026`,
`payway=картой при получении`, `deliverysum=0`, `isDelivery=false`, позиции
`300/300/110` (строка на единицу), сумма 710 ₽, `items.id` выдан identity — и всё это кодом каркаса.

## 3. Что выяснилось при подключении (ограничения интеграции)

1. **DBlib.js создаёт пул при `require`** и читает `process.env.DB_URL` + `DB_LOGS_URL` — переменные
   надо выставить до импорта; `TESTING=1` отключает SSL (иначе требование к сертификату прод-БД).
2. **Глобалы.** Часть глобалов ставит сам `DBlib.js` (`logEr`, `getFuncName`), часть — `scenarios.js`/
   `index.js`. Мы объявляем `logEr`, `timeLog`, `logAI`, `sleep` у себя, иначе функции каркаса молча
   падают в `catch`-блоках.
3. **Немой catch — главная опасность.** Пример: `db.addChatId` (DBlib.js:721) глушит ошибку
   `console.log`-ом. В тестовой БД не было колонки `chatids.max_chatid` → связка telegram id → userid
   не создавалась, без исключения. Поэтому после `addChatId` мы проверяем результат и падаем громко.
4. **Схема БД = контракт.** Для работы кода каркаса тестовая БД должна соответствовать миграциям:
   последовательность `orders.pk_orders`, identity `items.id`, ключи и `chatids.max_chatid`.
   Всё это в `scripts/fix-shared-db-schema.sql` (идемпотентно, применено к `testing`).
   Остальные расхождения тестовой БД с миграциями (`chains`, `cafe.chain_id`, `maxBotToken`,
   тип `sentmessages.message_id`) для пути заказа не нужны — оставлены владельцу схемы.
5. **Зависимости.** FeedMer не имеет своего `node_modules` (репозиторий — код). Чтобы `DBlib.js`
   резолвил свои bare-импорты (`pg`, `moment-timezone`, `pg-format`, `chalk@4`, `node-fetch`, `pino`,
   `@google/maps`), мы держим их у себя и добавляем наш `node_modules` в `NODE_PATH` перед импортом.
   Итог: **48 пакетов**, а не весь `package.json` каркаса (там `puppeteer`, `canvas`, `aws-sdk` и т.п.).
   `chalk` обязательно v4 — v5 ESM-only, каркас использует `require`.
6. **Пул каркаса не экспортируется** — своего `pool.end()` у DBlib.js нет, поэтому процесс
   завершается только через `process.exit()` (так делают скрипты) и нельзя импортировать модуль,
   поднимающий БД, из тестов: `node --test` не дождётся слива event loop и тест повиснет.
   Поэтому правила заказа вынесены в `src/orders/rules.js` — без БД, тестируются напрямую.
   Для долгоживущего сервиса корректное закрытие придётся делать своим `pg.Pool` для чтений.
7. **Версия каркаса.** Мы зависим от конкретного коммита FeedMer. Любое изменение `DBlib.saveOrder`/
   `addItem`/`addChatId` меняет контракт нашего сервиса — нужен зафиксированный коммит и тесты на это.

## 4. Что осталось портировать (по файлам Python-версии)

| Python (`D:\agentic_food_order`) | Node (план) | Объём |
|---|---|---|
| `settings.py` | `src/config.js` ✅ | сделано |
| `adapters/postgres_orders.py` | `src/orders/pickupOrder.js` ✅ (теперь через код каркаса) | сделано |
| `adapters/sheets/*` (меню из Google Sheets) | не нужен: меню берём из `pricelist` функциями каркаса ✅ (`src/menu/feedmerMenu.js`); синк листа в `pricelist` делает сам FeedMer | сделано |
| `adapters/postgres_cafes.py` (точки самовывоза) | `db.getAllCafesInfo` / `db.getCafeInfo` ✅ | сделано |
| `llm/client.py` (OpenAI/DeepSeek/Ollama) | `src/llm/client.js` (fetch, без SDK) | S |
| `llm/order_agent.py` (tool-loop, промпт) | `src/llm/orderAgent.js` | M |
| `tools/order_agent_tools.py` (11 tools) | `src/tools/orderTools.js` + `src/state/orderState.js` | M |
| `tools/menu.py` (матчинг меню, алиасы) | `src/tools/menu.js` (поверх `feedmerMenu`) | M |
| `orchestration/orchestrator.py` (таймаут хода) | `src/bot/orchestrator.js` | S |
| `storage/sessions.py` (история диалога) | `src/state/sessions.js` (память или SQLite) | S |
| `bot/*` (aiogram 3) | telegraf/grammy | M |
| `bench/*` (Telethon E2E-сценарии) | `scripts/bench*` (telegram + gramjs) или оставить Python | M |
| `tests/*` (64 теста) | `node:test` + `supertest`-подобные проверки | M |

S/M — грубая оценка (небольшое/среднее).

### 4.1 Что подтвердилось на тестовой БД (меню)

* `db.getPricelist(cafeId)` — 778 позиций у кафе 3 (демо), **0 у кафе 68 и 72**: синк прайса из
  Google-таблицы (`google_sheets_module/speadsheet.js` → `db.updatePricelist`) в тестовой БД не
  выполнялся. Скрипт `check:feedmer` это показывает как ❌.
* У демо-кафе в прайсе есть мусорные строки (2 из 778 — с пустым названием), наша обёртка это
  переживает, но для бота такие позиции надо отфильтровывать.
* `db.getActualPricelist(cafeId, superBotId)` (меню «как в графе бота») на кафе 3 вернул 0 позиций
  при `superBotId = -1` — для агентного бота базовым источником выбран `getPricelist` минус
  `stopped`; `getActualPricelist` оставлен опцией, если нужно ровно то же меню, что у каркасного бота.

## 5. Варианты зависимости от кода FeedMer

| Вариант | Как | Плюсы | Минусы |
|---|---|---|---|
| A. Путь до чекаута (сейчас) | `FEEDMER_LIB_DIR=../FeedMer` | работает сразу, ничего не публикуем | на сервере нужен чекаут FeedMer рядом; версия фиксируется вручную |
| B. git-зависимость | `"feedmer": "git+https://github.com/FeedMer/FeedMer#<commit>"` | фиксированный коммит в `package-lock` | приватный репозиторий: нужны права у CI/прода; тянет весь репозиторий |
| C. Пакет от каркаса | Кирилл публикует `@feedmer/db` (только DBlib + его зависимости) | самый чистый контракт, версии в semver | нужна работа на стороне каркаса |
| D. Без миграции | Python остаётся, заказ пишет каркас через HTTP-эндпоинт | код каркаса — единственный writer, язык не важен | нужна доработка каркаса (эндпоинт) |

Рекомендация: для локальной разработки — A; для прода — B или C. D — если миграция на Node окажется
дороже, чем выгода.

## 6. Что останется «нашим» в любом варианте

Правила из `scenarios.js saveOrder` (дата в таймзоне кафе + сдвиг на завтра, `deliverysum=0`,
`ASAP=false`, `deliveryTimeFinish=null`) и маппинг оплаты в `payway_type` — `scenarios.js` (10 410 строк)
целиком не импортируется: он тянет сокеты, мессенджеры, печать, оплату. Варианты убрать и это:
попросить в каркасе функцию `createPickupOrder(...)`, либо вынести правило в PL/pgSQL-функцию.

## 7. Вариант зависимости (решено)

Репозиторий: https://github.com/EgorLozh/agentic_food_order_node (remote `origin`, ветка `main`).
Код каркаса используется как библиотека из чекаута FeedMer (`FEEDMER_LIB_DIR`), заказчик это
подтвердил («можешь использовать DBlib»). В деплое фиксируем **коммит FeedMer** — его печатает
`npm run check:feedmer`. Открытым остаётся вопрос публикации пакета `@feedmer/db` (вариант C),
чтобы не держать рядом чекаут каркаса.

## 8. Открытые вопросы

1. Портировать бота и агента сразу целиком или поэтапно (сначала «бот + заказ», потом меню/бенч)?
2. Прайс для кафе 68/72 в тестовой БД пуст — кто гоняет синк меню из таблицы (каркас) или заливаем
   сиды для тестов?
3. Python-версию оставляем как эталон для паритета до полного портирования? (рекомендую да)
