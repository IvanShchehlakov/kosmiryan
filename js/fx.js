// Визуальные и звуковые эффекты: звёздный фон, печать текста, шум, звук.

export const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

// ------------------------------------------------------------ sound
let actx = null;
let soundOn = false;
let unlocked = false;
export function setSound(on) {
  soundOn = on;
  if (on && !actx) {
    try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch { soundOn = false; }
  }
  if (actx && actx.state === "suspended") actx.resume();
  if (on) unlockIOS();
  if (!on) ambience.stop(0.3);
}
/** Звук реально играет (браузер разрешил аудио после жеста пользователя). */
export const audioRunning = () => !!actx && actx.state === "running" && soundOn;

// iPhone: Web Audio по умолчанию молчит при включённом беззвучном режиме.
// Переводим аудиосессию в режим «воспроизведение», как у плеера.
function unlockIOS() {
  if (unlocked) return;
  unlocked = true;
  try { if (navigator.audioSession) navigator.audioSession.type = "playback"; } catch { /* нет API */ }
  try {
    // короткая тишина через <audio> — старый способ для iOS < 17
    const sr = 8000, n = 800, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
    const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    w(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); w(8, "WAVE"); w(12, "fmt ");
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    w(36, "data"); v.setUint32(40, n * 2, true);
    const a = new Audio(URL.createObjectURL(new Blob([buf], { type: "audio/wav" })));
    a.setAttribute("playsinline", ""); a.loop = true; a.volume = 0.01;
    a.play().catch(() => {});
  } catch { /* не критично */ }
}

// ------------------------------------------------------------ звук приёма сигнала
// Непрерывный фон экрана сигнала: эфирный шум с «плавающим» приёмом, несущий
// тон, телеметрические пики в ритме морзянки и иногда свип настройки.
export const ambience = (() => {
  let nodes = null, timer = 0;
  function start() {
    if (nodes || !actx || !soundOn) return;
    const t = actx.currentTime;
    const master = actx.createGain(); master.gain.setValueAtTime(0, t); master.gain.linearRampToValueAtTime(1, t + 1.5);
    master.connect(actx.destination);

    // эфирный шум
    const len = actx.sampleRate * 3, nb = actx.createBuffer(1, len, actx.sampleRate), d = nb.getChannelData(0);
    let b = 0; for (let i = 0; i < len; i++) { b = 0.97 * b + 0.03 * (Math.random() * 2 - 1); d[i] = (Math.random() * 2 - 1) * 0.6 + b * 4; }
    const noise = actx.createBufferSource(); noise.buffer = nb; noise.loop = true;
    const bp = actx.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = 1400; bp.Q.value = 0.6;
    const ng = actx.createGain(); ng.gain.value = 0.018;
    const fadeLfo = actx.createOscillator(); fadeLfo.frequency.value = 0.13;
    const fadeAmt = actx.createGain(); fadeAmt.gain.value = 0.01;
    fadeLfo.connect(fadeAmt).connect(ng.gain);
    const sweepLfo = actx.createOscillator(); sweepLfo.frequency.value = 0.05;
    const sweepAmt = actx.createGain(); sweepAmt.gain.value = 600;
    sweepLfo.connect(sweepAmt).connect(bp.frequency);
    noise.connect(bp).connect(ng).connect(master);

    // несущая с лёгким дрожанием + низкий гул
    const car = actx.createOscillator(); car.type = "sine"; car.frequency.value = 1420.4 / 2;
    const vib = actx.createOscillator(); vib.frequency.value = 0.35;
    const vibAmt = actx.createGain(); vibAmt.gain.value = 5; vib.connect(vibAmt).connect(car.frequency);
    const cg = actx.createGain(); cg.gain.value = 0.006;
    car.connect(cg).connect(master);
    const hum = actx.createOscillator(); hum.type = "triangle"; hum.frequency.value = 55;
    const hg = actx.createGain(); hg.gain.value = 0.012; hum.connect(hg).connect(master);

    for (const o of [noise, fadeLfo, sweepLfo, car, vib, hum]) o.start(t);
    nodes = { master, srcs: [noise, fadeLfo, sweepLfo, car, vib, hum] };

    // телеметрия: пачки точек/тире и редкие свипы
    const beep = (at, dur, f, vol) => {
      const o = actx.createOscillator(), g = actx.createGain();
      o.type = "sine"; o.frequency.setValueAtTime(f, at);
      g.gain.setValueAtTime(0, at); g.gain.linearRampToValueAtTime(vol, at + 0.008);
      g.gain.setValueAtTime(vol, at + dur - 0.01); g.gain.linearRampToValueAtTime(0, at + dur);
      o.connect(g).connect(master); o.start(at); o.stop(at + dur + 0.02);
    };
    let n = 0;
    const schedule = () => {
      if (!nodes) return;
      const at = actx.currentTime + 0.1;
      const f = 1150 + (n % 3) * 40;
      let x = at;
      for (let i = 0, k = 3 + Math.floor(Math.random() * 4); i < k; i++) {
        const dash = Math.random() < 0.35, dur = dash ? 0.18 : 0.06;
        beep(x, dur, f, 0.02); x += dur + 0.07;
      }
      if (n % 4 === 3) { // свип настройки
        const o = actx.createOscillator(), g = actx.createGain();
        o.type = "sine"; o.frequency.setValueAtTime(380, x + 0.4); o.frequency.exponentialRampToValueAtTime(2400, x + 1.6);
        g.gain.setValueAtTime(0, x + 0.4); g.gain.linearRampToValueAtTime(0.008, x + 0.7); g.gain.linearRampToValueAtTime(0, x + 1.6);
        o.connect(g).connect(master); o.start(x + 0.4); o.stop(x + 1.7);
      }
      n++;
      timer = setTimeout(schedule, 1800 + Math.random() * 1600);
    };
    timer = setTimeout(schedule, 700);
  }
  let live = 0; // сколько цепочек ещё подключено к динамикам
  function stop(fade = 0.8) {
    clearTimeout(timer);
    if (!nodes) return;
    const { master, srcs } = nodes; nodes = null;
    try {
      const t = actx.currentTime;
      master.gain.cancelScheduledValues(t);
      master.gain.setValueAtTime(master.gain.value, t);
      master.gain.linearRampToValueAtTime(0, t + fade);
    } catch { /* старый браузер — просто отключим ниже */ }
    // Жёстко глушим все генераторы и отключаем цепочку от динамиков:
    // всё, что было запланировано (писки, свипы), тоже замолкает.
    setTimeout(() => {
      for (const s of srcs) { try { s.stop(); } catch { /* уже остановлен */ } }
      try { master.disconnect(); } catch { /* уже отключён */ }
      live = Math.max(0, live - 1);
    }, fade * 1000 + 60);
  }
  return {
    start() { if (!nodes && actx && soundOn) { start(); live++; } },
    stop,
    get active() { return !!nodes; },
    get live() { return live; },
  };
})();
function tone(freq, dur = 0.06, type = "square", vol = 0.03, when = 0) {
  if (!soundOn || !actx) return;
  const t = actx.currentTime + when;
  const o = actx.createOscillator(); const g = actx.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, t);
  g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(actx.destination); o.start(t); o.stop(t + dur + 0.02);
}
export const sfx = {
  key: () => tone(1800 + Math.random() * 400, 0.015, "square", 0.008),
  beep: () => tone(880, 0.08, "sine", 0.05),
  ok: () => { tone(660, 0.1, "sine", 0.05); tone(990, 0.16, "sine", 0.05, 0.1); },
  err: () => { tone(180, 0.18, "sawtooth", 0.04); tone(140, 0.2, "sawtooth", 0.04, 0.12); },
  unlock: () => { [523, 659, 784, 1046].forEach((f, i) => tone(f, 0.22, "triangle", 0.05, i * 0.09)); },
  alarm: () => { for (let i = 0; i < 6; i++) tone(i % 2 ? 620 : 880, 0.22, "sawtooth", 0.035, i * 0.24); },
  noise: (dur = 0.6) => {
    if (!soundOn || !actx) return;
    const len = actx.sampleRate * dur; const buf = actx.createBuffer(1, len, actx.sampleRate);
    const d = buf.getChannelData(0); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const s = actx.createBufferSource(); const g = actx.createGain(); g.gain.value = 0.05;
    s.buffer = buf; s.connect(g).connect(actx.destination); s.start();
  },
};

// ------------------------------------------------------------ typewriter
/**
 * Печатает строки в <ul class="tx">. Возвращает promise; тап по контейнеру
 * мгновенно допечатывает. instant=true — без анимации.
 */
export function typeLines(ul, lines, { instant = false, speed = 22 } = {}) {
  ul.innerHTML = "";
  if (instant || reducedMotion) {
    for (const l of lines) { const li = document.createElement("li"); li.textContent = l; ul.append(li); }
    return Promise.resolve();
  }
  let skip = false;
  const onTap = () => { skip = true; };
  ul.addEventListener("click", onTap);
  return new Promise(async (resolve) => {
    for (const line of lines) {
      const li = document.createElement("li");
      const span = document.createElement("span");
      const caret = document.createElement("span"); caret.className = "caret";
      li.append(span, caret); ul.append(li);
      for (let i = 0; i < line.length; i++) {
        if (skip) { span.textContent = line; break; }
        span.textContent = line.slice(0, i + 1);
        if (i % 3 === 0) sfx.key();
        await sleep(line[i] === "." || line[i] === "," ? speed * 6 : speed);
      }
      caret.remove();
      if (!skip) await sleep(260);
    }
    ul.removeEventListener("click", onTap);
    resolve();
  });
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------ static noise overlay
export function staticNoise(host, ms = 900) {
  const c = document.createElement("canvas"); c.className = "noise";
  host.append(c);
  const W = (c.width = 160), H = (c.height = 100);
  const ctx = c.getContext("2d"); const img = ctx.createImageData(W, H);
  const t0 = performance.now();
  return new Promise((resolve) => {
    (function f(now) {
      const k = (now - t0) / ms;
      if (k >= 1) { c.remove(); return resolve(); }
      const a = Math.sin(k * Math.PI) * 200;
      for (let i = 0; i < img.data.length; i += 4) {
        const v = Math.random() * 255;
        img.data[i] = v * 0.6; img.data[i + 1] = v; img.data[i + 2] = v * 0.75; img.data[i + 3] = Math.random() < 0.6 ? a : 0;
      }
      ctx.putImageData(img, 0, 0);
      requestAnimationFrame(f);
    })(t0);
  });
}

// ------------------------------------------------------------ signal wave
export function signalWave(canvas) {
  const ctx = canvas.getContext("2d");
  let alive = true;
  function frame(t) {
    if (!alive || !canvas.isConnected) return;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== w * dpr) { canvas.width = w * dpr; canvas.height = h * dpr; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = "rgba(57,255,136,.25)"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();
    ctx.strokeStyle = "#39ff88"; ctx.lineWidth = 1.5; ctx.shadowColor = "#39ff88"; ctx.shadowBlur = 6;
    ctx.beginPath();
    for (let x = 0; x <= w; x += 2) {
      const p = x / w;
      const burst = Math.exp(-Math.pow(((p + t * 0.00012) % 1) - 0.5, 2) * 40);
      const y = h / 2 + Math.sin(x * 0.09 + t * 0.006) * (4 + burst * 16) * Math.sin(x * 0.013 + t * 0.001) + (Math.random() - 0.5) * 2 * burst;
      x ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.stroke(); ctx.shadowBlur = 0;
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  return () => { alive = false; };
}

// ------------------------------------------------------------ spiral (двойная спираль)
export function spiral(canvas) {
  const ctx = canvas.getContext("2d");
  const pal = ["#39ff88", "#ffb020", "#5ab8ff", "#ff5a8a"];
  function frame(t) {
    if (!canvas.isConnected) return;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== w * dpr) { canvas.width = w * dpr; canvas.height = h * dpr; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const n = 18, amp = w * 0.34, ph = reducedMotion ? 0 : t * 0.0022;
    const pts = [];
    for (let i = 0; i < n; i++) {
      const y = 8 + (i / (n - 1)) * (h - 16);
      const a = i * 0.55 + ph;
      pts.push({ y, x1: w / 2 + Math.sin(a) * amp, x2: w / 2 + Math.sin(a + Math.PI) * amp, z: Math.cos(a), i });
    }
    for (const p of pts) {
      ctx.strokeStyle = pal[p.i % 4]; ctx.globalAlpha = 0.35 + 0.3 * Math.abs(p.z); ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(p.x1, p.y); ctx.lineTo(p.x2, p.y); ctx.stroke();
    }
    for (const p of pts) {
      for (const [x, z] of [[p.x1, p.z], [p.x2, -p.z]]) {
        ctx.globalAlpha = 0.5 + 0.5 * (z + 1) / 2;
        ctx.fillStyle = z > 0 ? "#d4efe2" : "#5d7a6d";
        ctx.beginPath(); ctx.arc(x, p.y, 2.2 + z * 1.3, 0, 6.283); ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
