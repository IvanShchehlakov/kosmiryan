// Карта неба: стереографическая проекция полусферы над наблюдателем.
// Центр — точка прямо над головой, край — горизонт, север сверху, восток слева (как если
// лежать на спине и смотреть вверх). Звёзды — из каталога по местному
// звёздному времени; Солнце, Луна и планеты — предрасчитаны при сборке.

const RAD = Math.PI / 180;
let catalogPromise = null;
const loadCatalog = () => (catalogPromise ||= fetch("sky-catalog.json").then((r) => r.json()));

export function toHorizontal(raDeg, decDeg, lstDeg, latDeg) {
  const H = (lstDeg - raDeg) * RAD, d = decDeg * RAD, p = latDeg * RAD;
  const alt = Math.asin(Math.sin(p) * Math.sin(d) + Math.cos(p) * Math.cos(d) * Math.cos(H));
  const A = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(p) - Math.tan(d) * Math.cos(p));
  return { alt: alt / RAD, az: (A / RAD + 180 + 360) % 360 };
}

const PLANET_COLOR = { Mercury: "#d7c6b2", Venus: "#fff6d8", Mars: "#ff8a5c", Jupiter: "#ffe6b8", Saturn: "#f3dc98" };
function starColor(bv) {
  if (bv < -0.1) return "#a9c8ff";
  if (bv < 0.3) return "#e4edff";
  if (bv < 0.6) return "#fffaf0";
  if (bv < 1.0) return "#ffeccc";
  return "#ffcf9c";
}

export async function openSky(sky, { el, sfx, typeLines }) {
  const cat = await loadCatalog();
  let sceneKey = "morning";
  const opts = { lines: true, names: true, ecl: true, day: true };

  const canvas = el("canvas", { role: "img", "aria-label": "Карта звёздного неба" });
  const tip = el("div", { class: "sky-tip", hidden: true });
  const wrap = el("div", { class: "sky-canvas-wrap" }, canvas, tip);
  const intro = el("ul", { class: "tx sky-intro" });
  const caption = el("div", { class: "sky-caption" });
  const facts = el("ul", { class: "sky-facts" });
  const segBtns = ["morning", "night"].map((k) =>
    el("button", { type: "button", "aria-pressed": String(k === sceneKey), text: sky.toggle[k], onclick: () => setScene(k) }));
  const chk = (key, label) => el("label", {}, el("input", { type: "checkbox", checked: opts[key], onchange: (e) => { opts[key] = e.target.checked; draw(); } }), label);
  const dayChk = chk("day", "дневной свет");

  const close = () => { overlay.remove(); removeEventListener("resize", draw); document.body.style.overflow = ""; };
  const overlay = el("div", { class: "sky-overlay", role: "dialog", "aria-label": sky.title },
    el("div", { class: "sky-inner" },
      el("div", { class: "sky-top" }, el("span", { class: "label amber", text: "АРХИВ ЦУП · РАССЕКРЕЧЕНО" }), el("button", { class: "x", type: "button", "aria-label": "Закрыть", text: "✕", onclick: close })),
      el("h2", { text: sky.title, style: "margin:8px 0 0;color:#fff;font-size:20px" }),
      el("div", { class: "seg" }, segBtns),
      intro, wrap, caption,
      el("div", { class: "sky-opts" }, chk("lines", "линии созвездий"), chk("names", "названия"), chk("ecl", "эклиптика"), dayChk),
      facts,
      el("div", { class: "sky-src", text: "Расчёт: astronomy-engine (положения Солнца, Луны и планет), " + cat.src + ". Проекция: стереографическая, в центре — точка прямо над головой." }),
    ));
  document.body.append(overlay);
  document.body.style.overflow = "hidden";
  addEventListener("resize", draw);

  let hits = [];
  function setScene(k) {
    sceneKey = k;
    segBtns.forEach((b, i) => b.setAttribute("aria-pressed", String(["morning", "night"][i] === k)));
    const sc = sky.scenes[k];
    dayChk.hidden = !sc.day;
    caption.textContent = sc.caption;
    facts.replaceChildren(...sc.facts.map((f) => el("li", { text: f })));
    typeLines(intro, [sc.intro], { speed: 26 });
    tip.hidden = true;
    sfx.beep();
    draw();
  }

  function draw() {
    const sc = sky.scenes[sceneKey];
    const size = wrap.clientWidth;
    const dpr = Math.min(devicePixelRatio || 1, 2.5);
    canvas.width = size * dpr; canvas.height = size * dpr;
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const k = size / 600;
    const cx = size / 2, cy = size / 2, R = size / 2 - 30 * k - 8;
    const P = (alt, az) => {
      const r = R * Math.tan(((90 - alt) / 2) * RAD);
      return [cx - r * Math.sin(az * RAD), cy - r * Math.cos(az * RAD)];
    };
    const hor = (ra, dec) => toHorizontal(ra, dec, sc.lst, sc.lat);
    hits = [];
    ctx.clearRect(0, 0, size, size);

    // Фон: ночь или день
    const day = sc.day && opts.day && sc.sun.alt > -6;
    const bg = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
    if (day) { bg.addColorStop(0, "#123063"); bg.addColorStop(1, "#2a5794"); }
    else { bg.addColorStop(0, "#070c22"); bg.addColorStop(1, "#0d1838"); }
    ctx.fillStyle = bg;
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, 2 * Math.PI); ctx.fill();

    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, 2 * Math.PI); ctx.clip();

    if (day) {
      const [sx, sy] = P(sc.sun.alt, sc.sun.az);
      const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, R * 1.2);
      g.addColorStop(0, "rgba(255,236,190,.55)"); g.addColorStop(0.25, "rgba(170,210,255,.22)"); g.addColorStop(1, "rgba(120,170,255,0)");
      ctx.fillStyle = g; ctx.fillRect(0, 0, size, size);
    }

    // Сетка высот
    ctx.strokeStyle = "rgba(57,255,136,.12)"; ctx.lineWidth = 1; ctx.setLineDash([3, 5]);
    for (const a of [30, 60]) { const r = R * Math.tan(((90 - a) / 2) * RAD); ctx.beginPath(); ctx.arc(cx, cy, r, 0, 2 * Math.PI); ctx.stroke(); }
    ctx.setLineDash([]);

    // Эклиптика
    if (opts.ecl) {
      const eps = 23.44 * RAD;
      ctx.strokeStyle = "rgba(255,176,32,.45)"; ctx.setLineDash([6, 6]); ctx.lineWidth = 1.2;
      ctx.beginPath(); let pen = false;
      for (let l = 0; l <= 360; l += 2) {
        const L = l * RAD;
        const ra = (Math.atan2(Math.sin(L) * Math.cos(eps), Math.cos(L)) / RAD + 360) % 360;
        const de = Math.asin(Math.sin(eps) * Math.sin(L)) / RAD;
        const h = hor(ra, de);
        if (h.alt < -25) { pen = false; continue; }
        const [x, y] = P(h.alt, h.az);
        pen ? ctx.lineTo(x, y) : ctx.moveTo(x, y); pen = true;
      }
      ctx.stroke(); ctx.setLineDash([]);
    }

    // Линии созвездий
    if (opts.lines) {
      ctx.strokeStyle = day ? "rgba(190,230,255,.45)" : "rgba(90,184,255,.42)"; ctx.lineWidth = 1;
      for (const c of cat.lines) for (const seg of c.l) {
        ctx.beginPath(); let pen = false;
        for (const [ra, de] of seg) {
          const h = hor(ra, de);
          if (h.alt < -25) { pen = false; continue; }
          const [x, y] = P(h.alt, h.az);
          pen ? ctx.lineTo(x, y) : ctx.moveTo(x, y); pen = true;
        }
        ctx.stroke();
      }
    }

    // Звёзды
    const st = cat.stars;
    for (let i = 0; i < st.length; i += 4) {
      const h = hor(st[i], st[i + 1]);
      if (h.alt < 0) continue;
      const mag = st[i + 2];
      const [x, y] = P(h.alt, h.az);
      const r = Math.max(0.45, (6.0 - mag) * 0.62) * k * 1.15;
      ctx.globalAlpha = Math.min(1, 0.35 + (6 - mag) * 0.17);
      ctx.fillStyle = starColor(st[i + 3]);
      ctx.beginPath(); ctx.arc(x, y, r, 0, 2 * Math.PI); ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Названия
    const font = (px, w = 400) => `${w} ${Math.round(px * Math.max(k, 0.62))}px JBM, ui-monospace, monospace`;
    if (opts.names) {
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.font = font(13); ctx.fillStyle = day ? "rgba(200,255,225,.75)" : "rgba(57,255,136,.62)";
      for (const n of cat.names) {
        const h = hor(n.ra, n.dec);
        if (h.alt < 4 || (n.r > 2 && h.alt < 10)) continue;
        const [x, y] = P(h.alt, h.az);
        ctx.fillText(n.n, x, y);
        hits.push({ x, y, t: `Созвездие ${n.n}` });
      }
      ctx.textAlign = "left"; ctx.font = font(11); ctx.fillStyle = "rgba(255,255,255,.7)";
      for (const s of cat.starNames) {
        const h = hor(s.ra, s.dec);
        if (h.alt < 2) continue;
        const [x, y] = P(h.alt, h.az);
        ctx.fillText(s.n, x + 6 * k + 3, y - 6 * k);
        hits.push({ x, y, t: `${s.n} · ${s.m.toFixed(1)}m` });
      }
    }

    // Планеты
    for (const p of sc.planets) {
      if (p.alt < 0) continue;
      const [x, y] = P(p.alt, p.az);
      const r = Math.max(2.2, 4.2 - p.mag * 0.55) * k * 1.3;
      ctx.fillStyle = PLANET_COLOR[p.id] || "#fff";
      ctx.shadowColor = ctx.fillStyle; ctx.shadowBlur = 10;
      ctx.beginPath(); ctx.arc(x, y, r, 0, 2 * Math.PI); ctx.fill(); ctx.shadowBlur = 0;
      ctx.font = font(13, 700); ctx.textAlign = "left"; ctx.fillStyle = "#ffd27a";
      ctx.fillText(p.name, x + r + 4, y + 1);
      hits.push({ x, y, t: `${p.name} · высота ${p.alt.toFixed(1)}° · ${p.mag.toFixed(1)}m`, w: 2 });
    }

    // Солнце и Луна (Солнце рисуем, даже если оно чуть ниже горизонта — для направления фазы)
    const [sx, sy] = P(Math.max(sc.sun.alt, -60), sc.sun.az);
    if (sc.moon.alt > -1) drawMoon(ctx, P(sc.moon.alt, sc.moon.az), [sx, sy], sc.moon, k, font, hits);
    if (sc.sun.alt > -1) {
      const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, 40 * k);
      g.addColorStop(0, "rgba(255,230,150,.9)"); g.addColorStop(1, "rgba(255,200,80,0)");
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(sx, sy, 40 * k, 0, 2 * Math.PI); ctx.fill();
      ctx.fillStyle = "#ffe9a8"; ctx.beginPath(); ctx.arc(sx, sy, 8 * k + 2, 0, 2 * Math.PI); ctx.fill();
      ctx.strokeStyle = "#ffb020"; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(sx, sy, 16 * k + 4, 0, 2 * Math.PI); ctx.stroke();
      for (let a = 0; a < 4; a++) { const an = a * Math.PI / 2; ctx.beginPath(); ctx.moveTo(sx + Math.cos(an) * (16 * k + 6), sy + Math.sin(an) * (16 * k + 6)); ctx.lineTo(sx + Math.cos(an) * (16 * k + 14), sy + Math.sin(an) * (16 * k + 14)); ctx.stroke(); }
      ctx.font = font(14, 700); ctx.fillStyle = "#ffe9a8"; ctx.textAlign = "center";
      ctx.fillText("Солнце", sx, sy - 16 * k - 22);
      hits.push({ x: sx, y: sy, t: `Солнце · высота ${sc.sun.alt.toFixed(1)}°, азимут ${sc.sun.az.toFixed(0)}°`, w: 3 });
    }
    ctx.restore();

    // Горизонт и стороны света
    ctx.strokeStyle = "rgba(57,255,136,.7)"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, 2 * Math.PI); ctx.stroke();
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    const dirs = [["С", 0], ["СВ", 45], ["В", 90], ["ЮВ", 135], ["Ю", 180], ["ЮЗ", 225], ["З", 270], ["СЗ", 315]];
    for (const [t, az] of dirs) {
      const rr = R + 16 * k + 4;
      const x = cx - rr * Math.sin(az * RAD), y = cy - rr * Math.cos(az * RAD);
      ctx.font = font(t.length === 1 ? 15 : 11, t.length === 1 ? 700 : 400);
      ctx.fillStyle = t.length === 1 ? "#39ff88" : "rgba(57,255,136,.55)";
      ctx.fillText(t, x, y);
    }
  }

  wrap.addEventListener("click", (e) => {
    const b = canvas.getBoundingClientRect();
    const x = e.clientX - b.left, y = e.clientY - b.top;
    let best = null, bd = 26;
    for (const h of hits) {
      const d = Math.hypot(h.x - x, h.y - y) - (h.w || 0) * 4;
      if (d < bd) { bd = d; best = h; }
    }
    if (!best) { tip.hidden = true; return; }
    tip.textContent = best.t; tip.hidden = false;
    tip.style.left = Math.min(Math.max(best.x, 80), b.width - 80) + "px"; tip.style.top = best.y + "px";
  });

  setScene("morning");
}

function drawMoon(ctx, [mx, my], [sx, sy], moon, k, font, hits) {
  const r = 9 * k + 3;
  const th = Math.atan2(sy - my, sx - mx);
  const f = Math.max(0, Math.min(1, moon.illum));
  ctx.save();
  ctx.translate(mx, my); ctx.rotate(th);
  ctx.fillStyle = "rgba(30,36,48,.55)"; ctx.beginPath(); ctx.arc(0, 0, r, 0, 2 * Math.PI); ctx.fill();
  ctx.fillStyle = "#f4f1e4";
  ctx.beginPath();
  ctx.arc(0, 0, r, -Math.PI / 2, Math.PI / 2);
  if (f < 0.5) ctx.ellipse(0, 0, r * (1 - 2 * f), r, 0, Math.PI / 2, -Math.PI / 2, true);
  else ctx.ellipse(0, 0, r * (2 * f - 1), r, 0, Math.PI / 2, (3 * Math.PI) / 2, false);
  ctx.fill();
  ctx.strokeStyle = "rgba(244,241,228,.55)"; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(0, 0, r, 0, 2 * Math.PI); ctx.stroke();
  ctx.restore();
  ctx.font = font(13, 700); ctx.textAlign = "center"; ctx.fillStyle = "#f4f1e4";
  ctx.fillText(`Луна · ${Math.round(f * 100)}%`, mx, my + r + 14);
  hits.push({ x: mx, y: my, t: `Луна · освещена на ${(f * 100).toFixed(1)}% · высота ${moon.alt.toFixed(1)}°`, w: 3 });
}
