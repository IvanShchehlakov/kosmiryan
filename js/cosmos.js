// Живой космический фон.
// Планеты рендерятся попиксельно как настоящие сферы: процедурная поверхность
// (3D-шум без швов), освещение от далёкой звезды, мягкий терминатор,
// потемнение к краю, атмосферное рассеяние, облака и блик океана.
// Они маленькие и далеко — за туманностями. Тяжёлые вещи считаются один раз,
// в кадре только перемещаются, поэтому фон лёгкий и для телефона.

const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const TAU = Math.PI * 2;
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const mix = (a, b, t) => a + (b - a) * t;

function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gauss = (r) => (r() + r() + r() - 1.5) / 1.5;

// 3D value noise + fBm
function makeNoise(seed) {
  const r = rng(seed);
  const perm = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [perm[i], perm[j]] = [perm[j], perm[i]]; }
  const P = new Uint8Array(512); for (let i = 0; i < 512; i++) P[i] = perm[i & 255];
  const V = new Float32Array(256); for (let i = 0; i < 256; i++) V[i] = r();
  const f = (t) => t * t * (3 - 2 * t);
  const n = (x, y, z) => {
    const X = Math.floor(x), Y = Math.floor(y), Z = Math.floor(z);
    const u = f(x - X), v = f(y - Y), w = f(z - Z);
    const h = (i, j, k) => V[P[P[P[(X + i) & 255] + ((Y + j) & 255)] + ((Z + k) & 255)]];
    return mix(
      mix(mix(h(0, 0, 0), h(1, 0, 0), u), mix(h(0, 1, 0), h(1, 1, 0), u), v),
      mix(mix(h(0, 0, 1), h(1, 0, 1), u), mix(h(0, 1, 1), h(1, 1, 1), u), v), w);
  };
  return (x, y, z, oct = 5) => {
    let s = 0, a = 0.5, fr = 1, norm = 0;
    for (let o = 0; o < oct; o++) { s += a * n(x * fr, y * fr, z * fr); norm += a; a *= 0.5; fr *= 2.03; }
    return s / norm;
  };
}

function ramp(stops, t) {
  t = clamp(t);
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [t0, c0] = stops[i - 1], [t1, c1] = stops[i];
      const k = (t - t0) / (t1 - t0 || 1);
      return [mix(c0[0], c1[0], k), mix(c0[1], c1[1], k), mix(c0[2], c1[2], k)];
    }
  }
  return stops[stops.length - 1][1];
}

// Текстура поверхности (равнопромежуточная проекция), считается из точки на сфере — без шва.
function makeTexture(W, H, fn) {
  const data = new Float32Array(W * H * 4);
  for (let j = 0; j < H; j++) {
    const lat = (0.5 - (j + 0.5) / H) * Math.PI;
    const cl = Math.cos(lat), sl = Math.sin(lat);
    for (let i = 0; i < W; i++) {
      const lon = ((i + 0.5) / W) * TAU;
      const c = fn(cl * Math.cos(lon), sl, cl * Math.sin(lon), lat);
      const k = (j * W + i) * 4;
      data[k] = c[0]; data[k + 1] = c[1]; data[k + 2] = c[2]; data[k + 3] = c[3] || 0;
    }
  }
  return { W, H, data };
}
function sample(tex, lon, lat, out) {
  let u = (lon / TAU) % 1; if (u < 0) u += 1;
  const x = u * tex.W - 0.5, y = clamp((0.5 - lat / Math.PI) * tex.H - 0.5, 0, tex.H - 1);
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const xa = (x0 + tex.W) % tex.W, xb = (x0 + 1) % tex.W, y1 = Math.min(tex.H - 1, y0 + 1);
  const i00 = (y0 * tex.W + xa) * 4, i10 = (y0 * tex.W + xb) * 4, i01 = (y1 * tex.W + xa) * 4, i11 = (y1 * tex.W + xb) * 4;
  const d = tex.data;
  for (let c = 0; c < 4; c++) out[c] = mix(mix(d[i00 + c], d[i10 + c], fx), mix(d[i01 + c], d[i11 + c], fx), fy);
  return out;
}

// Свет далёкой звезды — слева сверху и немного спереди.
const norm3 = (v) => { const m = Math.hypot(...v); return v.map((x) => x / m); };
const L = norm3([-0.62, 0.5, 0.6]);
const HV = norm3([L[0], L[1], L[2] + 1]);

/** Рендер сферы в канвас (попиксельно). */
function renderSphere(cv, R, P, rot) {
  const S = Math.ceil(R * 2 + 4);
  if (cv.width !== S) { cv.width = cv.height = S; }
  const g = cv.getContext("2d");
  const img = g.createImageData(S, S);
  const d = img.data, c = S / 2, ct = Math.cos(P.tilt), st = Math.sin(P.tilt);
  const px = [0, 0, 0, 0], pc = [0, 0, 0, 0];
  for (let j = 0; j < S; j++) {
    for (let i = 0; i < S; i++) {
      const x = (i + 0.5 - c) / R, y = -(j + 0.5 - c) / R;
      const r2 = x * x + y * y;
      const edge = clamp((1 - Math.sqrt(r2)) * R + 0.5);
      if (edge <= 0) continue;
      const nz = Math.sqrt(Math.max(0, 1 - r2));
      const bx = x * ct - y * st, by = x * st + y * ct; // наклон оси
      const lat = Math.asin(clamp(by, -1, 1));
      const lon = Math.atan2(bx, nz) + rot;
      sample(P.tex, lon, lat, px);
      let cr = px[0], cg = px[1], cb = px[2], spec = px[3];
      if (P.clouds) {
        const cl = sample(P.clouds, lon + rot * 0.25, lat, pc)[0];
        cr = mix(cr, 245, cl); cg = mix(cg, 248, cl); cb = mix(cb, 255, cl); spec *= 1 - cl;
      }
      const dl = x * L[0] + y * L[1] + nz * L[2];
      const light = 0.02 + 0.98 * Math.pow(smooth(-0.12, 0.8, dl), 1.15);
      const limb = mix(1, 0.5 + 0.5 * Math.sqrt(nz), P.limb);
      let R_ = cr * light * limb, G_ = cg * light * limb, B_ = cb * light * limb;
      if (spec > 0) {
        const s = Math.pow(Math.max(0, x * HV[0] + y * HV[1] + nz * HV[2]), 60) * spec;
        R_ += 255 * s; G_ += 240 * s; B_ += 220 * s;
      }
      if (P.atmo) { // рассеяние у края на дневной стороне
        const rim = Math.pow(1 - nz, 2.6) * smooth(-0.25, 0.6, dl) * P.atmo[3];
        R_ = mix(R_, P.atmo[0], rim); G_ = mix(G_, P.atmo[1], rim); B_ = mix(B_, P.atmo[2], rim);
      }
      const k = (j * S + i) * 4;
      d[k] = R_; d[k + 1] = G_; d[k + 2] = B_; d[k + 3] = 255 * edge;
    }
  }
  g.putImageData(img, 0, 0);
}

// ---------------------------------------------------------------- планеты
function giantDef() {
  const n = makeNoise(7);
  const stops = [[0, [212, 188, 150]], [0.25, [236, 222, 196]], [0.45, [196, 160, 112]], [0.6, [228, 210, 176]], [0.8, [170, 128, 86]], [1, [240, 230, 208]]];
  return {
    tex: makeTexture(160, 80, (x, y, z, lat) => {
      const turb = n(x * 3, y * 3, z * 3, 4) - 0.5;
      const t = 0.5 + 0.5 * Math.sin((lat + turb * 0.16) * 15 + n(x, y * 6, z, 3) * 2.5);
      const c = ramp(stops, t);
      const shade = 0.9 + 0.2 * n(x * 9, y * 18, z * 9, 3);
      return [c[0] * shade, c[1] * shade, c[2] * shade, 0];
    }),
    tilt: 0.42, limb: 0.9, atmo: [255, 232, 190, 0.35], ring: true, spin: 0.00009,
  };
}
function earthDef() {
  const n = makeNoise(21), nc = makeNoise(33);
  return {
    tex: makeTexture(256, 128, (x, y, z, lat) => {
      const h = n(x * 1.8 + 3, y * 1.8, z * 1.8, 6);
      const ice = smooth(1.15, 1.3, Math.abs(lat) + (h - 0.5) * 0.4);
      let c, spec = 0;
      if (h < 0.53) { const dd = smooth(0.3, 0.53, h); c = [mix(6, 22, dd), mix(28, 78, dd), mix(70, 130, dd)]; spec = 0.55; }
      else { const m = smooth(0.53, 0.72, h); c = ramp([[0, [70, 104, 52]], [0.45, [118, 122, 70]], [0.75, [150, 126, 92]], [1, [110, 96, 80]]], m); }
      return [mix(c[0], 240, ice), mix(c[1], 244, ice), mix(c[2], 250, ice), spec * (1 - ice)];
    }),
    clouds: makeTexture(192, 96, (x, y, z) => [smooth(0.5, 0.72, nc(x * 2.6, y * 3.2, z * 2.6, 5)) * 0.92, 0, 0, 0]),
    tilt: 0.38, limb: 0.25, atmo: [120, 175, 255, 0.85], spin: 0.00016,
  };
}
function marsDef() {
  const n = makeNoise(55);
  return {
    tex: makeTexture(128, 64, (x, y, z, lat) => {
      const h = n(x * 2.5, y * 2.5, z * 2.5, 6);
      const crater = smooth(0.62, 0.7, n(x * 7, y * 7, z * 7, 2)) * 0.25;
      const c = ramp([[0, [96, 44, 28]], [0.45, [168, 82, 48]], [0.7, [204, 128, 82]], [1, [226, 170, 120]]], h - crater);
      const cap = smooth(1.3, 1.42, Math.abs(lat));
      return [mix(c[0], 235, cap), mix(c[1], 230, cap), mix(c[2], 225, cap), 0];
    }),
    tilt: 0.2, limb: 0.3, atmo: [255, 170, 130, 0.25], spin: 0.00012,
  };
}

// Кольца: много тонких колечек с делением Кассини, две половины (за и перед планетой).
function makeRings(R, tilt) {
  const out = {};
  for (const front of [false, true]) {
    const S = Math.ceil(R * 5);
    const c = document.createElement("canvas"); c.width = c.height = S;
    const g = c.getContext("2d");
    g.translate(S / 2, S / 2); g.rotate(tilt); // параллельно экватору планеты
    for (let k = 1.28; k < 2.3; k += 0.012) {
      let a = 0.35 + 0.25 * Math.sin(k * 41) * Math.sin(k * 13);
      if (k > 1.92 && k < 1.99) a *= 0.08;
      if (k < 1.45) a *= ((k - 1.28) / 0.17) * 0.6;
      if (k > 2.18) a *= (2.3 - k) / 0.12;
      const lit = front ? 1 : 0.8;
      g.strokeStyle = `rgba(${Math.round(220 * lit)},${Math.round(200 * lit)},${Math.round(165 * lit)},${clamp(a)})`;
      g.lineWidth = Math.max(0.6, R * 0.014);
      g.beginPath(); g.ellipse(0, 0, R * k, R * k * 0.22, 0, front ? 0 : Math.PI, front ? Math.PI : TAU); g.stroke();
    }
    out[front ? "front" : "back"] = c;
  }
  return out;
}

// ---------------------------------------------------------------- туманности, галактика, звёзды
function sprite(size, draw) { const c = document.createElement("canvas"); c.width = c.height = size; draw(c.getContext("2d"), size); return c; }

function makeNebula(seed, palette) {
  const r = rng(seed);
  return sprite(512, (g, S) => {
    g.globalCompositeOperation = "lighter";
    for (let i = 0; i < 80; i++) {
      const [h, s, l] = palette[Math.floor(r() * palette.length)];
      const x = S / 2 + gauss(r) * S * 0.28, y = S / 2 + gauss(r) * S * 0.22, rad = S * (0.05 + r() * 0.2);
      const gr = g.createRadialGradient(x, y, 0, x, y, rad);
      gr.addColorStop(0, `hsla(${h},${s}%,${l}%,${0.04 + r() * 0.08})`); gr.addColorStop(1, `hsla(${h},${s}%,${l}%,0)`);
      g.fillStyle = gr; g.beginPath(); g.arc(x, y, rad, 0, TAU); g.fill();
    }
    g.globalCompositeOperation = "destination-out";
    for (let i = 0; i < 30; i++) {
      const x = S / 2 + gauss(r) * S * 0.3, y = S / 2 + gauss(r) * S * 0.25, rad = S * (0.03 + r() * 0.08);
      const gr = g.createRadialGradient(x, y, 0, x, y, rad);
      gr.addColorStop(0, "rgba(0,0,0,.35)"); gr.addColorStop(1, "rgba(0,0,0,0)");
      g.fillStyle = gr; g.beginPath(); g.arc(x, y, rad, 0, TAU); g.fill();
    }
  });
}

function makeGalaxy(seed) {
  const r = rng(seed);
  return sprite(320, (g, S) => {
    const c = S / 2;
    g.globalCompositeOperation = "lighter";
    const core = g.createRadialGradient(c, c, 0, c, c, S * 0.22);
    core.addColorStop(0, "rgba(255,240,215,.9)"); core.addColorStop(0.2, "rgba(255,205,160,.3)"); core.addColorStop(1, "rgba(120,90,200,0)");
    g.fillStyle = core; g.fillRect(0, 0, S, S);
    for (let i = 0; i < 3200; i++) {
      const arm = i % 2;
      const t = Math.pow(r(), 0.7) * 3.4 * Math.PI;
      const ang = t + arm * Math.PI + gauss(r) * 0.38;
      const rad = (t / (3.4 * Math.PI)) * S * 0.46 + gauss(r) * 5;
      const x = c + Math.cos(ang) * rad, y = c + Math.sin(ang) * rad;
      const far = rad / (S * 0.46);
      g.fillStyle = far > 0.5 ? `rgba(170,200,255,${0.12 + r() * 0.3})` : `rgba(255,225,190,${0.12 + r() * 0.3})`;
      g.beginPath(); g.arc(x, y, 0.5 + r() * 0.7, 0, TAU); g.fill();
    }
  });
}

function starSprite(rgb) {
  return sprite(32, (g, S) => {
    const gr = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    gr.addColorStop(0, "rgba(255,255,255,1)"); gr.addColorStop(0.12, `rgba(${rgb},.9)`); gr.addColorStop(0.35, `rgba(${rgb},.18)`); gr.addColorStop(1, `rgba(${rgb},0)`);
    g.fillStyle = gr; g.fillRect(0, 0, S, S);
  });
}

// ---------------------------------------------------------------- сцена
export function cosmos(canvas) {
  const ctx = canvas.getContext("2d");
  let w = 0, h = 0, dpr = 1, M = 1, stars = [], bright = [];
  let px = 0, py = 0, tx = 0, ty = 0, scroll = 0;
  const meteors = []; let nextMeteor = 3000;
  const SPR = { w: starSprite("255,255,255"), b: starSprite("170,200,255"), y: starSprite("255,215,170"), r: starSprite("255,170,150") };

  const NEB = [
    { img: makeNebula(11, [[285, 75, 52], [320, 80, 55], [255, 75, 52], [200, 85, 50]]), x: 0.12, y: 0.16, s: 1.25, a: 0.55, depth: 0.06, rot: 0.00001, vx: 0.0016 },
    { img: makeNebula(23, [[185, 85, 45], [160, 75, 42], [215, 80, 55]]), x: 0.92, y: 0.6, s: 1.3, a: 0.5, depth: 0.05, rot: -0.000008, vx: -0.0012 },
    { img: makeNebula(37, [[18, 90, 52], [340, 80, 52], [40, 90, 55], [300, 65, 48]]), x: 0.3, y: 0.96, s: 1.1, a: 0.42, depth: 0.08, rot: 0.000012, vx: 0.001 },
  ];
  const galaxy = { img: makeGalaxy(5), x: 0.6, y: 0.09, s: 0.34, depth: 0.04, vx: -0.0012 };

  // Планеты: маленькие и дальние. k — доля от меньшей стороны экрана.
  const planets = [
    { make: giantDef, x: 0.86, y: 0.8, k: 0.05, min: 16, max: 36, depth: 0.1, vx: -0.0012 },
    { make: earthDef, x: 0.1, y: 0.66, k: 0.032, min: 11, max: 22, depth: 0.08, vx: 0.0009 },
    { make: marsDef, x: 0.74, y: 0.2, k: 0.018, min: 7, max: 13, depth: 0.07, vx: 0.0011, moon: true },
  ];
  const hole = { x: 0.2, y: 0.28, k: 0.028, min: 10, max: 20, depth: 0.09, vx: 0.0008 };

  // Текстуры планет — по одной после первого кадра, чтобы не тормозить загрузку.
  const queue = planets.slice();
  const buildNext = () => {
    const p = queue.shift(); if (!p) return;
    p.P = p.make(); p.cv = document.createElement("canvas"); p.born = performance.now(); p.lastR = 0; p.lastT = 0;
    setTimeout(buildNext, 30);
  };
  setTimeout(buildNext, 150);

  function resize() {
    dpr = Math.min(devicePixelRatio || 1, 1.75);
    w = innerWidth; h = innerHeight; M = Math.min(w, h);
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const r = rng(101);
    stars = [];
    for (let i = 0, n = Math.round(w * h * 0.00045) + 40; i < n; i++) {
      const t = r();
      stars.push({ x: r() * w, y: r() * h, s: 0.35 + Math.pow(r(), 3) * 1.6, par: 2 + r() * 10, sp: 0.002 + r() * 0.006, tw: r() * TAU, c: t < 0.15 ? "b" : t < 0.3 ? "y" : t < 0.33 ? "r" : "w" });
    }
    bright = Array.from({ length: Math.max(5, Math.round((w * h) / 90000)) }, () => ({ x: r() * w, y: r() * h, s: 5 + r() * 7, tw: r() * TAU, c: r() < 0.5 ? "b" : r() < 0.5 ? "y" : "w", spikes: r() < 0.4 }));
    for (const p of planets) p.lastR = 0;
  }
  addEventListener("resize", resize);
  addEventListener("pointermove", (e) => { tx = (e.clientX / w - 0.5) * 2; ty = (e.clientY / h - 0.5) * 2; }, { passive: true });
  addEventListener("scroll", () => { scroll = scrollY; }, { passive: true });
  resize();

  function place(o, t, size) {
    const span = w + size * 2;
    const x = ((((o.x * w + (reduced ? 0 : o.vx * t) + size) % span) + span) % span) - size - px * o.depth * 40;
    const y = o.y * h + Math.sin(t * 0.00004 + o.x * 9) * 6 - py * o.depth * 40 - scroll * o.depth * 0.12;
    return [x, y];
  }

  function drawPlanet(p, t) {
    if (!p.P) return;
    const R = Math.round(clamp(M * p.k, p.min, p.max));
    if (!p.lastR || p.lastR !== R || (!reduced && t - p.lastT > 140)) {
      renderSphere(p.cv, R, p.P, reduced ? 0.6 : t * p.P.spin);
      if (p.P.ring && p.lastR !== R) p.rings = makeRings(R, p.P.tilt);
      p.lastR = R; p.lastT = t;
    }
    const fade = clamp((t - p.born) / 1500);
    const [x, y] = place(p, t, R * 3);
    ctx.globalAlpha = fade * 0.92;
    if (p.P.atmo) {
      const [ar, ag, ab, ak] = p.P.atmo;
      const gr = ctx.createRadialGradient(x, y, R * 0.95, x, y, R * 1.5);
      gr.addColorStop(0, `rgba(${ar},${ag},${ab},${0.22 * ak})`); gr.addColorStop(1, `rgba(${ar},${ag},${ab},0)`);
      ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(x, y, R * 1.5, 0, TAU); ctx.fill();
    }
    if (p.rings) ctx.drawImage(p.rings.back, x - p.rings.back.width / 2, y - p.rings.back.height / 2);
    ctx.drawImage(p.cv, x - p.cv.width / 2, y - p.cv.height / 2);
    if (p.rings) ctx.drawImage(p.rings.front, x - p.rings.front.width / 2, y - p.rings.front.height / 2);
    if (p.moon) {
      const a = reduced ? 1 : t * 0.00025;
      const mx = x + Math.cos(a) * R * 2.6, my = y + Math.sin(a) * R * 0.7, mr = Math.max(1.6, R * 0.2);
      if (Math.sin(a) > 0 || Math.abs(mx - x) > R) {
        const gr = ctx.createRadialGradient(mx - mr * 0.4, my - mr * 0.4, 0, mx, my, mr);
        gr.addColorStop(0, "#d8d2c8"); gr.addColorStop(0.6, "#8d867c"); gr.addColorStop(1, "#1c1a18");
        ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(mx, my, mr, 0, TAU); ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  function drawHole(t) {
    const R = clamp(M * hole.k, hole.min, hole.max);
    const [x, y] = place(hole, t, R * 5);
    const rot = reduced ? 0 : t * 0.0005;
    const halo = ctx.createRadialGradient(x, y, R, x, y, R * 5);
    halo.addColorStop(0, "rgba(255,150,70,.22)"); halo.addColorStop(0.4, "rgba(150,70,190,.08)"); halo.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = halo; ctx.beginPath(); ctx.arc(x, y, R * 5, 0, TAU); ctx.fill();
    const disk = (front) => {
      ctx.save(); ctx.translate(x, y); ctx.rotate(-0.2);
      const lg = ctx.createLinearGradient(-R * 3.6, 0, R * 3.6, 0);
      lg.addColorStop(0, "rgba(255,250,235,1)"); lg.addColorStop(0.5, "rgba(255,180,95,.8)"); lg.addColorStop(1, "rgba(180,70,35,.4)");
      ctx.strokeStyle = lg;
      for (let k = 1.45; k < 3.4; k += 0.04) {
        const prof = Math.exp(-Math.pow((k - 1.85) / 0.7, 2)) * (0.7 + 0.3 * Math.sin(k * 37 + (rot * 3) / k));
        ctx.globalAlpha = prof * 0.8; ctx.lineWidth = Math.max(0.7, R * 0.07);
        ctx.beginPath(); ctx.ellipse(0, 0, R * k * 1.15, R * k * 0.18, 0, front ? 0 : Math.PI, front ? Math.PI : TAU); ctx.stroke();
      }
      ctx.globalAlpha = 1; ctx.restore();
    };
    disk(false);
    ctx.save();
    ctx.shadowColor = "rgba(255,190,120,.8)"; ctx.shadowBlur = R * 0.35;
    ctx.strokeStyle = "rgba(255,225,190,.75)"; ctx.lineWidth = Math.max(0.8, R * 0.03);
    ctx.beginPath(); ctx.arc(x, y, R * 1.04, 0, TAU); ctx.stroke();
    ctx.restore();
    const sh = ctx.createRadialGradient(x, y, R * 0.7, x, y, R * 1.02);
    sh.addColorStop(0, "#000"); sh.addColorStop(1, "rgba(0,0,0,.92)");
    ctx.fillStyle = sh; ctx.beginPath(); ctx.arc(x, y, R * 1.02, 0, TAU); ctx.fill();
    // дальняя часть диска, изогнутая гравитацией над тенью
    const lg2 = ctx.createLinearGradient(x - R * 1.5, 0, x + R * 1.5, 0);
    lg2.addColorStop(0, "rgba(255,240,215,.5)"); lg2.addColorStop(1, "rgba(220,110,60,.2)");
    ctx.strokeStyle = lg2; ctx.lineWidth = R * 0.1;
    ctx.lineWidth = R * 0.16;
    ctx.beginPath(); ctx.ellipse(x, y, R * 1.16, R * 1.12, 0, Math.PI * 1.02, Math.PI * 1.98); ctx.stroke();
    ctx.lineWidth = R * 0.07; ctx.globalAlpha = 0.6;
    ctx.beginPath(); ctx.ellipse(x, y, R * 1.12, R * 1.08, 0, Math.PI * 0.1, Math.PI * 0.9); ctx.stroke();
    ctx.globalAlpha = 1;
    disk(true);
  }

  let last = performance.now();
  function frame(now) {
    const dt = Math.min(64, now - last); last = now;
    const t = now;
    px += (tx - px) * 0.04; py += (ty - py) * 0.04;
    ctx.clearRect(0, 0, w, h);

    // 1. звёзды
    for (const s of stars) {
      if (!reduced) s.x -= s.sp * dt;
      if (s.x < -4) s.x = w + 4;
      s.tw += dt * 0.0016;
      const x = (((s.x - px * s.par) % w) + w) % w;
      const y = (((s.y - py * s.par - scroll * s.par * 0.015) % h) + h) % h;
      const a = 0.55 + 0.45 * Math.sin(s.tw);
      if (s.s < 0.9) { ctx.globalAlpha = a * 0.8; ctx.fillStyle = "#fff"; ctx.fillRect(x, y, s.s, s.s); }
      else { ctx.globalAlpha = a; const z = s.s * 5; ctx.drawImage(SPR[s.c], x - z / 2, y - z / 2, z, z); }
    }
    ctx.globalAlpha = 1;

    // 2. дальние планеты
    for (const p of planets) drawPlanet(p, t);

    // 3. туманности и галактика поверх — светящийся газ ближе к нам
    ctx.globalCompositeOperation = "lighter";
    for (const n of NEB) {
      const size = Math.max(w, h) * n.s;
      const [x, y] = place(n, t, size / 2);
      const breathe = 1 + Math.sin(t * 0.0002 + n.x * 7) * 0.025;
      ctx.save(); ctx.translate(x, y); ctx.rotate(reduced ? 0 : t * n.rot); ctx.scale(breathe, breathe);
      ctx.globalAlpha = n.a * (0.85 + 0.15 * Math.sin(t * 0.0003 + n.y * 5));
      ctx.drawImage(n.img, -size / 2, -size / 2, size, size);
      ctx.restore();
    }
    {
      const size = Math.max(150, M * galaxy.s);
      const [x, y] = place(galaxy, t, size);
      ctx.save(); ctx.translate(x, y); ctx.rotate(0.5); ctx.scale(1, 0.42); ctx.rotate(reduced ? 0 : t * 0.00003);
      ctx.globalAlpha = 0.7; ctx.drawImage(galaxy.img, -size / 2, -size / 2, size, size);
      ctx.restore();
    }

    // 4. яркие звёзды: мягкое сияние и тонкие дифракционные лучи
    for (const b of bright) {
      b.tw += dt * 0.0009;
      const a = 0.65 + 0.35 * Math.sin(b.tw);
      const x = b.x - px * 18, y = b.y - py * 18;
      ctx.globalAlpha = a; const z = b.s * 4;
      ctx.drawImage(SPR[b.c], x - z / 2, y - z / 2, z, z);
      if (b.spikes) {
        const Lr = b.s * 3.2 * a;
        for (const [dx, dy] of [[1, 0], [0, 1]]) {
          const gr = ctx.createLinearGradient(x - dx * Lr, y - dy * Lr, x + dx * Lr, y + dy * Lr);
          gr.addColorStop(0, "rgba(255,255,255,0)"); gr.addColorStop(0.5, "rgba(255,255,255,.55)"); gr.addColorStop(1, "rgba(255,255,255,0)");
          ctx.strokeStyle = gr; ctx.lineWidth = 0.7;
          ctx.beginPath(); ctx.moveTo(x - dx * Lr, y - dy * Lr); ctx.lineTo(x + dx * Lr, y + dy * Lr); ctx.stroke();
        }
      }
    }
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = "source-over";

    // 5. чёрная дыра поверх газа: её тень поглощает свет туманности
    drawHole(t);

    // 6. падающие звёзды
    if (!reduced) {
      nextMeteor -= dt;
      if (nextMeteor < 0) {
        nextMeteor = 6000 + Math.random() * 10000;
        const ang = 0.5 + Math.random() * 0.5;
        meteors.push({ x: Math.random() * w * 0.8 + w * 0.2, y: Math.random() * h * 0.4, vx: -Math.cos(ang) * 0.8, vy: Math.sin(ang) * 0.8, life: 1 });
      }
      for (let i = meteors.length - 1; i >= 0; i--) {
        const m = meteors[i];
        m.x += m.vx * dt; m.y += m.vy * dt; m.life -= dt / 1000;
        if (m.life <= 0) { meteors.splice(i, 1); continue; }
        const gr = ctx.createLinearGradient(m.x, m.y, m.x - m.vx * 140, m.y - m.vy * 140);
        gr.addColorStop(0, `rgba(255,255,255,${0.9 * m.life})`); gr.addColorStop(1, "rgba(255,255,255,0)");
        ctx.strokeStyle = gr; ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.moveTo(m.x, m.y); ctx.lineTo(m.x - m.vx * 140, m.y - m.vy * 140); ctx.stroke();
      }
    }

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
