/**
 * Сквозной тест: два браузерных контекста играют онлайн-матч целиком.
 * Запуск: PORT=8099 node test/test-e2e.js  (сервер должен быть уже запущен)
 */
const { chromium } = require('playwright')

const PORT = process.env.PORT || 8099
const BASE = `http://127.0.0.1:${PORT}/`

let passed = 0, failed = 0
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  \u2713 ' + name) }
  else { failed++; console.log('  \u2717 ' + name + (extra ? ' — ' + extra : '')) }
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function waitFor(page, fn, timeout = 15000, label = 'condition') {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    if (await page.evaluate(fn)) return true
    await sleep(100)
  }
  throw new Error('timeout waiting for ' + label)
}

const fsx = require('fs')
const pathx = require('path')
const THREE_STUB = fsx.readFileSync(pathx.join(__dirname, 'three-stub.mjs.txt'), 'utf8')
const ORBIT_STUB = "export class OrbitControls{constructor(c,d){this.object=c;this.domElement=d;this.target={set(){},copy(){},clone(){return this},x:0,y:0,z:0};this.enableDamping=false;this.dampingFactor=0.05;this.enablePan=true;this.enableZoom=true;this.minDistance=0;this.maxDistance=1000;this.minPolarAngle=0;this.maxPolarAngle=Math.PI;this.rotateSpeed=1;this.zoomSpeed=1;this.panSpeed=1;this.mouseButtons={};this.touches={};this.autoRotate=false;this.autoRotateSpeed=1;this.screenSpacePanning=true;this.enabled=true}update(){return true}addEventListener(){}removeEventListener(){}saveState(){}reset(){}dispose(){}getPolarAngle(){return 1}getAzimuthalAngle(){return 0}getDistance(){return 30}listenToKeyEvents(){}}\nexport default OrbitControls\n"

// В песочнице нет интернета и WebGL — подменяем three.js тестовой заглушкой.
async function stubThree(ctx) {
  await ctx.route('**/build/three.module.js', r =>
    r.fulfill({ status: 200, contentType: 'text/javascript', body: THREE_STUB }))
  await ctx.route('**/examples/jsm/**', r =>
    r.fulfill({ status: 200, contentType: 'text/javascript', body: ORBIT_STUB }))
}

async function bootPage(ctx, nick) {
  await stubThree(ctx)
  const page = await ctx.newPage()
  page.on('pageerror', e => console.log('  [pageerror ' + nick + ']', e.message))
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') console.log('  [console ' + nick + ']', m.text().slice(0, 200)) })
  page.on('requestfailed', r => console.log('  [reqfail ' + nick + ']', r.url().slice(0, 120)))
  await page.goto(BASE, { waitUntil: 'load' })
  await waitFor(page, () => !!window.__sb, 30000, 'game boot ' + nick)
  return page
}

async function register(page, nick) {
  await page.click('#modeOnline')
  await waitFor(page, () => document.querySelector('#ovNick').classList.contains('on'), 5000, 'nick dialog')
  await page.fill('#nickInput', nick)
  await page.click('#nickGo')
  await waitFor(page, () => document.querySelector('#ovLobby').classList.contains('on'), 10000, 'lobby ' + nick)
}

async function placeAndStart(page) {
  await waitFor(page, () => window.__sb.state.mode === 'online' && window.__sb.state.phase === 'placing', 10000, 'placing')
  await page.click('#btnRandom')
  await waitFor(page, () => window.__sb.state.queue.length === 0, 5000, 'fleet placed')
  await page.click('#btnStart')
}

async function enemyVisibleCount(page) {
  return page.evaluate(() => window.__sb.enemyMeshVisible())
}

;(async () => {
  console.log('E2E: онлайн-матч в двух браузерах\n')
  const browser = await chromium.launch({ executablePath: process.env.SB_CHROME || '/usr/local/bin/chromium', args: ['--no-sandbox', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-features=CalculateNativeWinOcclusion'] })
  const ctxA = await browser.newContext()
  const ctxB = await browser.newContext()
  const nickA = 'Адмирал_' + Math.floor(Math.random() * 9000 + 1000)
  const nickB = 'Kraken_' + Math.floor(Math.random() * 9000 + 1000)

  try {
    const pA = await bootPage(ctxA, nickA)
    const pB = await bootPage(ctxB, nickB)

    // 1. Стартовый экран с двумя плашками
    check('на старте показан выбор режима',
      await pA.evaluate(() => document.querySelector('#ovMode').classList.contains('on')))
    check('есть плашки «бот» и «онлайн»',
      await pA.evaluate(() => !!document.querySelector('#modeBot') && !!document.querySelector('#modeOnline')))

    // 2. Регистрация ников
    await register(pA, nickA)
    await register(pB, nickB)
    check('ник A зарегистрирован и лобби открыто', true)
    check('ник сохранён в localStorage',
      await pA.evaluate(n => localStorage.getItem('seabattle3d.nick.v1') === n, nickA))

    // 3. Поиск игрока по нику + приглашение
    await sleep(500)
    check('в списке лобби виден соперник',
      await pA.evaluate(n => document.querySelector('#lobbyList').textContent.includes(n), nickB))
    await pA.fill('#oppInput', nickB)
    await pA.click('#btnInvite')
    await waitFor(pB, () => document.querySelector('#ovInvite').classList.contains('on'), 10000, 'invite')
    check('игрок B получил приглашение от A',
      await pB.evaluate(n => document.querySelector('#inviteText').textContent.includes(n), nickA))
    await pB.click('#inviteAccept')

    // 4. Матч начался
    await waitFor(pA, () => !!window.__sb.state.online, 10000, 'matchStart A')
    await waitFor(pB, () => !!window.__sb.state.online, 10000, 'matchStart B')
    check('у A в соперниках — B',
      await pA.evaluate(() => window.__sb.state.online.opponent) === nickB)
    check('у B в соперниках — A',
      await pB.evaluate(() => window.__sb.state.online.opponent) === nickA)
    check('режим онлайн, бот отключён',
      await pA.evaluate(() => window.__sb.state.mode === 'online' && window.__sb.state.ai === null))

    // 5. Расстановка и старт боя
    await placeAndStart(pA)
    await placeAndStart(pB)
    await waitFor(pA, () => window.__sb.state.phase === 'battle', 15000, 'battle A')
    await waitFor(pB, () => window.__sb.state.phase === 'battle', 15000, 'battle B')
    check('бой начался у обоих', true)
    const turnA = await pA.evaluate(() => window.__sb.state.turn)
    const turnB = await pB.evaluate(() => window.__sb.state.turn)
    check('ход ровно у одного игрока', (turnA === 'player') !== (turnB === 'player'), turnA + '/' + turnB)

    // 6. Секретность доски: корабли соперника не видны и не хранятся в клиенте
    check('у A в памяти нет кораблей соперника',
      await pA.evaluate(() => window.__sb.state.boards.enemy.ships.filter(Boolean).length === 0))
    check('у B в памяти нет кораблей соперника',
      await pB.evaluate(() => window.__sb.state.boards.enemy.ships.filter(Boolean).length === 0))
    check('3D-моделей чужого флота на сцене нет', (await enemyVisibleCount(pA)) === 0)
    check('свой флот у A на месте',
      await pA.evaluate(() => window.__sb.state.boards.player.ships.filter(Boolean).length === 10))

    // 7. Полный бой: перебираем клетки, пока кто-то не победит
    const cells = []
    for (let r = 0; r < 10; r++) for (let c = 0; c < 10; c++) cells.push([c, r])
    const cursor = { [nickA]: 0, [nickB]: 0 }
    let leakSeen = false
    let guard = 0
    let stuck = 0

    async function over(p) { return p.evaluate(() => window.__sb.state.phase === 'over') }

    while (guard++ < 400) {
      if (await over(pA) || await over(pB)) break
      for (const [p, nick] of [[pA, nickA], [pB, nickB]]) {
        const st = await p.evaluate(() => ({ turn: window.__sb.state.turn, busy: window.__sb.state.busy, phase: window.__sb.state.phase }))
        if (st.phase !== 'battle' || st.turn !== 'player' || st.busy) continue
        // выбираем первую необстрелянную клетку
        let shot = null
        while (cursor[nick] < cells.length) {
          const [c, r] = cells[cursor[nick]++]
          // S = { NONE:0, MISS:1, HIT:2, SUNK:3, HALO:4 } — стреляем только по чистым клеткам
          const free = await p.evaluate(([c, r]) => {
            const v = window.__sb.state.boards.enemy.shots[r * 10 + c]
            return v === 0 || v === 4
          }, [c, r])
          if (free) { shot = [c, r]; break }
        }
        if (!shot) { stuck++; continue }
        await p.evaluate(([c, r]) => window.__sb.fire(c, r), shot)
        await sleep(150)
        if ((await enemyVisibleCount(p)) > 0 && !(await over(p))) leakSeen = true
      }
      await sleep(60)
      if (process.env.SB_DEBUG && guard % 20 === 0) {
        const dump = async (p, n) => {
          const s = await p.evaluate(() => ({ phase: window.__sb.state.phase, turn: window.__sb.state.turn, busy: window.__sb.state.busy, alive: window.__sb.state.boards.player.alive }))
          return n + ':' + s.phase + '/' + s.turn + '/busy=' + s.busy + '/alive=' + s.alive + '/cursor=' + cursor[n]
        }
        console.log('  [dbg ' + guard + ']', await dump(pA, nickA), '|', await dump(pB, nickB), '| stuck=' + stuck)
      }
    }

    check('бой завершён в пределах ходов', (await over(pA)) && (await over(pB)))
    check('доска соперника не ра��крывалась до конца боя', !leakSeen)

    const resA = await pA.evaluate(() => window.__sb.state.online.result)
    const resB = await pB.evaluate(() => window.__sb.state.online.result)
    check('ровно один победитель', !!resA && !!resB && (resA.win !== resB.win))
    check('сервер раскрыл флот после боя', Array.isArray(resA.reveal) && resA.reveal.length === 10)
    // экран итогов показывается с паузой после финального залпа
    let endSeen = false
    for (let i = 0; i < 20 && !endSeen; i++) {
      endSeen =
        (await pA.evaluate(() => document.querySelector('#ovEnd').classList.contains('on'))) &&
        (await pB.evaluate(() => document.querySelector('#ovEnd').classList.contains('on')))
      if (!endSeen) await sleep(300)
    }
    check('в финале у обоих виден экран итогов', endSeen)

    // 8. Лидерборд
    const lb = await (await fetch(BASE + 'api/leaderboard')).json()
    const nicks = (lb.leaderboard || lb.rows || []).map(x => x.nick)
    check('оба игрока есть в лидерборде', nicks.includes(nickA) && nicks.includes(nickB), nicks.join(','))

    // 9. Режим бота по-прежнему работает
    const ctxC = await browser.newContext()
    const pC = await bootPage(ctxC, 'bot-test')
    await pC.click('#modeBot')
    await waitFor(pC, () => document.querySelector('#ovStart').classList.contains('on'), 5000, 'brief')
    await pC.click('#btnBrief')
    await pC.click('#btnRandom')
    await pC.click('#btnStart')
    await waitFor(pC, () => window.__sb.state.phase === 'battle', 10000, 'bot battle')
    check('игра с ботом запускается как раньше',
      await pC.evaluate(() => window.__sb.state.mode === 'bot' && !!window.__sb.state.ai &&
        window.__sb.state.boards.enemy.ships.filter(Boolean).length === 10))

    await browser.close()
  } catch (e) {
    failed++
    console.log('  \u2717 фатальная ошибка: ' + e.message)
    try { await browser.close() } catch (_) {}
  }

  console.log(`\nИтог: ${passed} пройдено, ${failed} провалено`)
  process.exit(failed ? 1 : 0)
})()
