import * as THREE from 'three';
import { roadC, BLOCK, ROAD, CURB, BEACH_X, groundHeight } from './city.js';

/**
 * Small scripted jobs. Each job is a list of steps; a step has an objective line,
 * an optional blip/marker, and an update() that returns true when done.
 */
export class Missions {
  constructor(ctx) {
    Object.assign(this, ctx);
    this.index = Number(localStorage.getItem('pv.job') || 0);
    if (this.index > 3) this.index = 4;
    this.active = null;
    this.markerList = [];
    this.giver = { x: BEACH_X - 6, z: -18 };
    this.giverMarker = null;
    this.cooldown = 0;
    this.placeGiver();
  }

  /* ---------------- markers & blips */
  placeGiver() {
    if (this.giverMarker) { this.scene.remove(this.giverMarker); this.giverMarker = null; }
    if (this.index >= 4) return;
    this.giverMarker = this.makeMarker(this.giver.x, this.giver.z, { color: 0xffd23a });
  }
  markers() { return [this.giverMarker, ...this.markerList].filter(Boolean); }
  blips() {
    const b = [];
    if (!this.active && this.giverMarker) b.push({ x: this.giver.x, z: this.giver.z, c: '#ffd23a', t: 'D', edge: true });
    if (this.active?.step?.blip) { const p = this.active.step.blip(); if (p) b.push({ x: p.x, z: p.z, c: p.color || '#ffd23a', s: 6, edge: true }); }
    return b;
  }
  route() { return this.active?.step?.blip ? this.active.step.blip() : null; }
  addMarker(x, z, opts) { const m = this.makeMarker(x, z, opts); this.markerList.push(m); return m; }
  clearMarkers() { for (const m of this.markerList) this.scene.remove(m); this.markerList = []; }

  /* ---------------- lifecycle */
  update(dt) {
    this.cooldown -= dt;
    const p = this.player;
    if (!this.active) {
      if (this.index < 4 && this.cooldown <= 0 && !p.dead && !this.game.deathKind && !p.inCar && this.wanted.level === 0) {
        if (Math.hypot(p.pos.x - this.giver.x, p.pos.z - this.giver.z) < 1.6) this.start(this.index);
      } else if (this.index < 4 && this.wanted.level > 0 && Math.hypot(p.pos.x - this.giver.x, p.pos.z - this.giver.z) < 1.6 && this.cooldown <= 0) {
        this.ui.help('Lose the cops before taking a job.', 2); this.cooldown = 3;
      }
      return;
    }
    const a = this.active;
    // dialogue queue
    if (a.lines.length) {
      a.lineT -= dt;
      if (a.lineT <= 0) { const [who, text, secs] = a.lines.shift(); this.ui.subtitle(who ? `<b>${who}:</b> ${text}` : text, secs); a.lineT = secs; }
    }
    if (a.timer != null) {
      a.timer -= dt;
      if (a.timer <= 0) { this.fail('Out of time.'); return; }
    }
    this.drawObjective();
    const step = a.step;
    if (!step) return;
    if (step.update(dt)) this.nextStep();
  }

  say(lines) { this.active.lines.push(...lines); if (this.active.lineT > 0.5 && this.active.lines.length === lines.length) this.active.lineT = 0.01; }

  start(i) {
    const job = JOBS[i](this);
    this.active = { job, i, stepIdx: -1, step: null, lines: [], lineT: 0, timer: null };
    if (this.giverMarker) { this.scene.remove(this.giverMarker); this.giverMarker = null; }
    this.ui.big(job.title, '', 'gold', 3); this.ui.letterbox(3.2);
    this.sfx.checkpoint();
    job.start?.();
    this.nextStep();
  }
  nextStep() {
    const a = this.active;
    if (!a) return;
    a.step?.end?.();
    a.stepIdx++;
    const step = a.job.steps[a.stepIdx];
    if (!step) { this.complete(); return; }
    a.step = step;
    step.start?.();
    if (step.text) this.ui.help(step.text, 5);
  }
  drawObjective() {
    const a = this.active;
    const el = document.getElementById('objective');
    if (!a) { el.innerHTML = ''; return; }
    let h = a.step?.objective ? a.step.objective() : (a.step?.text || '');
    if (a.timer != null) { const t = Math.max(0, a.timer); h = `<span class="timer">${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}</span>` + h; }
    el.innerHTML = h;
  }
  complete() {
    const a = this.active;
    a.job.cleanup?.(true);
    this.clearMarkers();
    this.ui.big('JOB DONE', `+$${a.job.reward}`, 'gold', 4); this.ui.letterbox(4);
    this.ui.feed(`Job complete: <b>${a.job.title}</b>`, 'job', 6);
    this.sfx.stingerWin();
    this.addMoney(a.job.reward);
    this.game.stats.jobs++;
    this.index = Math.max(this.index, a.i + 1);
    localStorage.setItem('pv.job', String(this.index));
    this.active = null; this.cooldown = 6;
    document.getElementById('objective').innerHTML = '';
    if (this.index >= 4) setTimeout(() => this.ui.subtitle('<b>Dre:</b> That\'s every job I had. Port Isaac\'s yours now. Go have fun.', 6), 4200);
    else setTimeout(() => this.ui.feed('<b>Dre:</b> got another one for you. come back to the beach', 'job', 7), 4300);
    this.placeGiver();
  }
  fail(reason) {
    if (!this.active) return;
    const a = this.active;
    a.job.cleanup?.(false);
    this.clearMarkers();
    a.step?.end?.();
    this.active = null; this.cooldown = 6;
    document.getElementById('objective').innerHTML = '';
    setTimeout(() => { this.ui.big('JOB FAILED', reason, 'red', 3); }, this.game.deathKind ? 5200 : 0);
    this.placeGiver();
  }

  onPedDown(p) { this.active?.job.onPedDown?.(p); }
  onEnteredCar(c) { this.active?.job.onEnteredCar?.(c); }

  near(x, z, r = 2.2) { const p = this.player.inCar ? this.player.inCar.pos : this.player.pos; return Math.hypot(p.x - x, p.z - z) < r; }
}

/* ================================================================== the jobs */
const gas = { x: roadC(2) + BLOCK / 2, z: roadC(2) + BLOCK / 2 + 18 };

const JOBS = [
  // ---------------------------------------------------------------- 1
  (M) => ({
    title: 'WHEELS', reward: 500,
    start() {
      M.say([
        ['Dre', 'You must be the new guy. Nobody walks in this town, so first things first.', 4],
        ['Dre', 'Grab any car off the street. Owner complains? Not your problem.', 4],
      ]);
    },
    steps: [
      { text: 'Get a car. Walk up to one and press <kbd>F</kbd>.', objective: () => 'Get a <b>car</b>.', update: () => M.player.inCar && M.player.carState === 'driving' },
      {
        text: 'Drive to the <b style="color:#ffd23a">Gas &amp; Go</b>. Follow the yellow route on your map.',
        start() { M.addMarker(gas.x, gas.z, { r: 2.6 }); M.say([['Dre', 'Nice ride. Meet my cousin at the Gas & Go. And try to stay between the lines.', 4]]); },
        blip: () => ({ ...gas }), objective: () => 'Drive to the <b style="color:#ffd23a">Gas &amp; Go</b>.',
        update: () => M.player.inCar && M.near(gas.x, gas.z, 3.6),
      },
      {
        text: 'Stop the car.', objective: () => 'Stop the car.',
        update: () => M.player.inCar && M.player.inCar.speed < 1.5,
        end() { M.say([['Cousin', 'Dre said you\'d be fast. You were... adequate. Here.', 4]]); },
      },
    ],
  }),

  // ---------------------------------------------------------------- 2
  (M) => {
    const pick = { x: roadC(4) - 12, z: roadC(5) + ROAD / 2 + 3 };
    const drop = { x: roadC(0) + ROAD / 2 + 5, z: roadC(3) + BLOCK / 2 };
    let has = false;
    return {
      title: 'SPECIAL DELIVERY', reward: 1500,
      start() { M.say([['Dre', 'Package waiting for me in Midtown. Don\'t open it, don\'t shake it, don\'t ask.', 4]]); },
      steps: [
        {
          text: 'Pick up the <b style="color:#ffd23a">package</b> in Midtown.',
          start() { M.addMarker(pick.x, pick.z); }, blip: () => ({ ...pick }), objective: () => 'Collect the <b style="color:#ffd23a">package</b>.',
          update: () => !M.player.inCar && M.near(pick.x, pick.z, 1.8),
          end() {
            has = true; M.clearMarkers(); M.sfx.pickup();
            M.wanted.set(2);
            M.active.timer = 150;
            M.say([['Dre', 'Somebody tipped off the cops! Get that package to the hotel on the beach. Fast.', 4]]);
          },
        },
        {
          text: 'Deliver the package to the <b style="color:#ffd23a">Coral Inn</b> on the beach.',
          start() { M.addMarker(drop.x, drop.z); }, blip: () => ({ ...drop }),
          objective: () => 'Deliver the package to the <b style="color:#ffd23a">hotel</b>.',
          update: () => M.near(drop.x, drop.z, 3.2) && (!M.player.inCar || M.player.inCar.speed < 3),
          end() { M.active.timer = null; M.say([['Dre', 'Package received. You can keep the change.', 3]]); },
        },
      ],
      cleanup() { has = false; },
    };
  },

  // ---------------------------------------------------------------- 3
  (M) => {
    const lot = M.world.city.blocks.find((b) => b.special === 'parking');
    const carPos = { x: lot.cx, z: lot.z0 + 14 };
    let car = null, cps = [], ci = 0;
    const route = [[3, 3], [3, 5], [5, 5], [5, 7], [7, 7], [7, 4], [6, 1], [3, 1], [1, 1], [0, 4], [2, 4]];
    return {
      title: 'HOT LAP', reward: 2500,
      start() {
        car = new M.Car('sports', M.scene, 0xffc21a);
        car.place(carPos.x, carPos.z, Math.PI / 2); car.mode = 'parked'; car.pos.y = groundHeight(M.world.city, car.pos.x, car.pos.z);
        car.mission = true; M.world.cars.push(car);
        M.say([['Dre', 'A friend wants to know how fast the new Razor GT really is. Borrow it. Lap the city.', 4], ['Dre', 'Hit every checkpoint before the clock runs out. Scratches come out of your pay.', 4]]);
      },
      steps: [
        { text: 'Get in the gold <b style="color:#ffd23a">Razor GT</b> in the parking lot.', blip: () => ({ x: car.pos.x, z: car.pos.z }), objective: () => 'Get in the <b style="color:#ffd23a">Razor GT</b>.',
          update: () => M.player.inCar === car && M.player.carState === 'driving' },
        {
          text: 'Drive through every checkpoint!',
          start() {
            ci = 0; M.active.timer = 150;
            cps = route.map(([i, j]) => ({ x: roadC(i), z: roadC(j) }));
            this.mark();
          },
          mark() { M.clearMarkers(); const c = cps[ci]; M.addMarker(c.x, c.z, { r: 5, h: 6, color: 0x3ad0ff }); },
          blip: () => cps[ci] && { ...cps[ci], color: '#3ad0ff' },
          objective: () => `Checkpoint <b>${ci + 1}/${cps.length}</b>`,
          update() {
            if (car.dead) { M.fail('The Razor GT was destroyed.'); return false; }
            if (M.player.inCar !== car) { M.ui.help('Get back in the <b>Razor GT</b>!', 0.5); return false; }
            const c = cps[ci];
            if (M.near(c.x, c.z, 7)) {
              ci++; M.sfx.checkpoint();
              if (ci >= cps.length) return true;
              M.active.timer += 4; this.mark();
            }
            return false;
          },
          end() { M.active.timer = null; },
        },
      ],
      cleanup(ok) {
        if (car) { car.mission = false; }
        if (ok && car) { const dmg = Math.round((car.t.hp - car.health) * 10); if (dmg > 0) { M.ui.subtitle(`<b>Dre:</b> ${dmg > 400 ? 'You trashed it.' : 'A few dents.'} I\'m taking $${dmg} for repairs.`, 4); M.addMoney(-dmg); } }
      },
    };
  },

  // ---------------------------------------------------------------- 4
  (M) => {
    const spot = { x: roadC(6) + BLOCK / 2, z: roadC(2) + ROAD / 2 + 2 };
    let gang = [];
    return {
      title: 'SHAKEDOWN', reward: 4000,
      start() { M.say([['Dre', 'Some Eastside clowns have been taxing my corner store. Go explain the new rules.', 4]]); },
      steps: [
        { text: 'Go to the corner store in <b>Eastside</b>.', start() { M.addMarker(spot.x, spot.z, { r: 3 }); }, blip: () => ({ ...spot }), objective: () => 'Go to <b>Eastside</b>.',
          update: () => M.near(spot.x, spot.z, 14) },
        {
          text: 'Beat up the <b style="color:#ff4a4a">gang members</b>.',
          start() {
            M.clearMarkers();
            for (let k = 0; k < 3; k++) {
              const g = M.makePed('gang', 'gang');
              g.pos.set(spot.x + (k - 1) * 2.2, CURB, spot.z + 3 + (k % 2)); g.heading = Math.PI;
              g.mission = true; g.hostile = true; g.state = 'fight'; g.health = 60;
              gang.push(g);
            }
            M.say([['Gang', 'This corner\'s ours, tourist.', 3]]);
          },
          objective: () => `Gang members left: <b>${gang.filter((g) => !g.dead && g.state !== 'down').length + gang.filter((g) => g.state === 'down' && !g.dead).length}</b>`,
          update: () => gang.every((g) => g.dead),
          end() { M.wanted.set(2); M.say([['Dre', 'Message delivered. Now the cops are on you. Lose them.', 4]]); },
        },
        { text: 'Lose your <b>wanted level</b>. Stay out of sight of the police.', objective: () => 'Lose the <b>cops</b>.', update: () => M.wanted.level === 0 },
      ],
      cleanup() { for (const g of gang) g.mission = false; gang = []; },
    };
  },
];
