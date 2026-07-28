// Audio engine: synthesis, positioning, rain, and volume control.
window.TownGame.audio = (() => {
'use strict';

const { STORAGE_KEYS, gameStorage, clamp, rnd } = window.TownGame.core;

// ---------- audio: synthesized at runtime, with no audio files ----------
const SND = (() => {
  let ac = null, master = null, buf = null, rainSrc = null, rainGain = null;
  let muted = gameStorage.get(STORAGE_KEYS.mute, '0') === '1';
  const ear = { x: 0, y: 0 };                          // Current listener position.

  function init() {                                    // Must run from a click handler due to browser policy.
    if (ac) { if (ac.state === 'suspended') ac.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try { ac = new AC(); } catch (e) { return; }
    master = ac.createGain();
    master.gain.value = muted ? 0 : .55;
    const comp = ac.createDynamicsCompressor();        // A growling horde must not overload the speaker.
    comp.threshold.value = -16; comp.ratio.value = 8;
    master.connect(comp); comp.connect(ac.destination);
    buf = ac.createBuffer(1, ac.sampleRate * 2, ac.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }

  // Volume follows distance; stereo pan follows screen displacement.
  const at = (x, y) => x === undefined ? { g: 1, pan: 0 } : (() => {
    const dx = x - ear.x, dy = y - ear.y, d = Math.hypot(dx, dy);
    return { g: Math.max(0, 1 - d / 640) ** 1.7, pan: clamp(dx / 400, -1, 1) };
  })();

  function out(pan) {
    const n = ac.createGain();
    if (ac.createStereoPanner) { const p = ac.createStereoPanner(); p.pan.value = pan; n.connect(p); p.connect(master); }
    else n.connect(master);
    return n;
  }
  // Tone with descending pitch.
  function tone(f, f2, dur, type, vol, pan, delay, atk) {
    const t0 = ac.currentTime + (delay || 0), o = ac.createOscillator(), g = out(pan);
    o.type = type;
    o.frequency.setValueAtTime(f, t0);
    if (f2 && f2 !== f) o.frequency.exponentialRampToValueAtTime(Math.max(18, f2), t0 + dur);
    g.gain.setValueAtTime(.0001, t0);
    g.gain.linearRampToValueAtTime(vol, t0 + (atk || .004));
    g.gain.exponentialRampToValueAtTime(.0006, t0 + dur);
    o.connect(g); o.start(t0); o.stop(t0 + dur + .03);
  }
  // Filtered noise for impacts, footsteps, glass, and thunder.
  function hiss(dur, hz, hz2, vol, pan, q, type, delay) {
    const t0 = ac.currentTime + (delay || 0), s = ac.createBufferSource(), g = out(pan);
    s.buffer = buf; s.playbackRate.value = rnd(.85, 1.15);
    const f = ac.createBiquadFilter();
    f.type = type || 'bandpass'; f.Q.value = q || 1;
    f.frequency.setValueAtTime(hz, t0);
    if (hz2 && hz2 !== hz) f.frequency.exponentialRampToValueAtTime(Math.max(30, hz2), t0 + dur);
    g.gain.setValueAtTime(.0001, t0);
    g.gain.linearRampToValueAtTime(vol, t0 + .006);
    g.gain.exponentialRampToValueAtTime(.0006, t0 + dur);
    s.connect(f); f.connect(g); s.start(t0, rnd(0, 1.4)); s.stop(t0 + dur + .03);
  }

  // The same noise with an instant attack, so impacts sound sharp instead of soft.
  function crack(dur, hz, hz2, vol, pan, q, type, delay) {
    const t0 = ac.currentTime + (delay || 0), s = ac.createBufferSource(), g = out(pan);
    s.buffer = buf; s.playbackRate.value = rnd(.9, 1.1);
    const f = ac.createBiquadFilter();
    f.type = type; f.Q.value = q;
    f.frequency.setValueAtTime(hz, t0);
    if (hz2 !== hz) f.frequency.exponentialRampToValueAtTime(Math.max(30, hz2), t0 + dur);
    g.gain.setValueAtTime(.0001, t0);
    g.gain.linearRampToValueAtTime(vol, t0 + .0007);          // The 0.7 ms attack creates the click.
    g.gain.exponentialRampToValueAtTime(.0005, t0 + dur);
    s.connect(f); f.connect(g); s.start(t0, rnd(0, 1.4)); s.stop(t0 + dur + .02);
  }

  // Siren wail: one continuous rise and fall per call, with seamless joins.
  function siren(vol, pan) {
    const t0 = ac.currentTime, T = 1.1, g = out(pan);
    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 2400; lp.Q.value = .7;
    lp.connect(g);
    for (const det of [1, 1.006]) {                           // Two detuned voices add weight.
      const o = ac.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(640 * det, t0);
      o.frequency.linearRampToValueAtTime(1240 * det, t0 + T * .5);
      o.frequency.linearRampToValueAtTime(640 * det, t0 + T);
      o.connect(lp); o.start(t0); o.stop(t0 + T + .02);
    }
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(vol, t0 + .05);
    g.gain.linearRampToValueAtTime(vol, t0 + T - .05);
    g.gain.linearRampToValueAtTime(0, t0 + T);
  }

  // Growl: a voiced source through formants sounds like a throat instead of a saw wave.
  function moan(vol, pan, k) {
    const t0 = ac.currentTime, dur = rnd(.8, 1.15), f0 = 68 + (k || 0) * 44;
    const g = out(pan);
    g.gain.setValueAtTime(.0001, t0);
    g.gain.linearRampToValueAtTime(vol, t0 + .16);            // The growl fades in instead of clicking.
    g.gain.linearRampToValueAtTime(vol, t0 + dur * .5);
    g.gain.exponentialRampToValueAtTime(.0005, t0 + dur);

    const src = ac.createOscillator();
    src.type = 'sawtooth';
    src.frequency.setValueAtTime(f0 * 1.14, t0);
    src.frequency.exponentialRampToValueAtTime(f0 * .8, t0 + dur);   // The voice slides downward.
    const lfo = ac.createOscillator(), lg = ac.createGain();         // Throat tremor.
    lfo.frequency.value = rnd(5, 8.5); lg.gain.value = f0 * .07;
    lfo.connect(lg); lg.connect(src.frequency);
    lfo.start(t0); lfo.stop(t0 + dur + .05);

    // Three formants make the sound read as a throat rather than a synthesizer.
    for (const [hz, q, amp] of [[rnd(370, 520), 6, 1], [rnd(920, 1240), 9, .5], [rnd(2200, 2700), 12, .16]]) {
      const bp = ac.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = hz; bp.Q.value = q;
      const a = ac.createGain(); a.gain.value = amp;
      src.connect(bp); bp.connect(a); a.connect(g);
    }
    const ns = ac.createBufferSource();                             // Breath layer.
    ns.buffer = buf; ns.playbackRate.value = rnd(.7, 1);
    const nf = ac.createBiquadFilter();
    nf.type = 'bandpass'; nf.frequency.value = rnd(650, 1050); nf.Q.value = 1.1;
    const ng = ac.createGain(); ng.gain.value = .3;
    ns.connect(nf); nf.connect(ng); ng.connect(g);
    ns.start(t0, rnd(0, 1.2)); ns.stop(t0 + dur + .02);
    src.start(t0); src.stop(t0 + dur + .05);
  }

  function play(name, x, y, k) {
    if (!ac || muted) return;
    const a = at(x, y);
    if (a.g < .02) return;                             // Do not allocate nodes beyond hearing range.
    const v = a.g, P = a.pan;
    switch (name) {
      // Gunshot: click, body, and a short neighborhood echo.
      case 'shot':  crack(.035, 4200, 1500, .9 * v, P, .4, 'highpass');
                    crack(.11, 380, 80, 1.1 * v, P, .8, 'lowpass');
                    crack(.28, 1200, 420, .13 * v, P, .5, 'bandpass', .015);
                    tone(125, 44, .09, 'triangle', .5 * v, P, 0, .001); break;
      // Fired from inside a cabin: flatter and duller than the courier's pistol.
      case 'copshot': crack(.028, 2500, 1050, .6 * v, P, .55, 'highpass');
                      crack(.075, 300, 95, .52 * v, P, .9, 'lowpass');
                      crack(.2, 880, 360, .1 * v, P, .6, 'bandpass', .012);
                      tone(112, 46, .07, 'triangle', .26 * v, P, 0, .001); break;
      case 'hit':   crack(.09, 800, 190, .5 * v, P, 1.4, 'bandpass'); break;
      case 'wall':  crack(.05, 3800, 1700, .26 * v, P, 2.2, 'bandpass'); break;
      case 'die':   crack(.26, 620, 100, .5 * v, P, .9, 'bandpass');
                    moan(.5 * v, P, (k || .4) * .6); break;
      case 'stepA': hiss(.05, 2400, 950, .15 * v, P, 3); break;                    // Sole on asphalt.
      case 'stepG': hiss(.1, 1200, 430, .12 * v, P, .7); break;                    // Grass rustle.
      case 'moan':  moan(.95 * v, P, k); break;
      case 'spit':  hiss(.12, 760, 170, .32 * v, P, .7, 'bandpass');
                    tone(105, 62, .12, 'triangle', .12 * v, P); break;
      case 'splat': hiss(.17, 620, 95, .42 * v, P, .55, 'lowpass'); break;
      case 'hurt':  tone(155, 48, .3, 'triangle', .5 * v, P); hiss(.26, 520, 110, .4 * v, P, .8); break;
      case 'siren': siren(.21 * v, P); break;
      case 'honk':  tone(372, 366, .19, 'square', .17 * v, P); tone(444, 436, .19, 'square', .13 * v, P); break;
      case 'pick':  tone(660, 660, .09, 'triangle', .26 * v, P);
                    tone(880, 880, .09, 'triangle', .26 * v, P, .07);
                    tone(1320, 1320, .17, 'triangle', .22 * v, P, .14); break;
      // One parcel signed off: a short rising pair, well short of the district fanfare.
      case 'deliver': tone(587, 587, .12, 'triangle', .26 * v, P);
                      tone(880, 880, .2, 'triangle', .22 * v, P, .1); break;
      // Paper and coins: drier and lower than a supply box, so the two never sound alike.
      case 'cash':  hiss(.06, 5200, 2600, .16 * v, P, 2.6, 'highpass');
                    tone(988, 988, .07, 'triangle', .2 * v, P, .03);
                    tone(1319, 1319, .12, 'triangle', .16 * v, P, .09); break;
      case 'click': hiss(.035, 2800, 1700, .3, 0, 4); break;
      case 'empty': tone(120, 86, .13, 'square', .16, 0); break;
      case 'crash': hiss(.42, 1400, 160, .6 * v, P, .6); tone(118, 42, .4, 'square', .3 * v, P);
                    hiss(.55, 5400, 2800, .28 * v, P, 1.4, 'bandpass', .05); break;
      case 'glass': hiss(.28, 7600, 2600, .34 * v, P, 1.9, 'highpass');
                    crack(.16, 6400, 1900, .28 * v, P, 2.5, 'highpass', .035); break;
      case 'carHit': crack(.08, 720, 150, .32 * v, P, 1.1, 'bandpass');
                     tone(92, 54, .11, 'triangle', .14 * v, P); break;
      case 'engineBreak': tone(104, 32, .72, 'sawtooth', .3 * v, P);
                          hiss(.75, 420, 70, .34 * v, P, .65, 'lowpass');
                          crack(.12, 1800, 360, .22 * v, P, 1.2, 'bandpass', .08); break;
      case 'headBlast': crack(.055, 6200, 720, 1.15 * v, P, .45, 'highpass');
                        hiss(.82, 520, 42, 1.05 * v, P, .5, 'lowpass');
                        tone(88, 22, 1.15, 'sine', .92 * v, P, 0, .001);
                        tone(190, 31, .55, 'sawtooth', .46 * v, P, .012, .001);
                        crack(.16, 2600, 260, .38 * v, P, 1.1, 'bandpass', .08);
                        crack(.19, 1900, 170, .3 * v, P, 1.2, 'bandpass', .19);
                        hiss(1.1, 310, 55, .4 * v, P, .7, 'lowpass', .12); break;
      case 'thunder': tone(56, 22, 2.8, 'sine', .5, 0); hiss(2.6, 230, 55, .5, 0, .5, 'lowpass');
                      hiss(.6, 950, 190, .32, 0, .8, 'lowpass', .06); break;
      case 'win':   [523, 659, 784, 1047].forEach((f, i) => tone(f, f, .3, 'triangle', .22, 0, i * .11)); break;
      case 'over':  tone(220, 60, 1.1, 'sawtooth', .3, 0); hiss(1.2, 400, 70, .3, 0, .6, 'lowpass'); break;
    }
  }

  // Steady rain noise: one source for the entire game, with variable volume.
  function rain(level) {
    if (!ac) return;
    if (!rainSrc) {
      rainSrc = ac.createBufferSource(); rainSrc.buffer = buf; rainSrc.loop = true;
      const f = ac.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1500; f.Q.value = .5;
      rainGain = ac.createGain(); rainGain.gain.value = 0;
      rainSrc.connect(f); f.connect(rainGain); rainGain.connect(master);
      rainSrc.start();
    }
    rainGain.gain.setTargetAtTime(muted ? 0 : level * .17, ac.currentTime, .5);
  }

  return {
    init, play, rain,
    listen: (x, y) => { ear.x = x; ear.y = y; },
    get muted() { return muted; },
    toggle() {
      muted = !muted;
      gameStorage.set(STORAGE_KEYS.mute, muted ? '1' : '0');
      if (master) master.gain.setTargetAtTime(muted ? 0 : .55, ac.currentTime, .05);
      if (rainGain) rainGain.gain.setTargetAtTime(0, ac.currentTime, .05);
      return muted;
    }
  };
})();

return Object.freeze(SND);
})();
