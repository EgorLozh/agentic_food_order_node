# agentic-food-order-node

Бескаркасный бот заказов (Telegram + LLM-агент), переписанный на Node.js так, чтобы **не дублировать
логику каркаса**: заказ пишется кодом FeedMer (`db.saveOrder` / `db.addItem` / `db.addChatId`),
который подключается как библиотека. FeedMer и graphEditor не изменяются.

## Статус

| Часть | Состояние |
|---|---|
| Ядро записи заказа кодом каркаса (`src/feedmer.js`, `src/orders/pickupOrder.js`) | ✅ работает, проверено сквозным тестом |
| Скрипт выравнивания схемы БД (`scripts/fix-shared-db-schema.sql`) | ✅ применён к тестовой БД |
| Конфиг (`src/config.js`) | ✅ |
| Telegram-бот (aiogram → telegraf/grammy) | ⏳ не портирован |
| LLM-агент и tools (`order_agent`, `order_agent_tools`) | ⏳ не портирован |
| Меню из Google Sheets, бенч, тесты | ⏳ не портированы |

План и риски: [docs/MIGRATION.md](docs/MIGRATION.md).

## Быстрый старт

```bash
npm install
cp .env.example .env      # DB_URL / DB_LOGS_URL как у FeedMer, FEEDMER_LIB_DIR — путь до чекаута FeedMer
npm run smoke:order       # создаёт заказ кодом каркаса, читает обратно, удаляет за собой
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

## Проверки

```bash
npm test            # правила заказа (дата/таймзона, метки оплаты)
npm run smoke:order # сквозной заказ кодом каркаса + чтение из БД + уборка
```

Паритет с каркасом теперь структурный: заказ пишут те же функции (`db.saveOrder`, `db.addItem`),
а не наша копия SQL, поэтому сверка «наш SQL vs SQL каркаса» из Python-версии больше не нужна.
