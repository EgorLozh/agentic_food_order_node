# agentic-food-order-node

Бескаркасный бот заказов (Telegram + LLM-агент), переписанный на Node.js так, чтобы **не дублировать
логику каркаса**: заказ пишется кодом FeedMer (`db.saveOrder` / `db.addItem` / `db.addChatId`),
который подключается как библиотека. FeedMer и graphEditor не изменяются.

## Статус

| Часть | Состояние |
|---|---|
| Ядро записи заказа кодом каркаса (`src/feedmer.js`, `src/orders/pickupOrder.js`) | ✅ работает, проверено сквозным тестом |
| Меню и кафе функциями каркаса (`src/menu/feedmerMenu.js`) | ✅ работает (`db.getPricelist`/`getActualPricelist`/`getItemByNameFromDB`/`getAllCafesInfo`) |
| Состояние заказа и 12 инструментов (`src/domain/*`, `src/tools/*`) | ✅ 22 теста + скриптовая беседа `smoke:tools` |
| LLM-агент, оркестрация, сессии (`src/llm/*`, `src/bootstrap/*`, `src/state/*`) | ✅ код и 9 тестов; живая проверка пройдена (`smoke:agent`, заказ 284859) |
| Telegram-бот (`src/bot/*`, `src/index.js`) | ✅ код, 8 тестов, скриптовый прогон `smoke:bot`; ручная проверка владельцем в Telegram пройдена — заказ 284861 (кафе 68) |
| Проверка окружения (`scripts/check-feedmer.js`) | ✅ 19/19 (прайсы кафе 68/72 залиты в тестовую БД) |
| Скрипт выравнивания схемы БД (`scripts/fix-shared-db-schema.sql`) | ✅ применён к тестовой БД |
| Конфиг (`src/config.js`) | ✅ |
| Бенч-сценарии, паритет с Python, деплой | ⏳ этап 4 |

План и риски: [docs/MIGRATION.md](docs/MIGRATION.md).

## Быстрый старт

```bash
npm install
cp .env.example .env      # DB_URL / DB_LOGS_URL как у FeedMer, FEEDMER_LIB_DIR — путь до чекаута FeedMer
npm run check:feedmer     # окружение: код каркаса, коммит, зависимости, схема БД
npm run smoke:order       # создаёт заказ кодом каркаса, читает обратно, удаляет за собой
npm run smoke:menu        # кафе и меню функциями каркаса
npm test                  # правила даты/таймзоны и меток оплаты
```

Если `smoke:order` падает на `chatids`/`pk_orders` — сначала выравнивание схемы:

```bash
psql -h localhost -U <user> -d testing -v ON_ERROR_STOP=1 -f scripts/fix-shared-db-schema.sql
```

## Как подключается код каркаса

```
src/feedmer.js
  ├─ выставляет process.env.DB_URL / DB_LOGS_URL (нужны DBlib.js до require) и TESTING
  ├─ объявляет глобалы, которые в каркасе ставит scenarios.js/index.js: logEr, timeLog, logAI, sleep
  ├─ добавляет наш node_modules в NODE_PATH (у FeedMer своего node_modules нет)
  └─ require('<FEEDMER_LIB_DIR>/DBlib.js') → тот же объект db, что у каркаса
```

Создание заказа (`src/orders/pickupOrder.js`) — вызовы каркаса: `getUserIdByTelegramChatId` →
`addNewUser` → `addChatId` → `addItem` (строка на единицу) → `saveOrder`. На нашей стороне остаются
только мелкие правила, живущие в `scenarios.js` (не импортируется целиком): дата заказа в таймзоне
кафе, маппинг оплаты в `payway_type`, `deliverysum=0` / `ASAP=false` / `deliveryTimeFinish=null`
для самовывоза.

Меню и кафе (`src/menu/feedmerMenu.js`) — тоже функции каркаса, своих SQL к `pricelist`/`cafes` нет:
`getAllCafesInfo`, `getCafeInfo` (в том числе таймзона для даты заказа), `getPricelist`,
`getActualPricelist` (только позиции из графа бота), `getItemByNameFromDB`, `getPricelistAsString`
(строка названий для промпта LLM).

## Проверки

```bash
npm test            # 31 тест: правила заказа, матчер, инструменты, агент/оркестрация на подменённой модели
npm run smoke:order # сквозной заказ кодом каркаса + чтение из БД + уборка
npm run smoke:menu  # кафе и меню функциями каркаса
npm run smoke:tools # скриптовая беседа без LLM: инструменты → заказ в БД
npm run smoke:agent # живая переписка агента с моделью (нужен ключ в .env)
npm run smoke:bot   # тот же сервис, что у telegraf: диалог → заказ в БД → уведомление админа
npm start           # запуск бота (нужен свободный BOT_TOKEN)
npm run check:feedmer # окружение: код каркаса, коммит, зависимости, схема БД
npm run seed:pricelist 68 72  # прайс кафе из его Google-таблицы штатным писателем каркаса (db.updatePricelist)
```

Ключи моделей вписываются в `.env` (шаблон — `.env.example`): `LLM_PROVIDER` +
`DEEPSEEK_API_KEY` / `OPENAI_API_KEY` / локальная `OLLAMA_*`.

Паритет с каркасом теперь структурный: заказ пишут те же функции (`db.saveOrder`, `db.addItem`),
а не наша копия SQL, поэтому сверка «наш SQL vs SQL каркаса» из Python-версии больше не нужна.
