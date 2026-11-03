# Деплой на 194.67.124.139 (прод, РФ + AmneziaWG)

Бот работает на сервере в РФ, поэтому весь его исходящий трафик идёт через AmneziaWG-туннель:
без него `api.telegram.org` недоступен (TCP в чёрную дыру, `curl` истекает по таймауту).
Туннель заворачивает **только процесс бота** (по uid), остальной сервер — напрямую.

## Что где лежит

| Что | Путь / имя |
|---|---|
| Код бота (git origin/main) | `/srv/agentic_food_order_node`, пользователь `foodbot` (uid 999) |
| Конфиг | `/srv/agentic_food_order_node/.env`, права `600 foodbot:foodbot` |
| Каркас FeedMer (библиотека) | `/opt/feedmer`, закреплённый коммит `2414bf3f` (в `.feedmer-commit`) |
| Сервис | `foodorder-bot.service` → `/usr/bin/node src/index.js` |
| БД | PostgreSQL 16, база `foodorder`, роль `foodorder`, `127.0.0.1:5432` |
| Туннель | `/etc/amnezia/amneziawg/awg0.conf`, юнит `awg-quick@awg0` |
| Пароль роли БД | `/root/db_pass.txt` |

`/root/FeedMer` (старый чекаут каркаса, его использует `webappdemo.service`) **не трогаем**:
для бота сделана отдельная копия `/opt/feedmer` на нужном коммите, `node_modules` в неё
связаны жёсткими ссылками (`cp -al`), места почти не занимают.

## VPN: AmneziaWG только для uid бота

Конфиг Amnezia (не чистый WireGuard: `Jc/Jmin/Jmax/S1/S2/H1..H4`) не работает с `wg-quick` —
нужен модуль ядра `amneziawg` (PPA `ppa:amnezia/ppa`, DKMS) и `awg-quick`.

```ini
# /etc/amnezia/amneziawg/awg0.conf (фрагмент)
[Interface]
Address = 10.9.0.19/32
MTU = 1280
Table = off                       # маршруты ставим сами, default в main не перехватываем
PostUp = ip route add default dev %i table 100; ip rule add uidrange 999-999 lookup 100 pref 100
[Peer]
AllowedIPs = 0.0.0.0/0
```

Почему `Table = off` + `ip rule uidrange`: с `AllowedIPs = 0.0.0.0/0` обычный `awg-quick`
заменил бы default-маршрут всему серверу — уехали бы SSH, nginx и бот «Автомойки»
(`carwash-candidate`). Правило по uid заворачивает в туннель только процесс `foodbot`.

Проверка:

```bash
sudo -u foodbot curl -4 -s -m 20 https://ifconfig.me      # → 85.137.90.197 (выход VPN)
curl -4 -s -m 10 https://ifconfig.me                      # → 194.67.124.139 (напрямую)
sudo -u foodbot curl -sS "https://api.telegram.org/bot$BOT_TOKEN/getMe"
```

**Грабли ядра.** DKMS собирает модуль только под установленные заголовки, а заголовков
работавшего ядра `6.8.0-85-generic` на зеркалах уже нет (`apt-get download` → «cannot be
downloaded»). Поэтому: `apt-get install --only-upgrade linux-image-virtual linux-headers-virtual`
(ядро 6.8.0-147) → `dkms status` должен показать `amneziawg/1.0.0, 6.8.0-147-generic: installed`
→ перезагрузка. Без перезагрузки модуль не загрузить.

Второй момент: `awg-quick` в этой сборке читает конфиг из `/etc/amnezia/amneziawg/`
(а не `/etc/amneziawg/`, как можно ожидать) — иначе `does not exist` и юнит падает.

## База

Заказы пишет код каркаса, поэтому схема — родная для FeedMer. База собрана из локальной
`testing` без истории заказов:

```bash
pg_dump -d testing --no-owner --no-privileges \
  --exclude-table-data=public.items --exclude-table-data=public.orders -f dump.sql
# на сервере:
gunzip -k dump.sql.gz && psql -h 127.0.0.1 -U foodorder -d foodorder -v ON_ERROR_STOP=1 -f dump.sql
su postgres -c 'psql -d foodorder -v ON_ERROR_STOP=1 -f scripts/fix-shared-db-schema.sql'
```

`fix-shared-db-schema.sql` обязателен: без него нет `orders.pk_orders` sequence, identity у
`items.id` и `chatids.max_chatid`, и `db.saveOrder`/`db.addItem`/`db.addChatId` падают или молчат.

## Обновление кода

```bash
sudo -u foodbot git -C /srv/agentic_food_order_node pull
sudo -u foodbot -H bash -lc 'cd /srv/agentic_food_order_node && npm ci --omit=dev'
sudo systemctl restart foodorder-bot
journalctl -u foodorder-bot -n 30 -o short-iso
```

После рестарта `src/index.js` пишет `.bot-ready` (`pid`, `bot`); статус живого бота —
`systemctl is-active foodorder-bot` и установленное TCP-соединение на `149.154.*:443`
с адреса `10.9.0.19` (`ss -tnp | grep 149.154`).

## Проверки

```bash
sudo -u foodbot -H bash -lc 'cd /srv/agentic_food_order_node && npm run check:feedmer'  # 19/19
sudo -u foodbot -H bash -lc 'cd /srv/agentic_food_order_node && npm test'              # 83/83
sudo -u foodbot -H bash -lc 'cd /srv/agentic_food_order_node && npm run smoke:menu'
sudo -u foodbot -H bash -lc 'cd /srv/agentic_food_order_node && npm run smoke:order'   # пишет и убирает за собой
sudo -u foodbot -H bash -lc 'cd /srv/agentic_food_order_node && npm run smoke:agent'   # живая модель
```

## Грабли, на которые уже наступили

- **CRLF в `.env`.** Файл, собранный на Windows, ломает `dotenv` и `source` в bash
  (`$'\r': command not found`, пароль БД с `\r`). Писать `\n`, проверять `file .env`.
- **`helper_modules/logger.js` пишет `service.log` рядом с каркасом.** Если `/opt/feedmer`
  принадлежит root, pino падает с `EACCES ... /opt/feedmer/service.log` и валит весь процесс.
  Файл должен принадлежать `foodbot`.
- **`/root` закрыт (0700).** Поэтому каркас не читается ботом напрямую; копия в `/opt/feedmer`.
- **Первый старт после смены токена/вебхука** может дать `409 Conflict` (у бота был установлен
  webhook) — `telegraf` с `dropPendingUpdates: true` снимает вебхук, `Restart=always`
  поднимает сервис, второй старт проходит. В журнале это нормальный, а не аварийный сценарий.
- **Telegram отдаёт IPv6 первым**, а туннель только IPv4 → в юните
  `NODE_OPTIONS=--dns-result-order=ipv4first`.
- **Секреты в git не кладём.** `serverpass.txt` и `amnezia_device18.conf` — в `.gitignore`.
