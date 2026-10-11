'use strict';

/**
 * Подключение кода каркаса FeedMer как библиотеки.
 *
 * FeedMer не патчится и не копируется: мы делаем require его DBlib.js из чекаута
 * (FEEDMER_LIB_DIR) и получаем тот же объект db, которым пользуется сам каркас —
 * включая db.saveOrder / db.addItem, т.е. единственные INSERT в orders/items.
 *
 * Что нужно помнить (проверено экспериментом):
 *  1) DBlib.js создаёт пул при require и читает process.env.DB_URL / DB_LOGS_URL;
 *  2) в каркасе часть глобалов ставит сам DBlib, часть — scenarios.js/index.js,
 *     поэтому logEr/timeLog/logAI объявляем у себя (иначе функция молча упадёт);
 *  3) у FeedMer нет своего node_modules — его bare-импорты (pg, moment-timezone,
 *     pg-format, chalk, node-fetch, pino, @google/maps) резолвим в наши через NODE_PATH.
 */

const path = require('path');
const Module = require('module');

const { config, assertDbConfig } = require('./config');

assertDbConfig();

// (1) переменные каркаса должны быть выставлены ДО require('./DBlib.js')
process.env.DB_URL = config.db.url;
process.env.DB_LOGS_URL = config.db.logsUrl;
if (config.db.testing) process.env.TESTING = '1';

// (3) резолвим зависимости каркаса в наш node_modules
const ourNodeModules = path.resolve(__dirname, '..', 'node_modules');
const nodePath = [ourNodeModules, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
if (process.env.NODE_PATH !== nodePath) {
  process.env.NODE_PATH = nodePath;
  Module._initPaths();
}

// (2) глобалы, которые каркас ожидает
/* eslint-disable no-console */
global.logEr = (...args) => console.error('[feedmer logEr]', ...args);
global.logAI = () => {};
global.timeLog = () => {};
global.sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/* eslint-enable no-console */

const feedmerDbFile = config.feedmer.dbFile || path.join(config.feedmer.libDir, 'DBlib.js');

let db;
try {
  db = require(feedmerDbFile);
} catch (e) {
  throw new Error(
    `Не удалось подключить код каркаса из ${feedmerDbFile}: ${e.message}\n` +
      'Проверь FEEDMER_LIB_DIR (путь до чекаута FeedMer) и что в нашем node_modules есть его зависимости.'
  );
}

if (typeof db.saveOrder !== 'function' || typeof db.addItem !== 'function') {
  throw new Error(
    `В ${feedmerDbFile} нет saveOrder/addItem — похоже, это не DBlib.js каркаса или другая версия.`
  );
}

module.exports = { db, feedmerDbFile };
