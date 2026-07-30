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
    buildStreetTail();
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

  // ---------- the street the shot happens in ----------
  //
  // A pistol fired outdoors is mostly not the pistol. The muzzle blast is over in a couple of
  // milliseconds; what makes it read as a gunshot rather than a click is everything that comes
  // back off the buildings — a handful of distinct slaps off the nearest walls, then a rough
  // decaying wash. Without that the sharpest transient in the world still sounds like a toy,
  // which is why this exists rather than another layer of filtered noise.
  //
  // The response is generated once, from its own small generator rather than Math.random, so
  // that building it cannot shift the stream the town is grown from.
  let street = null;
  function buildStreetTail() {
    const sr = ac.sampleRate, seconds = .42, len = Math.floor(sr * seconds);
    const ir = ac.createBuffer(2, len, sr);
    let seed = 0x9e3779b9;
    const noise = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2147483648 - 1;
    };
    // Early reflections: the far kerb, the facade behind, the one across the road, and so on.
    const taps = [[.0075, .78], [.0163, .6], [.0291, .47], [.0447, .35], [.0628, .26], [.0912, .18]];
    // The diffuse wash has to arrive after the first slaps rather than with them. Starting it at
    // full level buried the reflections in it, which cost exactly the thing this is here for —
    // the first slap now stands seventeen times above the wash in front of it instead of one and
    // a quarter, and that difference is what a street sounds like.
    const swellFor = sr * .045;
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const decay = Math.pow(1 - i / len, 3.4);
        d[i] = noise() * decay * .2 * Math.min(1, i / swellFor);
      }
      for (const [when, gain] of taps) {
        const at = Math.floor((when + (ch ? .0011 : 0)) * sr);   // A hair of stereo offset per ear.
        for (let j = 0; j < 80 && at + j < len; j++)
          d[at + j] += noise() * gain * Math.pow(1 - j / 80, 2.2);
      }
    }
    const convolver = ac.createConvolver();
    convolver.buffer = ir;
    convolver.normalize = false;
    const damp = ac.createBiquadFilter();                        // Distance eats the top end.
    damp.type = 'lowpass'; damp.frequency.value = 4200; damp.Q.value = .6;
    const level = ac.createGain();
    level.gain.value = .9;
    level.connect(convolver); convolver.connect(damp); damp.connect(master);
    street = level;
  }

  // A voice that goes both straight to the ear and out into the street. The dry path keeps the
  // transient sharp; only a fraction is sent away to come back as reflections.
  function outdoors(pan, send) {
    const n = out(pan);
    if (street && send > 0) {
      const tap = ac.createGain();
      tap.gain.value = send;
      n.connect(tap); tap.connect(street);
    }
    return n;
  }

  // A single-sample spike: the one thing filtered noise cannot imitate, because the click of a
  // gunshot is a step in air pressure rather than a short sound.
  function impulse(vol, pan, send, delay) {
    const t0 = ac.currentTime + (delay || 0);
    const b = ac.createBuffer(1, 24, ac.sampleRate);
    const d = b.getChannelData(0);
    d[0] = 1; d[1] = -.82; d[2] = .55; d[3] = -.3; d[4] = .14;
    const s = ac.createBufferSource(), g = outdoors(pan, send);
    s.buffer = b; g.gain.value = vol;
    s.connect(g); s.start(t0);
  }
  // Tone with descending pitch.
  function tone(f, f2, dur, type, vol, pan, delay, atk, send) {
    const t0 = ac.currentTime + (delay || 0), o = ac.createOscillator(), g = outdoors(pan, send || 0);
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
  function crack(dur, hz, hz2, vol, pan, q, type, delay, send) {
    const t0 = ac.currentTime + (delay || 0), s = ac.createBufferSource(), g = outdoors(pan, send || 0);
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
      // A shot in the order the parts of one actually happen: the pressure step, the blast that
      // follows it out of the muzzle, the gas thumping after that, and the slide closing a
      // fraction of a second later. Each layer sends some of itself into the street, which is
      // what comes back off the buildings and makes it a gunshot rather than a click. The whole
      // thing is nudged a few per cent per shot, because two identical shots in a row is the
      // giveaway that nothing was really fired.
      case 'shot': {
        const j = rnd(.94, 1.07);
        impulse(.8 * v, P, .5);
        crack(.026, 5400 * j, 1800, .72 * v, P, .5, 'highpass', 0, .45);
        crack(.08, 950 * j, 250, .46 * v, P, .7, 'bandpass', .0012, .5);
        crack(.125, 330, 70, .95 * v, P, .9, 'lowpass', 0, .4);
        tone(116 * j, 40, .07, 'triangle', .4 * v, P, 0, .001, .3);
        crack(.018, 7400, 4300, .17 * v, P, 1.7, 'highpass', .015, .2);
        break;
      }
      // Fired from inside a cabin: flatter and duller than the courier's pistol.
      case 'copshot': crack(.028, 2500, 1050, .6 * v, P, .55, 'highpass');
                      crack(.075, 300, 95, .52 * v, P, .9, 'lowpass');
                      crack(.2, 880, 360, .1 * v, P, .6, 'bandpass', .012);
                      tone(112, 46, .07, 'triangle', .26 * v, P, 0, .001); break;
      // The heavy gun on the madness patrol. Everything the service weapon has, an octave down and
      // with the low end doing the work: the click is duller because a big round leaves slower,
      // the body is longer, and there is a thump underneath that the pistol does not have. The
      // street tail gets a bigger send than anything else in the game, because the one thing a
      // heavy calibre does that nothing else does is come back off the buildings a moment later.
      case 'mgshot': {
        const j = rnd(.9, 1.12);
        impulse(.55 * v, P, .55);
        crack(.02, 3100 * j, 1400, .42 * v, P, .6, 'highpass', 0, .4);
        crack(.11, 520 * j, 130, .78 * v, P, .8, 'lowpass', 0, .6);
        crack(.055, 1500 * j, 480, .3 * v, P, .8, 'bandpass', .002, .45);
        tone(74 * j, 32, .13, 'triangle', .52 * v, P, 0, .001, .35);   // The thump under it.
        crack(.026, 240, 90, .34 * v, P, .7, 'lowpass', .05, .3);      // Bolt slamming home.
        break;
      }
      // A tank of fuel going up, which is a slower event than anything else in the game: the
      // crack of it arrives first and is almost incidental, then the low end takes a moment to
      // build and a long time to leave. Most of it goes into the street, because the one thing
      // that says "that was big" is how long the buildings keep handing it back.
      case 'wreckBlast': {
        const j = rnd(.92, 1.1);
        impulse(.7 * v, P, .7);
        crack(.04, 2600 * j, 700, .5 * v, P, .5, 'highpass', 0, .5);
        crack(.85, 300 * j, 45, 1.05 * v, P, .7, 'lowpass', .004, .85);
        crack(.42, 900 * j, 160, .5 * v, P, .55, 'bandpass', .02, .7);
        tone(58 * j, 21, .62, 'triangle', .68 * v, P, 0, .012, .5);   // The thump you feel.
        tone(112 * j, 38, .3, 'sawtooth', .22 * v, P, .01, .02, .4);
        crack(.55, 180, 60, .38 * v, P, .8, 'lowpass', .22, .55);     // Debris coming back down.
        break;
      }
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
