'use strict';
/* ============================================================================
   Правила морского боя — авторитетная серверная модель.
   Точно повторяет логику клиента (10×10, флот 4/3/3/2/2/2/1×4, без касаний).
   ========================================================================== */
const N = 10;
const LETTERS = ['А', 'Б', 'В', 'Г', 'Д', 'Е', 'Ж', 'З', 'И', 'К'];
const FLEET = [
  { size: 4, count: 1, name: 'Линкор' },
  { size: 3, count: 2, name: 'Крейсер' },
  { size: 2, count: 3, name: 'Эсминец' },
  { size: 1, count: 4, name: 'Катер' }
];
const S = { NONE: 0, MISS: 1, HIT: 2, SUNK: 3, HALO: 4 };

const idx = (c, r) => r * N + c;
const inside = (c, r) => c >= 0 && c < N && r >= 0 && r < N;
const coordName = (c, r) => LETTERS[c] + (r + 1);

function fleetSpec() {
  const list = [];
  let id = 0;
  for (const t of FLEET) for (let i = 0; i < t.count; i++) list.push({ id: id++, size: t.size, name: t.name });
  return list;
}

function shipCells(size, c, r, horiz) {
  const cells = [];
  for (let i = 0; i < size; i++) cells.push(horiz ? { c: c + i, r } : { c, r: r + i });
  return cells;
}

function haloCells(ship) {
  const map = new Map();
  for (const cell of ship.cells) {
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      const nc = cell.c + dc, nr = cell.r + dr;
      if (!inside(nc, nr)) continue;
      if (ship.cells.some(s => s.c === nc && s.r === nr)) continue;
      map.set(idx(nc, nr), { c: nc, r: nr });
    }
  }
  return Array.from(map.values());
}

function makeBoard() {
  return {
    grid: new Int8Array(N * N).fill(-1),
    shots: new Int8Array(N * N),
    ships: [],
    alive: 0
  };
}

/**
 * Валидирует расстановку игрока и строит доску.
 * @returns {{ok:true, board:object}|{ok:false, error:string}}
 */
function buildBoard(rawShips) {
  if (!Array.isArray(rawShips)) return { ok: false, error: 'Флот не передан' };
  const spec = fleetSpec();
  if (rawShips.length !== spec.length) return { ok: false, error: 'Нужно ровно ' + spec.length + ' кораблей' };

  const needed = spec.map(s => s.size).sort((a, b) => b - a).join(',');
  const got = rawShips.map(s => Number(s.size)).sort((a, b) => b - a).join(',');
  if (needed !== got) return { ok: false, error: 'Неверный состав флота' };

  const board = makeBoard();
  const names = {};
  for (const t of FLEET) names[t.size] = t.name;

  for (let i = 0; i < rawShips.length; i++) {
    const raw = rawShips[i];
    const size = Number(raw.size);
    const c = Number(raw.c), r = Number(raw.r);
    const horiz = !!raw.horiz;
    if (!Number.isInteger(c) || !Number.isInteger(r)) return { ok: false, error: 'Некорректные координаты' };
    const cells = shipCells(size, c, r, horiz);
    for (const cell of cells) {
      if (!inside(cell.c, cell.r)) return { ok: false, error: 'Корабль выходит за поле' };
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        const nc = cell.c + dc, nr = cell.r + dr;
        if (!inside(nc, nr)) continue;
        if (board.grid[idx(nc, nr)] !== -1) return { ok: false, error: 'Корабли соприкасаются' };
      }
    }
    const ship = {
      id: i, size, name: raw.name || names[size] || 'Корабль',
      c, r, horiz, cells, hits: 0, sunk: false
    };
    for (const cell of cells) board.grid[idx(cell.c, cell.r)] = i;
    board.ships[i] = ship;
    board.alive++;
  }
  return { ok: true, board };
}

/** Случайная корректная расстановка (для тестов и автозамены). */
function randomShips() {
  for (let attempt = 0; attempt < 400; attempt++) {
    const grid = new Int8Array(N * N).fill(-1);
    const out = [];
    let ok = true;
    for (const spec of fleetSpec()) {
      let placed = false;
      for (let tries = 0; tries < 800 && !placed; tries++) {
        const horiz = Math.random() < 0.5;
        const c = Math.floor(Math.random() * (horiz ? N - spec.size + 1 : N));
        const r = Math.floor(Math.random() * (horiz ? N : N - spec.size + 1));
        const cells = shipCells(spec.size, c, r, horiz);
        let free = true;
        for (const cell of cells) {
          if (!inside(cell.c, cell.r)) { free = false; break; }
          for (let dr = -1; dr <= 1 && free; dr++) for (let dc = -1; dc <= 1 && free; dc++) {
            const nc = cell.c + dc, nr = cell.r + dr;
            if (inside(nc, nr) && grid[idx(nc, nr)] !== -1) free = false;
          }
          if (!free) break;
        }
        if (!free) continue;
        for (const cell of cells) grid[idx(cell.c, cell.r)] = spec.id;
        out.push({ id: spec.id, size: spec.size, name: spec.name, c, r, horiz });
        placed = true;
      }
      if (!placed) { ok = false; break; }
    }
    if (ok) return out;
  }
  throw new Error('cannot place fleet');
}

/** Выстрел по доске. Возвращает miss | hit | sunk | repeat. */
function resolveShot(board, c, r) {
  if (!inside(c, r)) return { result: 'repeat' };
  const i = idx(c, r);
  const st = board.shots[i];
  if (st === S.MISS || st === S.HIT || st === S.SUNK) return { result: 'repeat' };
  const shipId = board.grid[i];
  if (shipId === -1) {
    board.shots[i] = S.MISS;
    return { result: 'miss' };
  }
  const ship = board.ships[shipId];
  board.shots[i] = S.HIT;
  ship.hits++;
  if (ship.hits >= ship.size) {
    ship.sunk = true;
    board.alive--;
    for (const cell of ship.cells) board.shots[idx(cell.c, cell.r)] = S.SUNK;
    const halo = haloCells(ship);
    for (const cell of halo) {
      const j = idx(cell.c, cell.r);
      if (board.shots[j] === S.NONE) board.shots[j] = S.HALO;
    }
    return {
      result: 'sunk',
      halo,
      ship: { id: ship.id, size: ship.size, name: ship.name, c: ship.c, r: ship.r, horiz: ship.horiz, cells: ship.cells }
    };
  }
  return { result: 'hit' };
}

/** Открытый флот для показа после боя. */
function revealShips(board) {
  return board.ships.filter(Boolean).map(s => ({
    id: s.id, size: s.size, name: s.name, c: s.c, r: s.r, horiz: s.horiz, sunk: s.sunk
  }));
}

module.exports = {
  N, LETTERS, FLEET, S, idx, inside, coordName,
  fleetSpec, shipCells, haloCells, makeBoard, buildBoard, randomShips, resolveShot, revealShips
};
