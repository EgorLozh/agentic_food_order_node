-- Приведение тестовой БД к схеме, которую ожидает код каркаса FeedMer.
-- Все инструкции идемпотентны, можно запускать повторно.
--
-- Зачем: новый сервис пишет заказ кодом каркаса (db.saveOrder/db.addItem/addChatId),
-- поэтому БД должна соответствовать миграциям FeedMer. В тестовой базе несколько
-- мест отстают (таблицы скопированы без ключей/последовательностей + не применён хвост
-- миграций), из-за чего код каркаса падает, а часть функций глушит ошибку молча.
--
-- Применение:
--   psql -h localhost -U <user> -d testing -v ON_ERROR_STOP=1 -f scripts/fix-shared-db-schema.sql

BEGIN;

-- 1. orders.pk_orders — последовательность + default (как ждёт DBlib.saveOrder:
--    вставка без pk_orders + RETURNING pk_orders)
CREATE SEQUENCE IF NOT EXISTS public.orders_pk_orders_seq;
DO $do$
DECLARE table_owner text;
BEGIN
  SELECT pg_get_userbyid(relowner) INTO table_owner
  FROM pg_class WHERE oid = 'public.orders'::regclass;
  EXECUTE format('ALTER SEQUENCE public.orders_pk_orders_seq OWNER TO %I', table_owner);
  EXECUTE 'ALTER SEQUENCE public.orders_pk_orders_seq OWNED BY public.orders.pk_orders';
END
$do$;
ALTER TABLE public.orders
  ALTER COLUMN pk_orders SET DEFAULT nextval('public.orders_pk_orders_seq'::regclass);
SELECT setval('public.orders_pk_orders_seq',
              (SELECT COALESCE(MAX(pk_orders), 0) + 1 FROM public.orders), false);

-- 2. items.id — identity, как объявлено в миграциях FeedMer (15.04.2022)
DO $do$
DECLARE next_item_id bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute
                 WHERE attrelid = 'public.items'::regclass
                   AND attname = 'id'
                   AND attidentity <> '') THEN
    SELECT COALESCE(MAX(id), 0) + 1 INTO next_item_id FROM public.items;
    EXECUTE format(
      'ALTER TABLE public.items ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (START WITH %s)',
      next_item_id);
  END IF;
END
$do$;

-- 3. Ключи, объявленные в миграциях, но отсутствующие в скопированных таблицах
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'public.orders'::regclass AND contype = 'p') THEN
    ALTER TABLE public.orders ADD CONSTRAINT orders_pkey PRIMARY KEY (pk_orders);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'public.items'::regclass AND contype = 'p') THEN
    ALTER TABLE public.items ADD CONSTRAINT id PRIMARY KEY (id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'items_pk_order_fkey') THEN
    ALTER TABLE public.items ADD CONSTRAINT items_pk_order_fkey
      FOREIGN KEY (pk_order) REFERENCES public.orders (pk_orders) MATCH SIMPLE;
  END IF;
END
$do$;

-- 4. chatids.max_chatid — нужно db.addChatId (DBlib.js:731). Без колонки функция
--    глушит ошибку в try/catch и связка telegram id → userid не создаётся.
ALTER TABLE public.chatids ADD COLUMN IF NOT EXISTS "max_chatid" BIGINT;

-- 5. pricelist.status — нужен db.updatePricelist (DBlib.js:437): каркас вставляет позиции
--    9 колонками, включая status. Миграции FeedMer эту колонку не создают, в тестовой БД её нет,
--    поэтому синк прайса из Google-таблицы через штатный писатель молча падал.
ALTER TABLE public.pricelist ADD COLUMN IF NOT EXISTS status TEXT;

-- 6. chatids.telegram_chatid — int (int4) в миграциях FeedMer, а идентификаторы Telegram
--    давно вышли за int32: аккаунт с id 8 862 284 665 (тестовый для бенча) не влезает, и
--    регистрация клиента падает с «value out of int32 range» — заказ не создаётся ни нашим
--    ботом, ни эталоном. Расширяем до BIGINT (для каркаса это безопасное расширение).
ALTER TABLE public.chatids ALTER COLUMN telegram_chatid TYPE BIGINT;

-- 7. Остальные расхождения тестовой БД с миграциями FeedMer (НЕ автоматизируем —
--    это решения владельца схемы): таблицы chains нет (миграции:1287),
--    cafes.chain_id нет (1292), superbots."maxBotToken" и cafes."maxBotToken"
--    отсутствуют (1283-1284), sentmessages."message_id" остался старым типом (1285).
--    Для пути «создание заказа» они не нужны.

COMMIT;
