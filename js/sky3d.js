// 3D-небо: взгляд изнутри небесной сферы над Запорожьем.
// Звёзды — реальный каталог (d3-celestial), положения — по местному звёздному
// времени; Солнце, Луна и планеты — предрасчёт astronomy-engine (в payload).
// Анимация: «ночь накануне» → рассвет → утро 7 декабря (вращение неба —
// настоящее, по звёздному времени; Солнце и Луна интерполируются).
import * as THREE from "./vendor/three.module.min.js";

const RAD = Math.PI / 180;
const R_STAR = 1000;
let catalogP = null;
const loadCatalog = () => (catalogP ||= fetch("sky-catalog.json").then((r) => r.json()));

export function webglOK() {
  try { const c = document.createElement("canvas"); return !!(c.getContext("webgl2") || c.getContext("webgl")); } catch { return false; }
}

// Экваториальные координаты (градусы) → точка на сфере в «небесной» системе.
const eqVec = (raDeg, decDeg, r = R_STAR) => {
  const a = raDeg * RAD, d = decDeg * RAD;
  return new THREE.Vector3(r * Math.cos(d) * Math.cos(a), r * Math.cos(d) * Math.sin(a), r * Math.sin(d));
};

// Матрица «небо → горизонт»: мир x = восток, y = зенит, z = юг (север = −z).
function skyMatrix(lstDeg, latDeg) {
  const L = lstDeg * RAD, c = Math.cos(latDeg * RAD), s = Math.sin(latDeg * RAD);
  const cl = Math.cos(L), sl = Math.sin(L);
  // T · Rz(−LST)
  const m = new THREE.Matrix4();
  m.set(
    -sl, cl, 0, 0,
    c * cl, c * sl, s, 0,
    s * cl, s * sl, -c, 0,
    0, 0, 0, 1,
  );
  return m;
}

function bvColor(bv) {
  if (bv < -0.1) return [0.66, 0.78, 1.0];
  if (bv < 0.3) return [0.88, 0.92, 1.0];
  if (bv < 0.6) return [1.0, 0.98, 0.94];
  if (bv < 1.0) return [1.0, 0.92, 0.8];
  return [1.0, 0.8, 0.62];
}

function glowTexture(inner = "rgba(255,255,255,1)", mid = "rgba(255,230,180,.35)") {
  const c = document.createElement("canvas"); c.width = c.height = 128;
  const g = c.getContext("2d");
  const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, inner); gr.addColorStop(0.18, inner); gr.addColorStop(0.4, mid); gr.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

function moonTexture(f) {
  const c = document.createElement("canvas"); c.width = c.height = 128;
  const g = c.getContext("2d"), r = 52;
  g.translate(64, 64);
  g.fillStyle = "rgba(120,130,150,.35)"; // пепельный свет
  g.beginPath(); g.arc(0, 0, r, 0, Math.PI * 2); g.fill();
  g.fillStyle = "#f4f1e4";
  g.beginPath(); g.arc(0, 0, r, -Math.PI / 2, Math.PI / 2);
  if (f < 0.5) g.ellipse(0, 0, Math.max(0.5, r * (1 - 2 * f)), r, 0, Math.PI / 2, -Math.PI / 2, true);
  else g.ellipse(0, 0, r * (2 * f - 1), r, 0, Math.PI / 2, (3 * Math.PI) / 2, false);
  g.fill();
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

const PLANET_COLOR = { Mercury: 0xd7c6b2, Venus: 0xfff6d8, Mars: 0xff8a5c, Jupiter: 0xffe6b8, Saturn: 0xf3dc98 };

export async function openSky3D(sky, { el, sfx, typeLines }) {
  const cat = await loadCatalog();
  const N = sky.scenes.night, M = sky.scenes.morning;
  const HOURS = sky.hours || 11;
  const lat = M.lat;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---------------------------------------------------------------- DOM
  const stage = el("div", { class: "sky3d-stage" });
  const labels = el("div", { class: "sky3d-labels", "aria-hidden": "true" });
  const intro = el("ul", { class: "tx sky3d-intro" });
  const caption = el("div", { class: "sky3d-caption" });
  const slider = el("input", { type: "range", min: "0", max: "1000", value: "0", class: "sky3d-range", "aria-label": "Время" });
  const playBtn = el("button", { class: "sky3d-play", type: "button", "aria-label": "Воспроизвести", text: "❚❚" });
  const facts = el("ul", { class: "sky-facts" });
  const factsBox = el("details", { class: "sky3d-facts" }, el("summary", { text: "ТЕЛЕМЕТРИЯ АРХИВА" }), facts,
    el("div", { class: "sky-src", text: "Расчёт: astronomy-engine (Солнце, Луна, планеты), " + cat.src + ". Звёзды до 5.6m. Положения — по местному звёздному времени для 47.84° с.ш., 35.14° в.д." }));
  const opts = { lines: true, names: true, day: true };
  const chk = (key, label) => el("label", {}, el("input", { type: "checkbox", checked: opts[key], onchange: (e) => { opts[key] = e.target.checked; } }), label);

  const close = () => { alive = false; overlay.remove(); removeEventListener("resize", onResize); renderer.dispose(); document.body.style.overflow = ""; };
  const overlay = el("div", { class: "sky3d", role: "dialog", "aria-label": sky.title },
    stage, labels,
    el("div", { class: "sky3d-top" },
      el("div", {}, el("span", { class: "label amber", text: "АРХИВ ЦУП · РАССЕКРЕЧЕНО" }), el("h2", { text: sky.title })),
      el("button", { class: "x", type: "button", "aria-label": "Закрыть", text: "✕", onclick: close })),
    el("div", { class: "sky3d-hint", text: "Ведите пальцем, чтобы осмотреться · двумя пальцами — приблизить" }),
    el("div", { class: "sky3d-bottom" },
      intro,
      el("div", { class: "sky3d-time" }, playBtn,
        el("div", { class: "sky3d-track" }, slider,
          el("div", { class: "sky3d-ends" }, el("span", { text: sky.toggle.night }), el("span", { text: sky.toggle.morning })))),
      caption,
      el("div", { class: "sky-opts" }, chk("lines", "линии созвездий"), chk("names", "названия"), chk("day", "дневной свет")),
      factsBox));
  document.body.append(overlay);
  document.body.style.overflow = "hidden";

  // ---------------------------------------------------------------- three.js
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  stage.append(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, 1, 0.5, 3000);

  // Небесный купол (цвет неба зависит от высоты Солнца)
  const domeMat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false,
    uniforms: { sunDir: { value: new THREE.Vector3(0, -1, 0) }, day: { value: 0 } },
    vertexShader: "varying vec3 vDir; void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }",
    fragmentShader: `
      uniform vec3 sunDir; uniform float day; varying vec3 vDir;
      void main(){
        vec3 d = normalize(vDir); float h = max(d.y, 0.0);
        vec3 nightC = mix(vec3(0.035,0.05,0.10), vec3(0.006,0.01,0.03), pow(h, 0.45));
        nightC += vec3(0.10,0.06,0.03) * pow(1.0 - h, 10.0) * 0.6; // засветка города у горизонта
        vec3 dayC = mix(vec3(0.62,0.76,0.93), vec3(0.13,0.34,0.70), pow(h, 0.55));
        vec3 col = mix(nightC, dayC, day);
        float sd = max(dot(d, sunDir), 0.0);
        float twi = smoothstep(-0.32, 0.0, sunDir.y) * (1.0 - smoothstep(0.05, 0.4, sunDir.y));
        col += vec3(1.0, 0.45, 0.16) * pow(sd, 5.0) * twi * pow(1.0 - h, 2.0) * 0.9;
        col += vec3(0.35, 0.22, 0.45) * twi * pow(1.0 - h, 3.0) * 0.35;
        col += vec3(1.0, 0.92, 0.75) * (pow(sd, 400.0) * 3.0 + pow(sd, 18.0) * 0.35) * smoothstep(-0.05, 0.05, sunDir.y);
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(1500, 48, 24), domeMat);
  dome.renderOrder = -10;
  scene.add(dome);

  // Земля: нижняя полусфера + силуэт холмов на горизонте
  const groundMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    uniforms: { day: { value: 0 } },
    vertexShader: "varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }",
    fragmentShader: `uniform float day; varying vec3 vP;
      void main(){ float k = clamp(-normalize(vP).y * 3.0, 0.0, 1.0);
        vec3 c = mix(vec3(0.03,0.035,0.05), vec3(0.008,0.01,0.015), k);
        c = mix(c, mix(vec3(0.16,0.2,0.2), vec3(0.06,0.08,0.08), k), day);
        gl_FragColor = vec4(c, 1.0); }`,
  });
  const ground = new THREE.Mesh(new THREE.SphereGeometry(900, 64, 16, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), groundMat);
  ground.renderOrder = -5;
  scene.add(ground);
  {
    const n = 360, pos = [], idx = [];
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2;
      const hDeg = 0.7 + 0.9 * Math.sin(a * 3 + 1) + 0.6 * Math.sin(a * 7 + 2) + 0.35 * Math.sin(a * 17) + 0.5;
      const r = 880, y = r * Math.tan(Math.max(0.2, hDeg) * RAD);
      pos.push(r * Math.sin(a), y, -r * Math.cos(a), r * Math.sin(a), -60, -r * Math.cos(a));
      if (i < n) { const k = i * 2; idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); geo.setIndex(idx);
    var hillsMat = new THREE.MeshBasicMaterial({ color: 0x05070b, side: THREE.DoubleSide });
    const hills = new THREE.Mesh(geo, hillsMat); hills.renderOrder = -4;
    scene.add(hills);
  }
  // огоньки города у горизонта (на севере-востоке)
  {
    const pos = [];
    for (let i = 0; i < 160; i++) {
      const a = (10 + Math.random() * 90) * RAD, r = 870, h = (0.05 + Math.random() * 0.5) * RAD;
      pos.push(r * Math.sin(a), r * Math.tan(h), -r * Math.cos(a));
    }
    const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    var cityMat = new THREE.PointsMaterial({ color: 0xffb060, size: 2.2, sizeAttenuation: false, transparent: true, opacity: 0.8, depthWrite: false });
    scene.add(new THREE.Points(g, cityMat));
  }

  // Небесная сфера: всё, что вращается вместе с небом
  const sky3 = new THREE.Group();
  sky3.matrixAutoUpdate = false;
  scene.add(sky3);

  const starMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uScale: { value: renderer.getPixelRatio() }, uVis: { value: 1 }, uTime: { value: 0 }, uZoom: { value: 1 } },
    vertexShader: `attribute float size; attribute vec3 color; attribute float phase;
      uniform float uScale; uniform float uVis; uniform float uTime; uniform float uZoom;
      varying vec3 vColor; varying float vA;
      void main(){ vec4 mv = modelViewMatrix * vec4(position,1.0); gl_Position = projectionMatrix * mv;
        float tw = 0.82 + 0.18 * sin(uTime * (1.5 + phase) + phase * 7.0);
        gl_PointSize = size * uScale * uZoom; vColor = color; vA = uVis * tw; }`,
    fragmentShader: `varying vec3 vColor; varying float vA;
      void main(){ vec2 p = gl_PointCoord - 0.5; float r2 = dot(p,p);
        float a = exp(-r2 * 22.0) + 0.25 * exp(-r2 * 5.0); if (a < 0.01) discard;
        gl_FragColor = vec4(vColor * a * vA, 1.0); }`,
  });
  {
    const st = cat.stars, n = st.length / 4;
    const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), size = new Float32Array(n), ph = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const v = eqVec(st[i * 4], st[i * 4 + 1]);
      pos.set([v.x, v.y, v.z], i * 3);
      const mag = st[i * 4 + 2];
      const c = bvColor(st[i * 4 + 3]);
      const b = Math.min(1, 0.45 + (6 - mag) * 0.14);
      col.set([c[0] * b, c[1] * b, c[2] * b], i * 3);
      size[i] = Math.max(2.2, (6.6 - mag) * 2.3);
      ph[i] = Math.random();
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    g.setAttribute("size", new THREE.BufferAttribute(size, 1));
    g.setAttribute("phase", new THREE.BufferAttribute(ph, 1));
    sky3.add(new THREE.Points(g, starMat));
  }

  // Млечный Путь: тысячи слабых частиц вдоль галактической плоскости
  {
    const T = [[-0.0548755604, -0.8734370902, -0.4838350155], [0.4941094279, -0.444829630, 0.7469822445], [-0.867666149, -0.1980763734, 0.4559837762]];
    const n = 22000, pos = new Float32Array(n * 3), col = new Float32Array(n * 3), size = new Float32Array(n), ph = new Float32Array(n);
    const gauss = () => (Math.random() + Math.random() + Math.random() + Math.random() - 2) / 2;
    for (let i = 0; i < n; i++) {
      let l = Math.random() * Math.PI * 2;
      if (Math.random() < 0.45) l = gauss() * 0.9; // ярче к центру Галактики
      const width = 0.09 + 0.1 * Math.cos(l) ** 2;
      const b = gauss() * width;
      const gx = Math.cos(b) * Math.cos(l), gy = Math.cos(b) * Math.sin(l), gz = Math.sin(b);
      const ex = T[0][0] * gx + T[1][0] * gy + T[2][0] * gz;
      const ey = T[0][1] * gx + T[1][1] * gy + T[2][1] * gz;
      const ez = T[0][2] * gx + T[1][2] * gy + T[2][2] * gz;
      pos.set([ex * R_STAR * 1.01, ey * R_STAR * 1.01, ez * R_STAR * 1.01], i * 3);
      const warm = Math.random() < 0.3 + 0.3 * Math.cos(l) ** 2;
      const k = (0.011 + Math.random() * 0.022) * (Math.min(innerWidth, innerHeight) < 600 ? 0.7 : 1);
      col.set(warm ? [k * 1.1, k * 0.95, k * 0.8] : [k * 0.8, k * 0.9, k * 1.15], i * 3);
      size[i] = 14 + Math.random() * 20;
      ph[i] = Math.random();
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    g.setAttribute("size", new THREE.BufferAttribute(size, 1));
    g.setAttribute("phase", new THREE.BufferAttribute(ph, 1));
    var mwMat = starMat.clone();
    mwMat.fragmentShader = `varying vec3 vColor; varying float vA;
      void main(){ vec2 p = gl_PointCoord - 0.5; float a = exp(-dot(p,p) * 7.0); if (a < 0.03) discard;
        gl_FragColor = vec4(vColor * a * vA, 1.0); }`;
    mwMat.vertexShader = mwMat.vertexShader.replace("float tw = 0.82 + 0.18 * sin(uTime * (1.5 + phase) + phase * 7.0);", "float tw = 1.0;");
    sky3.add(new THREE.Points(g, mwMat));
  }

  // Линии созвездий
  const lineMat = new THREE.LineBasicMaterial({ color: 0x6fc3ff, transparent: true, opacity: 0.32, depthWrite: false });
  {
    const pos = [];
    for (const c of cat.lines) for (const seg of c.l) for (let i = 1; i < seg.length; i++) {
      const a = eqVec(seg[i - 1][0], seg[i - 1][1], R_STAR * 0.995), b = eqVec(seg[i][0], seg[i][1], R_STAR * 0.995);
      pos.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }
    const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    sky3.add(new THREE.LineSegments(g, lineMat));
  }

  // Солнце, Луна, планеты
  const sunGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture("rgba(255,250,235,1)", "rgba(255,210,140,.35)"), blending: THREE.AdditiveBlending, depthWrite: false }));
  sunGlow.scale.setScalar(170);
  sky3.add(sunGlow);
  const moonSpr = new THREE.Sprite(new THREE.SpriteMaterial({ map: moonTexture(M.moon.illum), transparent: true, depthWrite: false }));
  moonSpr.scale.setScalar(34);
  sky3.add(moonSpr);
  const planetSpr = M.planets.map((p) => {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: PLANET_COLOR[p.id] || 0xffffff, blending: THREE.AdditiveBlending, depthWrite: false }));
    s.scale.setScalar(Math.max(14, 30 - p.mag * 6));
    sky3.add(s);
    return s;
  });

  // ---------------------------------------------------------------- подписи (HTML поверх 3D)
  const L = [];
  const addLabel = (text, cls, getPos, minAlt = 2) => {
    const e = el("span", { class: "sky3d-label " + cls, text });
    labels.append(e); L.push({ e, getPos, minAlt, cls });
  };
  const tmp = new THREE.Vector3();
  for (const n of cat.names) { const v = eqVec(n.ra, n.dec); addLabel(n.n, "con" + (n.r > 2 ? " minor" : ""), () => tmp.copy(v).applyMatrix4(sky3.matrix), 4); }
  for (const s of cat.starNames) { const v = eqVec(s.ra, s.dec); addLabel(s.n, "star", () => tmp.copy(v).applyMatrix4(sky3.matrix).add(new THREE.Vector3(0, 9, 0)), 2); }
  M.planets.forEach((p, i) => addLabel(p.name, "planet", () => planetSpr[i].getWorldPosition(tmp).add(new THREE.Vector3(0, 16, 0)), 0));
  addLabel("Солнце", "sun", () => sunGlow.getWorldPosition(tmp).add(new THREE.Vector3(0, 40, 0)), -1);
  addLabel("Луна", "moon", () => moonSpr.getWorldPosition(tmp).add(new THREE.Vector3(0, -26, 0)), 0);
  for (const [t, az] of [["С", 0], ["СВ", 45], ["В", 90], ["ЮВ", 135], ["Ю", 180], ["ЮЗ", 225], ["З", 270], ["СЗ", 315]]) {
    const v = new THREE.Vector3(Math.sin(az * RAD) * 850, 850 * Math.tan(4 * RAD), -Math.cos(az * RAD) * 850);
    addLabel(t, "dir" + (t.length > 1 ? " minor" : ""), () => tmp.copy(v), -90);
  }

  // ---------------------------------------------------------------- состояние сцены во времени t ∈ [0,1]
  const lerp = (a, b, k) => a + (b - a) * k;
  const lerpRA = (a, b, k) => { let d = b - a; if (d > 180) d -= 360; if (d < -180) d += 360; return a + d * k; };
  const SIDEREAL = 15.041068640; // °/ч
  let t = reduced ? 1 : 0, playing = !reduced, lastShown = null;
  const sunW = new THREE.Vector3();

  function applyTime() {
    const lst = N.lst + SIDEREAL * HOURS * t;
    sky3.matrix.copy(skyMatrix(lst, lat));
    sky3.matrixWorldNeedsUpdate = true;
    sunGlow.position.copy(eqVec(lerpRA(N.sun.ra, M.sun.ra, t), lerp(N.sun.dec, M.sun.dec, t), 960));
    moonSpr.position.copy(eqVec(lerpRA(N.moon.ra, M.moon.ra, t), lerp(N.moon.dec, M.moon.dec, t), 950));
    M.planets.forEach((p, i) => {
      const q = N.planets[i];
      planetSpr[i].position.copy(eqVec(lerpRA(q.ra, p.ra, t), lerp(q.dec, p.dec, t), 980));
    });
    sky3.updateMatrixWorld(true);
    sunGlow.getWorldPosition(sunW).normalize();
    const day = opts.day ? THREE.MathUtils.smoothstep(sunW.y, -0.12, 0.18) : 0;
    domeMat.uniforms.sunDir.value.copy(sunW);
    domeMat.uniforms.day.value = day;
    groundMat.uniforms.day.value = day;
    hillsMat.color.setRGB(lerp(0.02, 0.09, day), lerp(0.027, 0.12, day), lerp(0.04, 0.11, day));
    cityMat.opacity = 0.8 * (1 - day);
    starMat.uniforms.uVis.value = lerp(1, 0.42, day);
    mwMat.uniforms.uVis.value = lerp(1, 0.05, day);
    sunGlow.material.opacity = THREE.MathUtils.smoothstep(sunW.y, -0.08, 0.02);
    // какой «конец» ближе — такие подписи и факты
    const end = t > 0.5 ? "morning" : "night";
    if (end !== lastShown) {
      lastShown = end;
      const sc = sky.scenes[end];
      caption.textContent = sc.caption;
      facts.replaceChildren(...sc.facts.map((f) => el("li", { text: f })));
    }
  }

  // ---------------------------------------------------------------- управление взглядом
  let yaw = 140 * RAD, pitch = 22 * RAD, fov = 72, idle = 0;
  const pointers = new Map();
  let pinch0 = 0, fov0 = fov;
  const cv = renderer.domElement;
  cv.style.touchAction = "none";
  cv.addEventListener("pointerdown", (e) => { cv.setPointerCapture(e.pointerId); pointers.set(e.pointerId, [e.clientX, e.clientY]); idle = 0;
    if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch0 = Math.hypot(a[0] - b[0], a[1] - b[1]); fov0 = fov; } });
  cv.addEventListener("pointermove", (e) => {
    if (!pointers.has(e.pointerId)) return;
    const prev = pointers.get(e.pointerId); pointers.set(e.pointerId, [e.clientX, e.clientY]); idle = 0;
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()]; const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      if (pinch0) fov = THREE.MathUtils.clamp(fov0 * pinch0 / d, 25, 100);
      return;
    }
    const k = (fov / 72) * 0.0055;
    yaw -= (e.clientX - prev[0]) * k;
    pitch = THREE.MathUtils.clamp(pitch + (e.clientY - prev[1]) * k, -8 * RAD, 89 * RAD);
  });
  const up = (e) => { pointers.delete(e.pointerId); if (pointers.size < 2) pinch0 = 0; };
  cv.addEventListener("pointerup", up); cv.addEventListener("pointercancel", up);
  cv.addEventListener("wheel", (e) => { e.preventDefault(); fov = THREE.MathUtils.clamp(fov * (1 + e.deltaY * 0.001), 25, 100); idle = 0; }, { passive: false });

  slider.addEventListener("input", () => { t = slider.value / 1000; playing = false; playBtn.textContent = "▶"; applyTime(); });
  playBtn.addEventListener("click", () => {
    if (t >= 1) t = 0;
    playing = !playing; playBtn.textContent = playing ? "❚❚" : "▶"; sfx.beep();
  });
  if (reduced) playBtn.textContent = "▶";

  function onResize() {
    const w = stage.clientWidth, h = stage.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
  }
  addEventListener("resize", onResize);
  onResize();

  // Подсказки-тексты: ночь → утро
  typeLines(intro, [sky.scenes.night.intro], { instant: reduced });
  let introMorning = false;

  // ---------------------------------------------------------------- кадр
  let alive = true, last = performance.now();
  const proj = new THREE.Vector3();
  const look = new THREE.Vector3();
  function frame(now) {
    if (!alive) return;
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    if (playing) {
      t = Math.min(1, t + dt / 22); // ~22 секунды от ночи до утра
      slider.value = String(Math.round(t * 1000));
      if (t >= 1) { playing = false; playBtn.textContent = "↺"; }
    }
    if (t > 0.97 && !introMorning) { introMorning = true; typeLines(intro, [sky.scenes.morning.intro], { instant: reduced }); sfx.unlock(); }
    idle += dt;
    if (idle > 6 && !pointers.size && !playing) yaw += dt * 0.02; // лёгкий дрейф взгляда
    applyTime();
    starMat.uniforms.uTime.value = now / 1000;
    starMat.uniforms.uZoom.value = Math.sqrt(72 / fov);
    mwMat.uniforms.uZoom.value = Math.sqrt(72 / fov);
    lineMat.opacity = opts.lines ? 0.32 : 0;

    camera.fov = fov; camera.updateProjectionMatrix();
    look.set(Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch), -Math.cos(pitch) * Math.cos(yaw));
    camera.position.set(0, 0, 0);
    camera.lookAt(look);
    camera.updateMatrixWorld();

    // Луна: светлый край — к Солнцу (на экране)
    const ms = moonSpr.getWorldPosition(new THREE.Vector3()).project(camera);
    const ss = sunW.clone().multiplyScalar(960).project(camera);
    moonSpr.material.rotation = Math.atan2(ss.y - ms.y, (ss.x - ms.x) * camera.aspect);

    renderer.render(scene, camera);

    // подписи
    const w = stage.clientWidth, h = stage.clientHeight;
    for (const lb of L) {
      const show = (opts.names || lb.cls.startsWith("dir") || lb.cls === "sun" || lb.cls === "moon" || lb.cls === "planet");
      const p = lb.getPos();
      const alt = Math.asin(THREE.MathUtils.clamp(p.y / p.length(), -1, 1)) / RAD;
      proj.copy(p).project(camera);
      const vis = show && alt >= lb.minAlt && proj.z < 1 && Math.abs(proj.x) < 1.1 && Math.abs(proj.y) < 1.1;
      if (!vis) { if (lb.on) { lb.e.style.display = "none"; lb.on = false; } continue; }
      if (!lb.on) { lb.e.style.display = ""; lb.on = true; }
      lb.e.style.transform = `translate(${((proj.x + 1) / 2) * w}px, ${((1 - proj.y) / 2) * h}px) translate(-50%, -50%)`;
    }
    requestAnimationFrame(frame);
  }
  for (const lb of L) { lb.e.style.display = "none"; lb.on = false; }
  applyTime();
  requestAnimationFrame(frame);
}
