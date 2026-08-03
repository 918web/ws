'use strict';
/* Тест № 1–2: WebSocket-транспорт, регистрация, поиск по нику, полный бой, лидерборд. */
const { connect } = require('../ws');
const R = require('../rules');

const URL = 'http://127.0.0.1:' + (process.env.PORT || 8099) + '/ws';
let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (extra ? ' → ' + JSON.stringify(extra) : '')); }
}

function client() {
  return connect(URL).then(conn => {
    const api = { conn, queue: [], waiters: [] };
    conn.on('message', txt => {
      const m = JSON.parse(txt);
      const w = api.waiters.find(w => w.match(m));
      if (w) { api.waiters.splice(api.waiters.indexOf(w), 1); w.resolve(m); }
      else api.queue.push(m);
    });
    api.send = o => conn.sendJSON(o);
    api.wait = (type, timeout) => new Promise((resolve, reject) => {
      const match = m => (typeof type === 'function' ? type(m) : m.t === type);
      const i = api.queue.findIndex(match);
      if (i >= 0) return resolve(api.queue.splice(i, 1)[0]);
      const w = { match, resolve };
      api.waiters.push(w);
      setTimeout(() => {
        if (api.waiters.includes(w)) {
          api.waiters.splice(api.waiters.indexOf(w), 1);
          reject(new Error('timeout waiting for ' + type + ' | queue=' + JSON.stringify(api.queue)));
        }
      }, timeout || 4000);
    });
    return api;
  });
}

async function main() {
  console.log('\n── Тест транспорта и регистрации ──');
  const A = await client();
  const B = await client();
  ok('hello от сервера A', (await A.wait('hello')).t === 'hello');
  ok('hello от сервера B', (await B.wait('hello')).t === 'hello');

  A.send({ t: 'register', nick: 'Адмирал' });
  const regA = await A.wait('registered');
  ok('регистрация кириллического ника', regA.nick === 'Адмирал' && !!regA.token);
  B.send({ t: 'register', nick: 'Bot_Hunter' });
  const regB = await B.wait('registered');
  ok('регистрация второго игрока', regB.nick === 'Bot_Hunter');

  const C = await client(); await C.wait('hello');
  C.send({ t: 'register', nick: 'АДМИРАЛ' });
  const errC = await C.wait('error');
  ok('ник занят (без учёта регистра)', errC.code === 'nick_taken', errC);
  C.send({ t: 'register', nick: 'x' });
  ok('короткий ник отклонён', (await C.wait('error')).code === 'bad_nick');

  console.log('\n── Тест поиска игрока по нику ──');
  A.send({ t: 'invite', nick: 'НетТакого' });
  ok('несуществующий ник → ошибка', (await A.wait('error')).code === 'not_online');
  A.send({ t: 'invite', nick: 'Адмирал' });
  ok('вызов самого себя запрещён', (await A.wait('error')).code === 'self');

  A.send({ t: 'invite', nick: 'bot_hunter' });
  ok('вызов отправлен', (await A.wait('inviteSent')).to === 'Bot_Hunter');
  const inv = await B.wait('invite');
  ok('вызов получен вторым игроком', inv.from === 'Адмирал');
  B.send({ t: 'inviteResp', from: 'Адмирал', accept: false });
  ok('отказ доходит до инициатора', (await A.wait('inviteDeclined')).by === 'Bot_Hunter');

  A.send({ t: 'invite', nick: 'Bot_Hunter' });
  await A.wait('inviteSent');
  await B.wait('invite');
  B.send({ t: 'inviteResp', from: 'Адмирал', accept: true });
  const msA = await A.wait('matchStart');
  const msB = await B.wait('matchStart');
  ok('матч создан и соперники видят друг друга',
    msA.opponent.nick === 'Bot_Hunter' && msB.opponent.nick === 'Адмирал');

  console.log('\n── Тест валидации расстановки ──');
  A.send({ t: 'fire', c: 0, r: 0 });
  ok('выстрел до расстановки запрещён', (await A.wait('error')).code === 'bad_phase');
  A.send({ t: 'ready', ships: [{ size: 4, c: 0, r: 0, horiz: true }] });
  ok('неполный флот отклонён', (await A.wait('error')).code === 'bad_fleet');
  const touching = R.randomShips().slice();
  touching[0] = { size: 4, c: 0, r: 0, horiz: true };
  touching[1] = { size: 3, c: 0, r: 1, horiz: true };
  A.send({ t: 'ready', ships: touching });
  ok('касающиеся корабли отклонены', (await A.wait('error')).code === 'bad_fleet');

  // Фиксированный флот B — чтобы проверить весь цикл боя детерминированно
  const fleetB = [
    { size: 4, c: 0, r: 0, horiz: true },
    { size: 3, c: 0, r: 2, horiz: true }, { size: 3, c: 0, r: 4, horiz: true },
    { size: 2, c: 0, r: 6, horiz: true }, { size: 2, c: 0, r: 8, horiz: true }, { size: 2, c: 4, r: 6, horiz: true },
    { size: 1, c: 9, r: 0 }, { size: 1, c: 9, r: 2 }, { size: 1, c: 9, r: 4 }, { size: 1, c: 9, r: 6 }
  ];
  const fleetA = R.randomShips();
  A.send({ t: 'ready', ships: fleetA });
  ok('корректный флот принят', (await A.wait('readyOk')).t === 'readyOk');
  ok('соперник уведомлён о готовности', (await B.wait('opponentReady')).nick === 'Адмирал');
  B.send({ t: 'ready', ships: fleetB });
  await B.wait('readyOk');

  const bsA = await A.wait('battleStart');
  const bsB = await B.wait('battleStart');
  ok('жеребьёвка: ходит ровно один', bsA.yourTurn !== bsB.yourTurn);
  ok('имя первого хода совпадает', bsA.first === bsB.first);

  console.log('\n── Тест боя и секретности досок ──');
  const all = JSON.stringify([bsA, bsB, msA, msB]);
  ok('в сообщениях нет чужого флота', !/"cells"/.test(all) && !/"grid"/.test(all));

  // Если первый ход у B — пусть промахнётся в заведомо пустую клетку
  if (!bsA.yourTurn) {
    // ищем пустую клетку на доске A по его флоту
    const occupied = new Set();
    for (const s of fleetA) for (const cell of R.shipCells(s.size, s.c, s.r, s.horiz)) occupied.add(cell.r * 10 + cell.c);
    let target = null;
    for (let i = 0; i < 100 && !target; i++) if (!occupied.has(i)) target = { c: i % 10, r: (i / 10) | 0 };
    B.send({ t: 'fire', c: target.c, r: target.r });
    const rb = await B.wait('shotResult');
    ok('промах передаёт ход', rb.result === 'miss' && rb.yourTurn === false);
    const inc = await A.wait('incoming');
    ok('соперник видит входящий выстрел', inc.c === target.c && inc.r === target.r && inc.yourTurn === true);
  }

  B.send({ t: 'fire', c: 5, r: 5 });
  ok('ход не свой → ошибка', (await B.wait('error')).code === 'not_your_turn');

  // A топит весь флот B
  let sunkCount = 0, gotSunkShip = null, repeatChecked = false;
  outer:
  for (const s of fleetB) {
    for (const cell of R.shipCells(s.size, s.c, s.r, !!s.horiz)) {
      A.send({ t: 'fire', c: cell.c, r: cell.r });
      const res = await A.wait(m => m.t === 'shotResult' || m.t === 'gameOver' || m.t === 'error');
      if (res.t === 'error') { console.log('    ! ' + JSON.stringify(res)); break outer; }
      if (res.t === 'gameOver') break outer;
      if (res.result === 'sunk') { sunkCount++; gotSunkShip = res.ship; }
      if (!repeatChecked) {
        repeatChecked = true;
        A.send({ t: 'fire', c: cell.c, r: cell.r });
        const rep = await A.wait('error');
        ok('повторный выстрел отклонён', rep.code === 'repeat');
      }
      await B.wait('incoming');
    }
  }
  ok('потоплены все 10 кораблей', sunkCount === 10, { sunkCount });
  ok('сервер присылает контур потопленного корабля',
    !!gotSunkShip && Array.isArray(gotSunkShip.cells) && gotSunkShip.cells.length === 1);

  const goA = await A.wait('gameOver');
  const goB = await B.wait('gameOver');
  ok('победа у атакующего', goA.win === true && goB.win === false);
  ok('флот раскрыт только в финале', goA.reveal.length === 10);
  ok('статистика боя посчитана', goA.stats.you.shots === 20 && goA.stats.you.hits === 20);
  ok('рейтинг обновлён', goA.record.wins === 1 && goB.record.losses === 1);

  console.log('\n── Тест лидерборда и реванша ──');
  A.send({ t: 'leaderboard' });
  const lb = await A.wait('leaderboard');
  ok('лидерборд содержит обоих игроков', lb.rows.length >= 2);
  ok('лидер — победитель', lb.rows[0].nick === 'Адмирал', lb.rows[0]);

  A.send({ t: 'rematch' });
  await B.wait('rematchOffer');
  B.send({ t: 'rematch' });
  ok('реванш создаёт новый матч', (await A.wait('matchStart')).opponent.nick === 'Bot_Hunter');
  await B.wait('matchStart');

  console.log('\n── Тест разрыва соединения ──');
  A.send({ t: 'ready', ships: R.randomShips() });
  await A.wait('readyOk');
  B.conn.close(1000, 'bye');
  const left = await A.wait(m => m.t === 'opponentLeft' || m.t === 'gameOver');
  ok('выход соперника обработан', !!left);

  A.conn.close(1000, 'bye');
  C.conn.close(1000, 'bye');

  console.log('\nИтого: ✓ ' + passed + '   ✗ ' + failed);
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error('ФАТАЛЬНАЯ ОШИБКА:', e); process.exit(1); });
