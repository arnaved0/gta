/**
 * All audio is synthesised with WebAudio: sound effects, engine, sirens, and three
 * original generative radio stations. No audio files are loaded.
 */
const NOTE = (n) => 440 * 2 ** ((n - 69) / 12);

export class Sfx {
  constructor() {
    this.ctx = null;
    this.muted = localStorage.getItem('pv.muted') === '1';
    this.listener = { x: 0, z: 0 };
  }

  init() {
    if (this.ctx) { this.ctx.resume(); return; }
    const ctx = (this.ctx = new (window.AudioContext || window.webkitAudioContext)());
    this.master = ctx.createGain(); this.master.gain.value = this.muted ? 0 : 0.8;
    const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -14; comp.ratio.value = 4;
    this.master.connect(comp).connect(ctx.destination);
    this.fx = ctx.createGain(); this.fx.connect(this.master);
    this.musicBus = ctx.createGain(); this.musicBus.gain.value = 0.55; this.musicBus.connect(this.master);

    const len = ctx.sampleRate * 2;
    this.whiteBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const w = this.whiteBuf.getChannelData(0);
    for (let i = 0; i < len; i++) w[i] = Math.random() * 2 - 1;
    this.brownBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const b = this.brownBuf.getChannelData(0); let last = 0;
    for (let i = 0; i < len; i++) { last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02; b[i] = last * 3.5; }

    // city ambience
    const amb = ctx.createBufferSource(); amb.buffer = this.brownBuf; amb.loop = true;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 500;
    this.ambGain = ctx.createGain(); this.ambGain.gain.value = 0.05;
    amb.connect(lp).connect(this.ambGain).connect(this.fx); amb.start();
    // waves
    const wv = ctx.createBufferSource(); wv.buffer = this.whiteBuf; wv.loop = true;
    const wlp = ctx.createBiquadFilter(); wlp.type = 'lowpass'; wlp.frequency.value = 700;
    this.waveGain = ctx.createGain(); this.waveGain.gain.value = 0;
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.11; const lg = ctx.createGain(); lg.gain.value = 300;
    lfo.connect(lg).connect(wlp.frequency); lfo.start();
    wv.connect(wlp).connect(this.waveGain).connect(this.fx); wv.start();

    // engine: two detuned saws through a lowpass
    this.engGain = ctx.createGain(); this.engGain.gain.value = 0;
    this.engFilter = ctx.createBiquadFilter(); this.engFilter.type = 'lowpass'; this.engFilter.frequency.value = 400; this.engFilter.Q.value = 3;
    this.eng1 = ctx.createOscillator(); this.eng1.type = 'sawtooth';
    this.eng2 = ctx.createOscillator(); this.eng2.type = 'square';
    const e2g = ctx.createGain(); e2g.gain.value = 0.4;
    this.eng1.connect(this.engFilter); this.eng2.connect(e2g).connect(this.engFilter);
    this.engFilter.connect(this.engGain).connect(this.fx);
    this.eng1.start(); this.eng2.start();
    // tyre squeal
    const sq = ctx.createBufferSource(); sq.buffer = this.whiteBuf; sq.loop = true;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1900; bp.Q.value = 6;
    this.skidGain = ctx.createGain(); this.skidGain.gain.value = 0;
    sq.connect(bp).connect(this.skidGain).connect(this.fx); sq.start();
    // siren (one shared voice, volume by nearest cop car)
    this.sirenOsc = ctx.createOscillator(); this.sirenOsc.type = 'triangle';
    const sl = ctx.createOscillator(); sl.frequency.value = 0.55; const slg = ctx.createGain(); slg.gain.value = 260;
    sl.connect(slg).connect(this.sirenOsc.frequency); this.sirenOsc.frequency.value = 980; sl.start();
    this.sirenGain = ctx.createGain(); this.sirenGain.gain.value = 0;
    this.sirenOsc.connect(this.sirenGain).connect(this.fx); this.sirenOsc.start();

    this.radio = new Radio(ctx, this.musicBus, this);
  }

  setMuted(m) {
    this.muted = m; localStorage.setItem('pv.muted', m ? '1' : '0');
    if (this.master) this.master.gain.setTargetAtTime(m ? 0 : 0.8, this.ctx.currentTime, 0.05);
  }

  vol(pos, base, range = 60) {
    if (!pos) return base;
    const d = Math.hypot(pos.x - this.listener.x, pos.z - this.listener.z);
    return base * Math.max(0, 1 - d / range);
  }

  tone(freq, dur, { type = 'sine', vol = 0.25, to = null, delay = 0, attack = 0.005, dest = null } = {}) {
    if (!this.ctx || vol <= 0.001) return;
    const t = this.ctx.currentTime + delay;
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    if (to) o.frequency.exponentialRampToValueAtTime(to, t + dur);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + attack); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(dest || this.fx); o.start(t); o.stop(t + dur + 0.05);
  }
  noise(dur, freq, { vol = 0.25, type = 'lowpass', delay = 0, brown = false, q = 1, to = null, dest = null } = {}) {
    if (!this.ctx || vol <= 0.001) return;
    const t = this.ctx.currentTime + delay;
    const s = this.ctx.createBufferSource(); s.buffer = brown ? this.brownBuf : this.whiteBuf;
    const f = this.ctx.createBiquadFilter(); f.type = type; f.frequency.setValueAtTime(freq, t); f.Q.value = q;
    if (to) f.frequency.exponentialRampToValueAtTime(to, t + dur);
    const g = this.ctx.createGain(); g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f).connect(g).connect(dest || this.fx); s.start(t, Math.random()); s.stop(t + dur + 0.05);
  }

  // ---- one-shots
  step() { this.noise(0.05, 1600, { vol: 0.05, type: 'bandpass', q: 3 }); }
  jump() { this.noise(0.15, 600, { vol: 0.1, type: 'bandpass', to: 1800, q: 2 }); }
  land(hard) { this.noise(hard ? 0.25 : 0.1, hard ? 260 : 500, { vol: hard ? 0.4 : 0.14 }); }
  whoosh() { this.noise(0.18, 500, { vol: 0.12, type: 'bandpass', to: 1600, q: 1.5 }); }
  punch(pos) { const v = this.vol(pos, 0.5); this.noise(0.12, 300, { vol: v, brown: true }); this.tone(120, 0.1, { vol: v * 0.6, to: 60 }); }
  gun(pos, cop = false) {
    const v = this.vol(pos, cop ? 0.45 : 0.6, 120);
    this.noise(0.22, cop ? 2400 : 3200, { vol: v, type: 'lowpass', to: 300 });
    this.tone(cop ? 150 : 110, 0.15, { type: 'square', vol: v * 0.4, to: 40 });
  }
  ricochet(pos) { this.tone(2200 + Math.random() * 1500, 0.12, { type: 'triangle', vol: this.vol(pos, 0.06, 40), to: 900 }); }
  crash(pos, k) {
    const v = this.vol(pos, Math.min(0.8, 0.15 + k * 0.03), 80);
    this.noise(0.35 + Math.min(0.4, k * 0.02), 900, { vol: v, brown: false, type: 'lowpass', to: 200 });
    this.noise(0.25, 3000, { vol: v * 0.3, type: 'highpass' });
    this.tone(70, 0.3, { vol: v * 0.6, to: 35 });
  }
  thud(pos) { this.noise(0.2, 200, { vol: this.vol(pos, 0.5), brown: true }); }
  explosion(pos) {
    const v = this.vol(pos, 1, 200);
    this.noise(1.8, 1200, { vol: v, brown: true, to: 60 });
    this.noise(0.6, 4000, { vol: v * 0.4, to: 400 });
    this.tone(50, 1.2, { vol: v * 0.8, to: 25 });
  }
  horn(pos) {
    const v = this.vol(pos, 0.18, 70);
    this.tone(415, 0.5, { type: 'square', vol: v, attack: 0.02, dest: this.hornFilter() });
    this.tone(523, 0.5, { type: 'square', vol: v * 0.8, attack: 0.02, dest: this.hornFilter() });
  }
  hornFilter() { const f = this.ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 1400; f.connect(this.fx); return f; }
  door() { this.noise(0.12, 400, { vol: 0.25, brown: true }); this.tone(180, 0.08, { vol: 0.1, to: 120, delay: 0.05 }); }
  cash() { [1319, 1760].forEach((n, i) => this.tone(n, 0.2, { type: 'triangle', vol: 0.15, delay: i * 0.07 })); }
  pickup() { [660, 880, 1320].forEach((n, i) => this.tone(n, 0.18, { type: 'triangle', vol: 0.16, delay: i * 0.06 })); }
  hurt() { this.noise(0.15, 500, { vol: 0.2, brown: true }); }
  click() { this.tone(660, 0.06, { type: 'square', vol: 0.05 }); }
  dryFire() { this.tone(1800, 0.03, { type: 'square', vol: 0.05 }); }
  star() { this.tone(880, 0.12, { type: 'square', vol: 0.06 }); this.tone(660, 0.18, { type: 'square', vol: 0.06, delay: 0.1 }); }
  checkpoint() { this.tone(988, 0.12, { type: 'triangle', vol: 0.18 }); this.tone(1319, 0.2, { type: 'triangle', vol: 0.18, delay: 0.08 }); }
  /** original short stingers */
  stingerWin() {
    const seq = [[62, 0], [66, 0.12], [69, 0.24], [74, 0.36], [78, 0.62]];
    for (const [n, d] of seq) { this.tone(NOTE(n), 0.5, { type: 'sawtooth', vol: 0.07, delay: d }); this.tone(NOTE(n - 12), 0.5, { type: 'triangle', vol: 0.1, delay: d }); }
    this.noise(0.8, 6000, { vol: 0.06, type: 'highpass', delay: 0.62 });
  }
  stingerLose() {
    [[57, 0], [56, 0.35], [55, 0.7], [50, 1.1]].forEach(([n, d], i) => this.tone(NOTE(n), i === 3 ? 1.6 : 0.4, { type: 'sawtooth', vol: 0.08, delay: d }));
    this.tone(NOTE(38), 2.2, { type: 'sine', vol: 0.25, delay: 1.1 });
  }
  heartbeat() { this.tone(60, 0.12, { vol: 0.35, to: 45 }); this.tone(55, 0.12, { vol: 0.25, to: 40, delay: 0.18 }); }

  // ---- continuous
  update(dt, { engine = null, skid = 0, siren = 0, beach = 0, city = 1 }) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    if (engine) {
      const rpm = engine.rpm; // 0..1
      const f = 38 + rpm * 120 + (engine.type === 'sports' ? 20 : 0) - (engine.type === 'van' ? 10 : 0);
      this.eng1.frequency.setTargetAtTime(f, t, 0.05); this.eng2.frequency.setTargetAtTime(f * 0.501, t, 0.05);
      this.engFilter.frequency.setTargetAtTime(250 + rpm * 1400 + engine.throttle * 500, t, 0.05);
      this.engGain.gain.setTargetAtTime(0.06 + engine.throttle * 0.05 + rpm * 0.04, t, 0.08);
    } else this.engGain.gain.setTargetAtTime(0, t, 0.1);
    this.skidGain.gain.setTargetAtTime(skid * 0.12, t, 0.05);
    this.sirenGain.gain.setTargetAtTime(siren * 0.07, t, 0.1);
    this.waveGain.gain.setTargetAtTime(beach * 0.09, t, 0.5);
    this.ambGain.gain.setTargetAtTime(0.03 + city * 0.04, t, 0.5);
  }
}

/* ================================================================== RADIO */
/** Original generative stations. Each has a scheduler that writes notes slightly ahead of time. */
const STATIONS = [
  { id: 'neon', name: 'NEON DRIVE 88.1', tag: 'Retro synth, all night long', bpm: 104 },
  { id: 'block', name: 'BLOCK RADIO 97.3', tag: 'Beats from the east side', bpm: 88 },
  { id: 'lagoon', name: 'LAGOON LO-FI 102.5', tag: 'Chill for the beach traffic', bpm: 74 },
  { id: 'off', name: 'RADIO OFF', tag: '' },
];

export class Radio {
  constructor(ctx, out, sfx) {
    this.ctx = ctx; this.sfx = sfx;
    this.out = ctx.createGain(); this.out.gain.value = 0;
    // a little "car speaker" EQ + reverb-ish delay
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 9000;
    const delay = ctx.createDelay(); delay.delayTime.value = 0.23;
    const fb = ctx.createGain(); fb.gain.value = 0.22;
    const wet = ctx.createGain(); wet.gain.value = 0.18;
    this.out.connect(lp); lp.connect(out); lp.connect(delay); delay.connect(fb).connect(delay); delay.connect(wet).connect(out);
    this.stations = STATIONS;
    this.index = Math.floor(Math.random() * 3);
    this.on = false; this.step = 0; this.next = 0; this.timer = null; this.bar = 0;
    this.seed = Math.random() * 1000;
  }
  get station() { return this.stations[this.index]; }
  start(fadeIn = 1.2) {
    if (this.station.id === 'off') { this.stop(); return; }
    this.on = true;
    this.out.gain.cancelScheduledValues(this.ctx.currentTime);
    this.out.gain.setTargetAtTime(1, this.ctx.currentTime, fadeIn / 3);
    if (!this.timer) {
      this.next = this.ctx.currentTime + 0.05;
      this.step = Math.floor(Math.random() * 16) * 16; // tune in mid-song
      this.timer = setInterval(() => this.schedule(), 25);
    }
  }
  stop() {
    this.on = false;
    this.out.gain.setTargetAtTime(0, this.ctx.currentTime, 0.15);
    setTimeout(() => { if (!this.on && this.timer) { clearInterval(this.timer); this.timer = null; } }, 600);
  }
  cycle(dir = 1) {
    this.index = (this.index + dir + this.stations.length) % this.stations.length;
    this.sfx.noise(0.25, 2500, { vol: 0.08, type: 'bandpass', q: 0.8 }); // tuning static
    if (this.station.id === 'off') this.stop();
    else { this.step = Math.floor(Math.random() * 16) * 16; if (!this.on) this.start(0.4); }
    return this.station;
  }
  schedule() {
    const st = this.station;
    if (!this.on || st.id === 'off') return;
    const spb = 60 / st.bpm / 4; // 16th notes
    while (this.next < this.ctx.currentTime + 0.12) {
      this[st.id](this.step, this.next, spb);
      this.next += spb * (st.id === 'block' ? (this.step % 2 ? 0.86 : 1.14) : 1); // swing for hip-hop
      this.step++;
    }
  }

  // --- instruments
  voice(type, f, t, dur, vol, { attack = 0.005, release = null, detune = 0, filter = null, q = 1, to = null } = {}) {
    const c = this.ctx, o = c.createOscillator(), g = c.createGain();
    o.type = type; o.frequency.setValueAtTime(f, t); o.detune.value = detune;
    if (to) o.frequency.exponentialRampToValueAtTime(to, t + dur);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + (release ?? dur));
    let n = o;
    if (filter) { const f2 = c.createBiquadFilter(); f2.type = 'lowpass'; f2.frequency.setValueAtTime(filter, t); f2.Q.value = q; n.connect(f2); n = f2; }
    n.connect(g).connect(this.out); o.start(t); o.stop(t + (release ?? dur) + 0.05);
  }
  hit(t, freq, dur, vol, type = 'bandpass', q = 1) {
    const c = this.ctx, s = c.createBufferSource(); s.buffer = this.sfx.whiteBuf;
    const f = c.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = c.createGain(); g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f).connect(g).connect(this.out); s.start(t, Math.random()); s.stop(t + dur + 0.02);
  }
  kick(t, v = 0.9) { this.voice('sine', 150, t, 0.35, v, { to: 42 }); }
  snare(t, v = 0.35, long = false) { this.hit(t, 1800, long ? 0.35 : 0.16, v, 'bandpass', 0.7); this.voice('triangle', 190, t, 0.1, v * 0.5, { to: 140 }); }
  hat(t, v = 0.08, open = false) { this.hit(t, 8000, open ? 0.2 : 0.04, v, 'highpass', 1); }

  rand(n) { const x = Math.sin((n + this.seed) * 12.9898) * 43758.5453; return x - Math.floor(x); }

  // NEON DRIVE: driving synthwave. i - VI - III - VII in A minor-ish, octave bass, arpeggio, gated snare.
  neon(step, t, spb) {
    const s = step % 16, bar = Math.floor(step / 16);
    const prog = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]]; // Am F C G (as MIDI triads)
    const ch = prog[bar % 4];
    const root = ch[0] - 24;
    // bass: driving 8ths with octave jumps
    if (s % 2 === 0) this.voice('sawtooth', NOTE(root + (s % 4 === 2 ? 12 : 0)), t, spb * 1.8, 0.13, { filter: 700, q: 4 });
    // arp
    const arp = [0, 1, 2, 1, 0, 2, 1, 2];
    const n = ch[arp[s % 8]] + 12 + (s >= 8 && bar % 2 ? 12 : 0);
    this.voice('square', NOTE(n), t, spb * 0.9, 0.035, { filter: 2600 });
    // pad on bar start
    if (s === 0) for (const nn of ch) { this.voice('sawtooth', NOTE(nn), t, spb * 16, 0.025, { attack: 0.4, detune: -8, filter: 1400 }); this.voice('sawtooth', NOTE(nn), t, spb * 16, 0.025, { attack: 0.4, detune: 8, filter: 1400 }); }
    // lead melody every other 4 bars
    if (Math.floor(bar / 4) % 2 === 1 && s % 4 === 0 && this.rand(step) > 0.35) {
      const scale = [69, 71, 72, 74, 76, 79, 81];
      const m = scale[Math.floor(this.rand(step * 3) * scale.length)];
      this.voice('sawtooth', NOTE(m), t, spb * 3.5, 0.04, { attack: 0.02, filter: 3000, detune: 5 });
    }
    if (s % 4 === 0) this.kick(t, 0.8);
    if (s === 4 || s === 12) this.snare(t, 0.42, true);
    if (s % 2 === 1) this.hat(t, 0.05);
  }

  // BLOCK RADIO: boom-bap. minor 7th chords on a mellow keys patch, sub bass, swung drums, crackle.
  block(step, t, spb) {
    const s = step % 16, bar = Math.floor(step / 16);
    const prog = [[50, 53, 57, 60], [46, 50, 53, 57], [43, 46, 50, 53], [45, 48, 52, 55]]; // Dm7 Bbmaj7 Gm7 Am7
    const ch = prog[Math.floor(bar / 2) % 4];
    if (s === 0 || s === 10) for (const nn of ch) this.voice('triangle', NOTE(nn + 12), t, spb * 6, 0.035, { attack: 0.01, filter: 1800 });
    if (s === 0 || s === 7 || s === 10) this.voice('sine', NOTE(ch[0] - 12), t, spb * 3, 0.32, { attack: 0.01 });
    if (s === 0 || s === 7 || (s === 10 && bar % 2)) this.kick(t, 1);
    if (s === 4 || s === 12) this.snare(t, 0.5);
    if (s % 2 === 0) this.hat(t, s % 4 === 2 ? 0.07 : 0.04);
    if (this.rand(step * 7) > 0.8) this.hit(t, 3000, 0.02, 0.03, 'highpass'); // vinyl crackle
    // little vocal-chop style blip
    if (bar % 4 === 3 && (s === 14 || s === 15)) this.voice('square', NOTE(ch[2] + 24), t, spb, 0.025, { filter: 2000 });
  }

  // LAGOON LO-FI: soft maj7 chords with a wobbly "tape" detune, brushed drums.
  lagoon(step, t, spb) {
    const s = step % 16, bar = Math.floor(step / 16);
    const prog = [[53, 57, 60, 64], [52, 55, 59, 62], [50, 53, 57, 60], [55, 59, 62, 65]]; // Fmaj7 Em7 Dm7 G7
    const ch = prog[bar % 4];
    const wob = Math.sin(bar * 1.3) * 12;
    if (s === 0) ch.forEach((nn, i) => this.voice('sine', NOTE(nn + 12), t + i * 0.02, spb * 14, 0.05, { attack: 0.03, detune: wob }));
    if (s === 8) ch.forEach((nn, i) => this.voice('sine', NOTE(nn + 12), t + i * 0.03, spb * 6, 0.03, { attack: 0.03, detune: wob }));
    if (s === 0 || s === 6) this.voice('sine', NOTE(ch[0] - 12), t, spb * 5, 0.25);
    if (s % 8 === 0 || s === 11) this.kick(t, 0.55);
    if (s === 4 || s === 12) this.hit(t, 2500, 0.2, 0.12, 'bandpass', 0.5);
    if (s % 2 === 0) this.hat(t, 0.025);
    if (s % 4 === 2 && this.rand(step) > 0.4) {
      const pent = [72, 74, 76, 79, 81];
      this.voice('triangle', NOTE(pent[Math.floor(this.rand(step * 5) * 5)]), t, spb * 3, 0.04, { attack: 0.01 });
    }
  }
}
