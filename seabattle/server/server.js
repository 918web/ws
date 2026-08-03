'use strict';
/* ============================================================================
   МОРСКОЙ БОЙ — сервер онлайн-режима.
   Без внешних зависимостей: статика + WebSocket + авторитетные правила.

   Ключевое свойство безопасности: расстановка флота хранится ТОЛЬКО на сервере.
   Клиенту никогда не отправляется чужая доска — только результаты выстрелов.
   ========================================================================== */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { handleUpgrade } = require('./ws');
const R = require('./rules');

const PORT = Number(process.env.PORT || 8080);
const ROOT = path.resolve(__dirname, '..', 'game');
const DATA_DIR = process.env.SB_DATA_DIR || path.resolve(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'players.json');
const QUIET = process.env.SB_QUIET === '1';

function log(...a) { if (!QUIET) console.log(new Date().toISOString().slice(11, 19), ...a); }

/* ------------------------------- Хранилище игроков ----------------------- */
const DB = { players: {} };   // nickKey -> { nick, token, wins, losses, shots, hits, sunkShips, lastSeen }

function loadDB() {
  try {
    const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    if (raw && raw.players) DB.players = raw.players;
    log('База игроков загружена:', Object.keys(DB.players).length);
  } catch (e) { /* первый запуск */ }
}
let saveTimer = null;
function saveDB() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(DB_FILE, JSON.stringify(DB, null, 2));
    } catch (e) { log('Ошибка сохранения базы:', e.message); }
  }, 250);
}

const nickKey = n => String(n || '').trim().toLowerCase();
const NICK_RE = /^[0-9A-Za-z\u0410-\u042f\u0430-\u044f\u0401\u0451 _.-]{2,16}$/;

function validNick(nick) {
  const n = String(nick || '').trim().replace(/\s+/g, ' ');
  if (!NICK_RE.test(n)) return null;
  return n;
}

function getPlayerRecord(nick) {
  const key = nickKey(nick);
  if (!DB.players[key]) {
    DB.players[key] = {
      nick, token: crypto.randomBytes(16).toString('hex'),
      wins: 0, losses: 0, shots: 0, hits: 0, sunkShips: 0, games: 0,
      createdAt: Date.now(), lastSeen: Date.now()
    };
    saveDB();
  }
  return DB.players[key];
}

function ratingOf(p) {
  const acc = p.shots ? p.hits / p.shots : 0;
  return Math.round(p.wins * 100 - p.losses * 40 + acc * 120 + p.sunkShips * 2);
}

function leaderboard(limit) {
  return Object.values(DB.players)
    .filter(p => p.games > 0)
    .map(p => ({
      nick: p.nick, wins: p.wins, losses: p.losses, games: p.games,
      accuracy: p.shots ? Math.round(p.hits / p.shots * 100) : 0,
      sunkShips: p.sunkShips, rating: ratingOf(p)
    }))
    .sort((a, b) => b.rating - a.rating || b.wins - a.wins)
    .slice(0, limit || 20);
}

/* --------------------------------- Сессии ---------------------------- */
const clients = new Map();   // clientId -> client
const online = new Map();    // nickKey -> client
const games = new Map();     // gameId -> game
let seq = 1;

function publicPlayer(cl) {
  return { nick: cl.nick, status: cl.game ? 'in_game' : 'idle', rating: ratingOf(cl.record) };
}

function broadcastLobby() {
  const list = Array.from(online.values()).filter(c => c.nick).map(publicPlayer);
  for (const cl of online.values()) {
    if (cl.game) continue;
    cl.sendJSON({ t: 'lobby', players: list.filter(p => nickKey(p.nick) !== nickKey(cl.nick)) });
  }
}

function send(cl, obj) { try { cl.sendJSON(obj); } catch (e) { /* noop */ } }
function fail(cl, code, message) { send(cl, { t: 'error', code, message }); }

/* ------------------------------- Игровая сессия ------------------------ */
function createGame(a, b) {
  const id = 'g' + (seq++);
  const game = {
    id,
    phase: 'placing',            // placing | battle | over
    players: [a, b],
    boards: new Map(),           // clientId -> board
    ready: new Set(),
    stats: new Map(),            // clientId -> {shots,hits,sunk}
    turn: null,
    createdAt: Date.now(),
    rematch: new Set()
  };
  for (const cl of [a, b]) {
    cl.game = game;
    game.stats.set(cl.id, { shots: 0, hits: 0, sunk: 0 });
  }
  games.set(id, game);
  for (const cl of [a, b]) {
    const opp = other(game, cl);
    send(cl, {
      t: 'matchStart',
      gameId: id,
      opponent: { nick: opp.nick, rating: ratingOf(opp.record) }
    });
  }
  broadcastLobby();
  log('Матч', id, a.nick, 'vs', b.nick);
  return game;
}

function other(game, cl) {
  return game.players[0] === cl ? game.players[1] : game.players[0];
}

function startBattle(game) {
  game.phase = 'battle';
  const first = game.players[Math.random() < 0.5 ? 0 : 1];
  game.turn = first;
  game.startedAt = Date.now();
  for (const cl of game.players) {
    send(cl, {
      t: 'battleStart',
      yourTurn: cl === first,
      first: first.nick
    });
  }
  log('Бой', game.id, 'первый ход:', first.nick);
}

function finishGame(game, winner, reason) {
  if (game.phase === 'over') return;
  game.phase = 'over';
  game.turn = null;
  const loser = winner ? other(game, winner) : null;

  for (const cl of game.players) {
    const st = game.stats.get(cl.id) || { shots: 0, hits: 0, sunk: 0 };
    const rec = cl.record;
    if (rec) {
      rec.games++;
      rec.shots += st.shots;
      rec.hits += st.hits;
      rec.sunkShips += st.sunk;
      if (cl === winner) rec.wins++;
      else if (winner) rec.losses++;
    }
  }
  saveDB();

  for (const cl of game.players) {
    const opp = other(game, cl);
    const oppBoard = game.boards.get(opp.id);
    send(cl, {
      t: 'gameOver',
      win: cl === winner,
      reason: reason || 'fleet',
      winner: winner ? winner.nick : null,
      // Флот противника раскрывается только после боя
      reveal: oppBoard ? R.revealShips(oppBoard) : [],
      stats: {
        you: game.stats.get(cl.id),
        opponent: game.stats.get(opp.id)
      },
      record: cl.record ? publicRecord(cl.record) : null
    });
  }
  log('Финал', game.id, reason, winner ? 'победа: ' + winner.nick : 'без победителя');
}

function publicRecord(rec) {
  return {
    nick: rec.nick, wins: rec.wins, losses: rec.losses, games: rec.games,
    accuracy: rec.shots ? Math.round(rec.hits / rec.shots * 100) : 0,
    sunkShips: rec.sunkShips, rating: ratingOf(rec)
  };
}

function leaveGame(cl, reason) {
  const game = cl.game;
  if (!game) return;
  const opp = other(game, cl);
  if (game.phase !== 'over') {
    if (game.phase === 'battle') finishGame(game, opp, reason || 'surrender');
    else {
      game.phase = 'over';
      send(opp, { t: 'opponentLeft', reason: reason || 'left' });
    }
  }
  for (const p of game.players) { if (p.game === game) p.game = null; }
  games.delete(game.id);
  broadcastLobby();
}

/* -------------------------------- Протокол ------------------------------ */
function onMessage(cl, msg) {
  let m;
  try { m = JSON.parse(msg); } catch (e) { return fail(cl, 'bad_json', 'Неверный формат сообщения'); }
  if (!m || typeof m.t !== 'string') return;
  cl.lastSeen = Date.now();

  switch (m.t) {
    case 'ping': return send(cl, { t: 'pong', ts: m.ts || Date.now() });

    /* --- Регистрация / вход по нику --- */
    case 'register': {
      const nick = validNick(m.nick);
      if (!nick) return fail(cl, 'bad_nick', 'Ник: 2–16 символов, буквы, цифры, пробел, . _ -');
      const key = nickKey(nick);
      const rec = DB.players[key];
      // Ник занят другим живым соединением?
      const holder = online.get(key);
      if (holder && holder !== cl) {
        if (!m.token || !rec || m.token !== rec.token) {
          return fail(cl, 'nick_taken', 'Этот ник сейчас занят другим игроком');
        }
        // Переподключение с валидным токеном вытесняет старую сессию
        send(holder, { t: 'kicked', message: 'Вы вошли с другого устройства' });
        leaveGame(holder, 'reconnect');
        holder.nick = null;
        online.delete(key);
      }
      // Защита зарегистрированного ника токеном
      if (rec && m.token && m.token !== rec.token) {
        return fail(cl, 'nick_taken', 'Ник уже занят. Выберите другой');
      }
      if (cl.nick) online.delete(nickKey(cl.nick));
      const record = getPlayerRecord(nick);
      record.nick = nick;
      record.lastSeen = Date.now();
      cl.nick = nick;
      cl.record = record;
      online.set(key, cl);
      saveDB();
      send(cl, { t: 'registered', nick, token: record.token, record: publicRecord(record) });
      broadcastLobby();
      send(cl, { t: 'lobby', players: Array.from(online.values()).filter(c => c.nick && c !== cl && !c.game).map(publicPlayer) });
      log('Вход:', nick);
      return;
    }

    case 'lobby': {
      if (!cl.nick) return fail(cl, 'no_nick', 'Сначала введите ник');
      return send(cl, { t: 'lobby', players: Array.from(online.values()).filter(c => c.nick && c !== cl).map(publicPlayer) });
    }

    case 'leaderboard':
      return send(cl, { t: 'leaderboard', rows: leaderboard(Number(m.limit) || 20) });

    /* --- Поиск игрока по нику и вызов --- */
    case 'invite': {
      if (!cl.nick) return fail(cl, 'no_nick', 'Сначала введите свой ник');
      if (cl.game) return fail(cl, 'busy', 'Вы уже в игре');
      const target = validNick(m.nick);
      if (!target) return fail(cl, 'bad_nick', 'Некорректный ник соперника');
      if (nickKey(target) === nickKey(cl.nick)) return fail(cl, 'self', 'Нельзя играть с самим собой');
      const opp = online.get(nickKey(target));
      if (!opp) {
        const known = DB.players[nickKey(target)];
        return fail(cl, 'not_online', known
          ? 'Игрок «' + known.nick + '» сейчас не в сети'
          : 'Игрок «' + target + '» не найден');
      }
      if (opp.game) return fail(cl, 'opponent_busy', 'Игрок «' + opp.nick + '» уже в бою');

      // Встречный вызов — сразу матч
      if (opp.invited && opp.invited === nickKey(cl.nick)) {
        opp.invited = null; cl.invited = null;
        return createGame(cl, opp);
      }
      cl.invited = nickKey(opp.nick);
      send(opp, { t: 'invite', from: cl.nick, rating: ratingOf(cl.record) });
      return send(cl, { t: 'inviteSent', to: opp.nick });
    }

    case 'inviteResp': {
      if (!cl.nick) return;
      const fromKey = nickKey(m.from);
      const opp = online.get(fromKey);
      if (!opp || opp.invited !== nickKey(cl.nick)) return fail(cl, 'invite_expired', 'Вызов уже недействителен');
      opp.invited = null;
      if (!m.accept) return send(opp, { t: 'inviteDeclined', by: cl.nick });
      if (cl.game || opp.game) return fail(cl, 'busy', 'Один из игроков уже в бою');
      return createGame(opp, cl);
    }

    case 'cancelInvite': {
      if (cl.invited) {
        const opp = online.get(cl.invited);
        if (opp) send(opp, { t: 'inviteCancelled', from: cl.nick });
        cl.invited = null;
      }
      return;
    }

    /* --- Расстановка --- */
    case 'ready': {
      const game = cl.game;
      if (!game) return fail(cl, 'no_game', 'Вы не в игре');
      if (game.phase !== 'placing') return fail(cl, 'bad_phase', 'Флот уже зафиксирован');
      const built = R.buildBoard(m.ships);
      if (!built.ok) return fail(cl, 'bad_fleet', built.error);
      game.boards.set(cl.id, built.board);
      game.ready.add(cl.id);
      send(cl, { t: 'readyOk' });
      const opp = other(game, cl);
      send(opp, { t: 'opponentReady', nick: cl.nick });
      if (game.ready.size === 2) startBattle(game);
      return;
    }

    /* --- Выстрел --- */
    case 'fire': {
      const game = cl.game;
      if (!game) return fail(cl, 'no_game', 'Вы не в игре');
      if (game.phase !== 'battle') return fail(cl, 'bad_phase', 'Бой ещё не начался');
      if (game.turn !== cl) return fail(cl, 'not_your_turn', 'Сейчас ход противника');
      const c = Number(m.c), r = Number(m.r);
      if (!R.inside(c, r)) return fail(cl, 'bad_cell', 'Клетка вне поля');
      const opp = other(game, cl);
      const board = game.boards.get(opp.id);
      const res = R.resolveShot(board, c, r);
      if (res.result === 'repeat') return fail(cl, 'repeat', 'По этой клетке уже стреляли');

      const st = game.stats.get(cl.id);
      st.shots++;
      if (res.result !== 'miss') st.hits++;
      if (res.result === 'sunk') st.sunk++;

      const over = board.alive <= 0;
      const again = res.result !== 'miss' && !over;
      if (!over) game.turn = again ? cl : opp;

      const payload = {
        t: 'shotResult', c, r, result: res.result,
        ship: res.ship || null, halo: res.halo || null,
        yourTurn: again, by: cl.nick,
        oppAlive: board.alive
      };
      send(cl, payload);
      send(opp, Object.assign({}, payload, { t: 'incoming', yourTurn: !again && !over }));

      if (over) finishGame(game, cl, 'fleet');
      return;
    }

    /* --- Выход / реванш --- */
    case 'surrender':
    case 'leave':
      return leaveGame(cl, m.t === 'surrender' ? 'surrender' : 'left');

    case 'rematch': {
      const game = cl.game;
      if (!game || game.phase !== 'over') return fail(cl, 'no_game', 'Нет завершённой игры');
      game.rematch.add(cl.id);
      const opp = other(game, cl);
      send(opp, { t: 'rematchOffer', from: cl.nick });
      if (game.rematch.size === 2) {
        const a = game.players[0], b = game.players[1];
        for (const p of game.players) p.game = null;
        games.delete(game.id);
        createGame(a, b);
      }
      return;
    }

    default:
      return fail(cl, 'unknown', 'Неизвестная команда: ' + m.t);
  }
}

/* ------------------------------ Статика ------------------------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/leaderboard') {
    res.writeHead(200, { 'Content-Type': MIME['.json'] });
    res.end(JSON.stringify({ rows: leaderboard(50) }));
    return;
  }
  if (url.pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': MIME['.json'] });
    res.end(JSON.stringify({ ok: true, online: online.size, games: games.size }));
    return;
  }
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.join(ROOT, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('404'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/ws') { socket.end('HTTP/1.1 404 Not Found\r\n\r\n'); return; }
  handleUpgrade(req, socket, head, (conn) => {
    const cl = conn;
    cl.id = 'c' + (seq++);
    cl.nick = null;
    cl.record = null;
    cl.game = null;
    cl.invited = null;
    cl.lastSeen = Date.now();
    clients.set(cl.id, cl);
    send(cl, { t: 'hello', server: 'Морской бой online v1', online: online.size });

    conn.on('message', (text) => {
      try { onMessage(cl, text); }
      catch (err) { log('Ошибка обработки:', err.message); fail(cl, 'server', 'Внутренняя ошибка сервера'); }
    });

    conn.on('close', () => {
      clients.delete(cl.id);
      if (cl.invited) {
        const opp = online.get(cl.invited);
        if (opp) send(opp, { t: 'inviteCancelled', from: cl.nick });
      }
      leaveGame(cl, 'disconnect');
      if (cl.nick && online.get(nickKey(cl.nick)) === cl) online.delete(nickKey(cl.nick));
      broadcastLobby();
      if (cl.nick) log('Выход:', cl.nick);
    });
  });
});

// keep-alive ping
setInterval(() => {
  for (const cl of clients.values()) {
    if (!cl.isAlive) { cl.close(1001, 'timeout'); continue; }
    cl.ping();
  }
}, 25000).unref();

loadDB();
server.listen(PORT, () => {
  log('Морской бой: http://localhost:' + PORT);
});

module.exports = { server, DB, leaderboard };
