// ЦУП · Миссия BD-0712 — логика квеста.
// Всё содержимое этапов приходит из data.json в зашифрованном виде
// (AES-GCM, ключ из кода через PBKDF2) и расшифровывается только кодом.

import { candidates } from "./normalize.js";
import { setSound, sfx, typeLines, sleep, staticNoise, signalWave, spiral, ambience, audioRunning } from "./fx.js";
import { cosmos } from "./cosmos.js";

const LS_KEY = "bd0712.v1";
const app = document.getElementById("app");
const enc = new TextEncoder();
const dec = new TextDecoder();

let DATA = null;   // data.json
let entry = null;  // расшифрованный брифинг
let stages = [];   // расшифрованные этапы по порядку
let debug = null;  // { pw, codes } в режиме отладки
let S; // состояние прогресса — загружается ниже (loadState / restoreBest)

// ================================================================ state
function freshState() {
  return { pw: null, accepted: false, codes: [], completed: 0, gates: {}, times: {}, hints: {}, typed: {}, fails: 0, done: false, sound: true };
}
// Прогресс хранится на самом устройстве (не на сервере и не по IP) в двух
// местах: localStorage и IndexedDB. Каждое сохранение получает номер ревизии,
// при загрузке берётся самая свежая копия. Так прогресс переживает выключение
// телефона, пропажу сети и потерю одного из хранилищ.
let maxRev = 0;
let storageOk = true;
function readLocal() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || "null"); } catch { return null; }
}
function loadState() {
  const s = readLocal();
  maxRev = s?.rev || 0;
  return { ...freshState(), ...(s || {}) };
}
function save() {
  S.device = S.device || DEVICE;
  S.rev = ++maxRev;
  S.savedAt = Date.now();
  try { localStorage.setItem(LS_KEY, JSON.stringify(S)); } catch { storageOk = false; }
  idbPut(S);
}

const IDB_TIMEOUT = 1200;
function idbOpen() {
  return new Promise((res, rej) => {
    const r = indexedDB.open("bd0712", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("s");
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
function withTimeout(p) { return Promise.race([p, new Promise((r) => setTimeout(() => r(null), IDB_TIMEOUT))]); }
function idbGet() {
  return withTimeout((async () => {
    try {
      const db = await idbOpen();
      return await new Promise((res) => {
        const q = db.transaction("s").objectStore("s").get("state");
        q.onsuccess = () => res(q.result || null); q.onerror = () => res(null);
      });
    } catch { return null; }
  })());
}
async function idbPut(v) {
  try { const db = await idbOpen(); db.transaction("s", "readwrite").objectStore("s").put(JSON.parse(JSON.stringify(v)), "state"); }
  catch { /* IndexedDB недоступен — остаётся localStorage */ }
}
/** Сверяет две копии и берёт более свежую; затем синхронизирует обе. */
async function restoreBest() {
  const fromIdb = await idbGet();
  const fromLs = readLocal();
  const best = [fromLs, fromIdb].filter(Boolean).sort((a, b) => (b.rev || 0) - (a.rev || 0))[0];
  if (best) {
    maxRev = Math.max(fromLs?.rev || 0, fromIdb?.rev || 0);
    S = { ...freshState(), ...best };
  }
  return { restored: !!best && !!(best.pw || best.codes?.length), from: best === fromIdb && fromIdb !== fromLs ? "idb" : "ls" };
}

// Метка устройства: случайный номер «бортового терминала», создаётся один раз.
const DEVICE = (() => {
  const s = readLocal();
  if (s?.device) return s.device;
  const a = crypto.getRandomValues(new Uint8Array(2));
  return [...a].map((x) => x.toString(16).padStart(2, "0")).join("").toUpperCase();
})();

S = loadState();
let restoredOnce = false;

// Просим браузер не удалять данные сайта при нехватке места (без всплывающих окон).
function askPersist() {
  try {
    if (/firefox/i.test(navigator.userAgent)) return; // Firefox показывает запрос — не нужен
    navigator.storage?.persisted?.().then((p) => { if (!p) navigator.storage.persist?.(); });
  } catch { /* не поддерживается */ }
}

// ================================================================ crypto
const b64d = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function derive(secret, salt) {
  const base = await crypto.subtle.importKey("raw", enc.encode(secret), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: b64d(salt), iterations: DATA.iter, hash: "SHA-256" },
    base, { name: "AES-GCM", length: 256 }, false, ["decrypt"],
  );
}
async function openBlob(key, blob, aad) {
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64d(blob.iv), additionalData: enc.encode(aad) }, key, b64d(blob.ct));
  return JSON.parse(dec.decode(pt));
}
/** Пробует все варианты прочтения ввода. → { code, payload } | null */
async function tryCode(input, salt, blob, aad, exact = false) {
  if (!blob) return null;
  for (const c of exact ? [input] : candidates(input)) {
    try { return { code: c, payload: await openBlob(await derive(c, salt), blob, aad) }; } catch { /* не тот код */ }
  }
  return null;
}
const nextRef = () => (stages.length ? stages[stages.length - 1].next : entry?.next) || null;

// ================================================================ dom helpers
function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else if (k === "html") e.innerHTML = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return e;
}
const pad = (n) => String(n).padStart(2, "0");
const hm = (t) => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };

function glyphSvg(g) {
  const parts = g.parts.map((p) => p.c ? `<circle class="f" cx="${p.c[0]}" cy="${p.c[1]}" r="${p.c[2]}"/>`
    : p.w ? `<path class="s" d="${p.d}" stroke-width="${p.w}"/>` : `<path class="f" d="${p.d}"/>`).join("");
  return `<svg class="glyph" viewBox="0 0 100 100" aria-hidden="true">${parts}</svg>`;
}

function makePatch() {
  const svg = document.getElementById("patch-tpl").content.firstElementChild.cloneNode(true);
  if (entry) {
    svg.querySelector(".p-name textPath").textContent = `КОМАНДИР ${String(entry.commander).toUpperCase()}`;
    svg.querySelector(".p-ring textPath").textContent = `${String(entry.codename).toUpperCase()} · ${entry.mission}`;
  }
  const addon = stages.map((s) => s.patchAddon).filter(Boolean).join("");
  if (addon) svg.querySelector(".patch-addon").innerHTML = addon;
  return svg;
}

let onSignal = false; // открыт экран сигнала — играет звук приёма
/** Звук приёма играет только на экране сигнала и только до верного ответа. */
function startAmbience() {
  if (S.sound && onSignal && !entry) ambience.start();
}
function screen(...nodes) {
  if (onSignal) { onSignal = false; ambience.stop(0.8); }
  document.querySelector(".tune-in")?.remove();
  app.replaceChildren(...nodes);
  scrollTo({ top: 0 });
}

// ================================================================ boot
async function boot() {
  app.replaceChildren(el("div", { class: "boot" }, el("div", { class: "boot-line" }, "ИНИЦИАЛИЗАЦИЯ КАНАЛА СВЯЗИ", el("span", { class: "blink", text: "_" }))));
  if (!restoredOnce) {
    restoredOnce = true;
    await restoreBest();
    if (!S.device) S.device = DEVICE;
    syncSound();
    if (S.pw) {
      app.querySelector(".boot-line").firstChild.textContent = `ТЕРМИНАЛ ${S.device} ОПОЗНАН · ВОССТАНОВЛЕНИЕ БОРТОВОГО ЖУРНАЛА `;
      save(); // выравниваем обе копии
      await sleep(500);
    }
  }
  if (!DATA) {
    try {
      DATA = await (await fetch("data.json", { cache: "no-cache" })).json();
    } catch {
      app.replaceChildren(el("div", { class: "boot" }, el("div", { class: "red", text: "НЕТ СВЯЗИ С ЦУП. Проверьте интернет и обновите страницу." })));
      return;
    }
    document.title = DATA.pub.title;
  }
  if (!crypto?.subtle) {
    app.replaceChildren(el("div", { class: "boot red", text: "Канал не защищён: откройте сайт по https://" }));
    return;
  }

  // Режим отладки
  const dbgParam = new URLSearchParams(location.search).get("debug");
  if (dbgParam && !debug) {
    const r = await tryCode(dbgParam, DATA.dbg.salt, DATA.dbg, "dbg", true);
    if (r) debug = r.payload;
  }
  if (debug) renderDebug();
  renderResetButton();

  // Перенос прогресса с другого устройства: ссылка вида …/#sync=PW.CODE1.CODE2
  const sync = /#sync=([^&]+)(?:&c=(\d+))?/.exec(location.hash);
  if (sync) {
    const parts = decodeURIComponent(sync[1]).split(".").filter(Boolean);
    history.replaceState(null, "", location.pathname + location.search);
    if (parts.length) {
      S = { ...S, pw: parts[0], accepted: true, codes: parts.slice(1), completed: Number(sync[2] || 0), done: false };
      S.times.start = S.times.start || Date.now();
      save();
    }
  }

  // Восстановление прогресса: заново расшифровываем цепочку сохранёнными кодами.
  entry = null; stages = [];
  if (S.pw) {
    const r = await tryCode(S.pw, DATA.entry.salt, DATA.entry, "entry", true);
    if (r) entry = r.payload; else { S = { ...freshState(), sound: S.sound }; save(); }
  }
  if (entry) {
    const line = app.querySelector(".boot-line");
    for (let i = 0; i < S.codes.length; i++) {
      line.firstChild.textContent = `СИНХРОНИЗАЦИЯ БОРТОВОГО ЖУРНАЛА · ${pad(i + 1)} `;
      const ref = nextRef();
      // Этап без кода: актуальный ключ всегда лежит в предыдущем этапе.
      if (ref?.auto) S.codes[i] = ref.auto;
      const r = ref && (await tryCode(S.codes[i], ref.salt, DATA.blobs[ref.id], ref.id, true));
      if (!r) { S.codes = S.codes.slice(0, i); save(); break; }
      stages.push(r.payload);
    }
  }

  S.completed = Math.min(S.completed || 0, stages.length);
  setTimeout(checkAwayAfterReload, 400); // вкладку могли выгрузить, пока её не было
  if (!entry) return signalScreen();
  if (!S.accepted) return briefingScreen();
  if (S.done && stages.at(-1)?.finale) return finaleScreen();
  return consoleScreen();
}

// ================================================================ 1. сигнал
function signalScreen() {
  const P = DATA.pub;
  const sig = P.signal;
  const wave = el("canvas", { class: "wave" });
  const word = el("div", { class: "glyph-word", html: P.word.map(glyphSvg).join(""), role: "img", "aria-label": "Слово, записанное неизвестными символами" });
  const input = el("input", { name: "answer", autocomplete: "off", autocapitalize: "characters", spellcheck: "false", enterkeyhint: "go", placeholder: sig.inputPlaceholder, "aria-label": "Ответ" });
  const btn = el("button", { class: "btn", type: "submit", text: sig.button });
  const fb = el("div", { class: "feedback", role: "status" });
  const hints = el("div", { class: "hints" });
  const tableSlot = el("div");

  function renderHints() {
    hints.replaceChildren(...P.hints.filter((h) => S.fails >= h.after).map((h) => el("div", { class: "hint" }, el("span", { class: "label", text: "ЦУП · ПОДСКАЗКА" }), h.text)));
    tableSlot.replaceChildren();
    if (P.table && P.tableAfter && S.fails >= P.tableAfter) tableSlot.append(el("button", { class: "btn ghost block", type: "button", text: P.tableButton, onclick: showTable }));
  }

  const form = el("form", { class: "code-form", onsubmit: async (e) => {
    e.preventDefault();
    const v = input.value.trim();
    if (!v) return input.focus();
    btn.disabled = true; fb.className = "feedback"; fb.textContent = "ПРОВЕРКА РАСШИФРОВКИ...";
    const r = await tryCode(v, DATA.entry.salt, DATA.entry, "entry");
    btn.disabled = false;
    if (r) {
      // Сигнал расшифрован — звук приёма выключается сразу и больше не запускается.
      onSignal = false; ambience.stop(0.8);
      S.pw = r.code; entry = r.payload; save();
      sfx.ok();
      fb.className = "feedback ok"; fb.textContent = "✔ " + sig.success;
      word.style.filter = "drop-shadow(0 0 18px #39ff88) brightness(1.6)";
      await sleep(1300);
      briefingScreen();
    } else {
      S.fails++; save();
      sfx.err();
      fb.className = "feedback err";
      fb.textContent = sig.wrong[(S.fails - 1) % sig.wrong.length];
      form.classList.remove("shake"); void form.offsetWidth; form.classList.add("shake");
      renderHints();
    }
  } }, input, btn);

  screen(el("section", { class: "signal" },
    el("div", { class: "alert" }, el("span", { class: "lamp" }), el("span", { text: sig.header })),
    el("div", { class: "panel" },
      el("div", { class: "meta" }, sig.meta.map((m) => el("span", { text: m }))),
      wave,
      word,
      el("p", { class: "prompt", text: sig.prompt }),
      form, fb,
    ),
    disclaimerBox(),
    hints, tableSlot,
  ));
  signalWave(wave);
  renderHints();
  onSignal = true;
  if (S.sound) { if (audioRunning()) startAmbience(); else tuneIn(); }
}

/** Заставка «принять сигнал»: браузеры включают звук только после касания. */
function tuneIn() {
  if (document.querySelector(".tune-in")) return;
  const accept = () => {
    S.sound = true; save(); setSound(true); syncSound();
    startAmbience();
    ov.remove();
  };
  const ov = el("div", { class: "tune-in", role: "dialog", "aria-label": "Входящий сигнал", onclick: (e) => { if (e.target === ov) accept(); } },
    el("div", { class: "tune-box" },
      el("div", { class: "radar", "aria-hidden": "true" }, el("i"), el("i"), el("i")),
      el("div", { class: "label red", text: "ВХОДЯЩИЙ СИГНАЛ · ИСТОЧНИК НЕ ОПРЕДЕЛЁН" }),
      el("button", { class: "btn", type: "button", text: "▶ ПРИНЯТЬ СИГНАЛ", onclick: accept }),
      el("button", { class: "mute-link", type: "button", text: "продолжить без звука", onclick: () => {
        S.sound = false; save(); setSound(false); syncSound(); ov.remove();
      } })));
  document.body.append(ov);
}

function disclaimerBox() {
  const sig = DATA.pub.signal;
  if (!sig.disclaimer) return null;
  return el("div", { class: "disclaimer", role: "note" },
    el("span", { class: "label", text: sig.disclaimerLabel || "⚠ ВНИМАНИЕ" }),
    el("span", { text: sig.disclaimer }));
}

function showTable() {
  sfx.beep();
  const P = DATA.pub;
  const close = () => m.remove();
  const m = el("div", { class: "modal", onclick: (e) => { if (e.target === m) close(); } },
    el("div", { class: "panel" },
      el("div", { class: "modal-head" }, el("span", { class: "label amber", text: P.tableTitle }), el("button", { class: "x", type: "button", "aria-label": "Закрыть", text: "✕", onclick: close })),
      el("div", { class: "table-grid" }, P.table.map((g) => el("figure", { html: glyphSvg(g) }, el("figcaption", {}, el("b", { text: g.latin }), g.name)))),
    ));
  document.body.append(m);
}

// ================================================================ 2. брифинг
async function briefingScreen() {
  const ul = el("ul", { class: "tx" });
  const btn = el("button", { class: "btn block", type: "button", text: entry.acceptButton, style: "visibility:hidden" });
  btn.style.visibility = "hidden";
  btn.onclick = () => {
    S.accepted = true; S.times.start = S.times.start || Date.now(); save();
    askPersist();
    sfx.beep();
    consoleScreen();
  };
  const patch = makePatch();
  patch.style.cssText = "width:110px;height:110px;display:block;margin:0 auto 14px";
  screen(el("section", { class: "panel" },
    patch,
    el("div", { class: "label", text: "ВХОДЯЩАЯ ПЕРЕДАЧА · ЦУП (ЦЕНТР УПРАВЛЕНИЯ ПОЛЁТАМИ)" }),
    el("h2", { text: `Брифинг космической миссии «${entry.codename}»`, style: "margin:4px 0 16px;color:#fff;font-size:20px" }),
    ul,
    el("div", { class: "tap-skip", text: S.typed.briefing ? "" : "нажмите на текст, чтобы допечатать" }),
    el("div", { style: "margin-top:18px" }, btn),
  ));
  await typeLines(ul, entry.briefing, { instant: S.typed.briefing });
  S.typed.briefing = true; save();
  btn.style.visibility = "visible";
  btn.classList.add("reveal");
}

// ================================================================ 3. консоль ЦУП
function hud() {
  const next = S.completed >= stages.length ? nextRef() : null;
  const patch = makePatch();
  patch.addEventListener("click", showPatch);
  return el("header", { class: "panel hud" },
    patch,
    el("div", {},
      el("h1", { text: `МИССИЯ «${String(entry.codename).toUpperCase()}» · ${entry.mission}` }),
      el("div", { class: "sub", text: "ЦУП · ЦЕНТР УПРАВЛЕНИЯ ПОЛЁТАМИ" }),
      el("div", { class: "sub" }, `КОМАНДИР ${String(entry.commander).toUpperCase()} · `, el("span", { class: "clock", "data-clock": "" })),
      el("div", { class: "lights" },
        el("span", { class: "light" + (navigator.onLine ? "" : " amber"), "data-net": "", text: navigator.onLine ? "СВЯЗЬ" : "АВТОНОМНО" }),
        el("span", { class: "light", text: "НАВИГАЦИЯ" }),
        el("span", { class: "light", text: "ЖИЗНЕОБЕСПЕЧЕНИЕ" }),
        el("span", { class: "light" + (storageOk ? "" : " amber"), title: "Прогресс сохраняется на этом устройстве", text: storageOk ? `ТЕРМИНАЛ ${S.device || DEVICE} · ЖУРНАЛ СОХРАНЁН` : "ЖУРНАЛ НЕ СОХРАНЯЕТСЯ" }),
        next ? el("span", { class: "light amber", text: "ОЖИДАНИЕ СИГНАЛА" })
          : S.completed < stages.length ? el("span", { class: "light amber", text: "ЗАДАНИЕ В ПРОЦЕССЕ" })
          : el("span", { class: "light", text: "МИССИЯ НА ФИНИШЕ" }),
      ),
    ),
  );
}

function showPatch() {
  const close = () => m.remove();
  const big = makePatch(); big.style.cssText = "width:min(300px,75vw);height:auto;display:block;margin:6px auto 14px";
  const crew = stages.some((s) => s.patchAddon) ? "Экипаж: командир и стажёр с полосатым хвостом." : "Экипаж: командир.";
  const m = el("div", { class: "modal", onclick: (e) => { if (e.target === m) close(); } },
    el("div", { class: "panel", style: "text-align:center" },
      el("div", { class: "modal-head" }, el("span", { class: "label amber", text: "НАШИВКА МИССИИ" }), el("button", { class: "x", type: "button", "aria-label": "Закрыть", text: "✕", onclick: close })),
      big, el("div", { class: "sub", text: `${entry.mission} · ${crew}` })));
  document.body.append(m);
}

function consoleScreen({ reveal = null, revealLocked = false } = {}) {
  const active = S.completed < stages.length ? stages.at(-1) : null; // этап, задание которого идёт сейчас
  // Следующий этап без кода открывается сам (в т.ч. если страницу закрыли посреди перехода).
  if (!active && nextRef()?.auto) return autoOpen(nextRef());
  const parts = [hud()];

  // Журнал: брифинг + пройденные этапы (кроме текущего)
  const journal = el("div", { class: "journal" });
  const brief = el("details", {}, el("summary", {}, el("span", { class: "n", text: "00" }), el("span", { class: "t", text: "Брифинг миссии" }), el("span", { class: "ok", text: "ПРИНЯТ" })));
  const bul = el("ul", { class: "tx" }); typeLines(bul, entry.briefing, { instant: true });
  brief.append(el("div", { class: "body" }, bul));
  journal.append(brief);
  (active ? stages.slice(0, -1) : stages).forEach((p) => {
    const d = el("details", {}, el("summary", {}, el("span", { class: "n", text: pad(p.n) }), el("span", { class: "t", text: p.title }), el("span", { class: "ok", text: p.dna && !p.dna.results ? "⧗" : "✔" })));
    const body = el("div", { class: "body" });
    d.append(body);
    d.addEventListener("toggle", () => { if (d.open && !body.childElementCount) stageBody(p, body, true); }, { once: false });
    journal.append(d);
  });
  parts.push(journal);

  // Текущий этап (пока задание не подтверждено как выполненное)
  const cur = active;
  if (cur) {
    const card = el("section", { class: "panel card" + (reveal === cur.key ? " reveal" : ""), id: "current" },
      el("div", { class: "card-head" }, el("span", { class: "label", text: cur.callsign || `ОБЪЕКТ ${pad(cur.n)}` }), el("span", { class: "status live", text: cur.status || "АКТИВЕН" })),
      el("h2", { text: cur.title }),
    );
    const body = el("div");
    card.append(body);
    parts.push(card);
    queueMicrotask(() => stageBody(cur, body, !!S.typed[cur.key]).then(() => { S.typed[cur.key] = true; save(); }));
  }

  // Следующий (засекреченный) этап — только после подтверждения текущего
  const next = active ? null : nextRef();
  let lockedEl = null;
  if (next) parts.push((lockedEl = lockedCard(next, stages.length + 1)));
  if (lockedEl && revealLocked) lockedEl.classList.add("reveal");

  parts.push(el("button", { class: "btn ghost block", type: "button", style: "margin-top:8px;font-size:12px", text: "ПЕРЕНЕСТИ ПРОГРЕСС НА ДРУГОЕ УСТРОЙСТВО", onclick: showSync }));
  const disc = disclaimerBox();
  if (disc) { disc.style.marginTop = "16px"; parts.push(disc); }

  screen(...parts);
  if (reveal) setTimeout(() => document.getElementById("current")?.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
  if (revealLocked && lockedEl) setTimeout(() => lockedEl.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
  tick();
}

/** Содержимое открытого этапа (общая часть для текущей карточки и журнала). */
async function stageBody(p, host, instant) {
  const isCurrent = !!host.closest("#current");
  // Шаг «получите у помощника…»: пока не подтверждён, остальное скрыто.
  if (p.gate && isCurrent && !S.gates?.[p.n]) {
    host.append(el("div", { class: "gate reveal" },
      el("span", { class: "label amber", text: "ДЕЙСТВИЕ КОМАНДИРА" }),
      el("p", { class: "gate-text", text: p.gate.text }),
      el("button", { class: "btn block", type: "button", text: p.gate.button, onclick: () => confirmHold({
        title: p.gate.confirmTitle || entry.confirm.title,
        text: p.gate.confirmText || p.gate.text,
        onConfirm: () => {
          S.gates = { ...(S.gates || {}), [p.n]: true }; S.times["g" + p.n] = Date.now(); save(); sfx.ok();
          host.replaceChildren();
          stageBody(p, host, false).then(() => { S.typed[p.key] = true; save(); });
        },
      }) })));
    return;
  }
  // Экран оформления (один раз, сразу после кода): шаги согласования и печать.
  if (p.loading && isCurrent && !S.loaded?.[p.n]) {
    await loadingSequence(p.loading, host);
    S.loaded = { ...(S.loaded || {}), [p.n]: true }; save();
    host.replaceChildren();
    instant = false;
  }
  const ul = el("ul", { class: "tx" });
  host.append(ul);
  const rest = el("div");
  host.append(rest);
  const typing = typeLines(ul, p.transmission, { instant });
  if (!instant) host.append(el("div", { class: "tap-skip", text: "нажмите на текст, чтобы допечатать" }));
  await typing;
  host.querySelector(".tap-skip")?.remove();

  for (const im of p.images || []) {
    rest.append(el("figure", { class: "stage-img reveal", onclick: () => showImage(im) },
      el("img", { src: im.src, alt: im.caption || "Снимок", loading: "lazy" }),
      im.caption ? el("figcaption", {}, im.caption, el("span", { text: " · нажмите, чтобы увеличить" })) : null));
  }
  if (p.outro?.length) rest.append(el("div", { class: "outro reveal" }, p.outro.map((l) => el("p", { text: l }))));
  if (p.photo && !isCurrent) {
    const slot = el("div");
    rest.append(slot);
    photoGet(p.key).then((src) => { if (src) slot.append(el("figure", { class: "stage-img" }, el("img", { src, alt: "Фотоотчёт" }), el("figcaption", { text: "Фотоотчёт, переданный в ЦУП" }))); });
  }

  if (p.location) {
    rest.append(el("div", { class: "loc reveal" },
      el("span", { class: "label", text: "КООРДИНАТЫ ОБЪЕКТА" }),
      el("span", { class: "name", text: p.location.name }),
      el("span", { class: "addr", text: p.location.address }),
      p.location.map ? el("a", { href: p.location.map, target: "_blank", rel: "noopener", text: "→ открыть на карте" }) : null));
  }
  if (p.dna) rest.append(dnaBox(p.dna));
  if (p.sky) {
    rest.append(el("div", { class: "bonus reveal" },
      el("span", { class: "label", text: "★ " + p.sky.bonusLabel }),
      el("h3", { text: p.sky.title }),
      el("button", { class: "btn block", type: "button", text: p.sky.openButton, onclick: () => openSkyChart(p.sky) })));
  }
  if (isCurrent && S.completed < p.n) {
    const photoPending = p.photo && !(p.photo.confirmAfter && S.photoDone?.[p.key]);
    if (photoPending) return photoTask(p, rest);
    if (p.photo) { // фото уже принято — показываем его и ждём подтверждения
      const slot = el("div"); rest.append(slot);
      photoGet(p.key).then((src) => { if (src) slot.append(el("figure", { class: "stage-img" }, el("img", { src, alt: "Фотоотчёт" }), el("figcaption", { text: p.photo.done }))); });
    }
    const C = entry.confirm;
    const isLast = !!p.finale;
    rest.append(el("div", { class: "actions reveal" },
      el("div", { class: "divider" }),
      el("button", { class: "btn block", type: "button", text: isLast ? p.finale.reportButton : p.completeButton || C.button, onclick: () =>
        confirmHold({
          title: C.title,
          text: (isLast ? C.finalText : C.text).replace("{title}", p.title),
          onConfirm: () => completeStage(p),
        }) })));
  }
}

/** Этап закрыт: финал, автоматический следующий этап или засекреченная карточка. */
function completeStage(p) {
  S.completed = p.n; S.times["c" + p.n] = Date.now();
  if (p.finale) { S.done = true; S.times.done = S.times.done || Date.now(); save(); sfx.unlock(); return finaleScreen(); }
  save(); sfx.ok();
  if (p.next?.auto) return autoOpen(p.next);
  consoleScreen({ revealLocked: true });
}

/** Этап без кода: «перехвачен новый сигнал» → расшифровка ключом из предыдущего этапа. */
let autoOpening = false;
async function autoOpen(next) {
  if (autoOpening) return;
  autoOpening = true;
  const ov = el("div", { class: "incoming", role: "status" }, el("div", { class: "incoming-box" },
    el("span", { class: "lamp" }), el("span", { text: "ПЕРЕХВАЧЕН НОВЫЙ СИГНАЛ" }), el("span", { class: "blink", text: "_" })));
  document.body.append(ov);
  sfx.noise(1);
  const [r] = await Promise.all([
    tryCode(next.auto, next.salt, DATA.blobs[next.id], next.id, true),
    staticNoise(ov, 1300),
  ]);
  ov.remove();
  autoOpening = false;
  if (!r) return consoleScreen(); // не должно случаться: ключ лежит в предыдущем этапе
  S.codes.push(r.code); S.times[stages.length + 1] = Date.now(); save();
  stages.push(r.payload);
  sfx.unlock();
  consoleScreen({ reveal: r.payload.key });
}

/** Экран оформления: шаги согласования с печатями, полоса прогресса, итоговый штамп. */
async function loadingSequence(L, host) {
  const bar = el("div", { class: "progress det" }, el("i"));
  const list = el("ul", { class: "scan-log loading-log" });
  const stamp = el("div", { class: "big-stamp", text: L.stamp || "ГОТОВО", hidden: true });
  const box = el("div", { class: "loading-box reveal" },
    el("div", { class: "loading-head" }, el("span", { class: "loading-spin", "aria-hidden": "true" }), el("span", { class: "label amber", text: L.title || "ОБРАБОТКА" })),
    bar, list, stamp);
  host.append(box);
  const fill = bar.firstChild;
  const steps = L.steps || [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const li = el("li", {}, el("span", { class: "scan-l", text: s.label }), el("span", { class: "scan-r dots", text: "…" }));
    list.append(li);
    sfx.key();
    await sleep(700 + Math.random() * 600);
    li.lastChild.className = "scan-r ok mini-stamp"; li.lastChild.textContent = s.ok;
    sfx.beep();
    fill.style.width = Math.round(((i + 1) / steps.length) * 100) + "%";
  }
  box.querySelector(".loading-spin").remove();
  stamp.hidden = false;
  sfx.unlock();
  await sleep(1800);
}

/** Фото-задание: снимок уменьшается на телефоне и хранится только на этом устройстве. */
function photoTask(p, rest) {
  const P = p.photo;
  const file = el("input", { type: "file", accept: "image/*", hidden: true });
  const pick = el("button", { class: "btn block", type: "button", text: "📷 " + P.button, onclick: () => file.click() });
  const img = el("img", { alt: "Ваш снимок" });
  const frame = el("div", { class: "scan-frame", hidden: true }, img, el("i", { class: "scan-line" }), el("i", { class: "scan-grid" }),
    el("span", { class: "scan-corner tl" }), el("span", { class: "scan-corner tr" }), el("span", { class: "scan-corner bl" }), el("span", { class: "scan-corner br" }));
  const send = el("button", { class: "btn block", type: "button", text: P.send, hidden: true });
  const log = el("ul", { class: "scan-log", hidden: true });
  const verdict = el("div", { class: "scan-verdict", hidden: true });
  const fb = el("div", { class: "feedback", role: "status" });
  let data = null;
  const resetResult = () => { log.hidden = true; log.replaceChildren(); verdict.hidden = true; frame.classList.remove("scanning", "fail", "pass"); };
  file.addEventListener("change", async () => {
    const f = file.files?.[0]; file.value = "";
    if (!f) return;
    fb.className = "feedback"; fb.textContent = "ОБРАБОТКА СНИМКА...";
    try {
      data = await shrinkImage(f, 1280, 0.82);
      img.src = data; frame.hidden = false; send.hidden = false; send.disabled = false;
      pick.className = "btn ghost block"; pick.textContent = "↺ " + P.retake;
      fb.textContent = "";
      resetResult();
    } catch {
      fb.className = "feedback err"; fb.textContent = "Не удалось прочитать снимок. Попробуйте другое фото.";
    }
  });

  // Игровой «анализ»: по снимку ничего не измеряется, строки и результат заданы в config.
  send.addEventListener("click", async () => {
    if (!data) return;
    const A = P.analysis || {};
    S.photoTries = { ...(S.photoTries || {}) };
    const attempt = (S.photoTries[p.key] || 0) + 1;
    S.photoTries[p.key] = attempt; save();
    const reject = attempt <= (A.rejectAttempts ?? 1);
    send.disabled = pick.disabled = true; send.hidden = true;
    resetResult(); log.hidden = false; frame.classList.add("scanning");
    fb.className = "feedback"; fb.textContent = "";
    sfx.noise(1.2);
    const fill = (s) => String(s).replace("{date}", new Date().toLocaleDateString("ru-RU"));
    const step = async (label, result, cls) => {
      const li = el("li", {}, el("span", { class: "scan-l", text: label }), el("span", { class: "scan-r dots", text: "…" }));
      log.append(li);
      await sleep(650 + Math.random() * 550);
      sfx.key();
      li.lastChild.className = "scan-r " + cls; li.lastChild.textContent = fill(result);
    };
    for (const s of A.steps || []) await step(s.label, reject && s.fail ? s.fail : s.ok, reject && s.fail ? "warn" : "ok");
    const fin = A.station || { label: "Идентификация станции", ok: "ИДЕНТИФИЦИРОВАНА", fail: "НЕ ИДЕНТИФИЦИРОВАНА" };
    await step(fin.label, reject ? fin.fail : fin.ok, reject ? "bad" : "ok");
    frame.classList.remove("scanning");
    if (reject) {
      frame.classList.add("fail");
      sfx.err();
      verdict.className = "scan-verdict bad"; verdict.hidden = false;
      verdict.replaceChildren(el("b", { text: "✖ " + (A.rejectTitle || "СТАНЦИЯ НЕ ИДЕНТИФИЦИРОВАНА") }), el("span", { text: A.rejectText || "" }));
      pick.disabled = false; pick.className = "btn block"; pick.textContent = "📷 " + (A.retry || P.retake);
      return;
    }
    frame.classList.add("pass");
    await photoPut(p.key, data);
    verdict.className = "scan-verdict ok"; verdict.hidden = false;
    verdict.replaceChildren(el("b", { text: "✔ " + (A.acceptTitle || "СНИМОК ПРИНЯТ") }), el("span", { text: P.done }));
    sfx.ok();
    if (P.confirmAfter) { // дальше — обычная кнопка «задание выполнено» с подтверждением
      S.photoDone = { ...(S.photoDone || {}), [p.key]: true }; save();
      pick.hidden = true;
      const C = entry.confirm;
      rest.append(el("div", { class: "actions reveal" },
        el("div", { class: "divider" }),
        el("button", { class: "btn block", type: "button", text: p.completeButton || C.button, onclick: () =>
          confirmHold({ title: C.title, text: C.text.replace("{title}", p.title), onConfirm: () => completeStage(p) }) })));
      return;
    }
    await sleep(2200);
    completeStage(p);
  });
  rest.append(el("div", { class: "photo-task reveal" },
    el("div", { class: "divider" }),
    el("span", { class: "label amber", text: "ЗАДАНИЕ КОМАНДИРУ" }),
    el("p", { class: "gate-text", text: P.text }),
    file, pick, frame, send, log, verdict, fb));
}

function shrinkImage(f, max, q) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(f);
    const im = new Image();
    im.onload = () => {
      const k = Math.min(1, max / Math.max(im.naturalWidth, im.naturalHeight));
      const c = document.createElement("canvas");
      c.width = Math.round(im.naturalWidth * k); c.height = Math.round(im.naturalHeight * k);
      c.getContext("2d").drawImage(im, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL("image/jpeg", q));
    };
    im.onerror = () => { URL.revokeObjectURL(url); reject(new Error("decode")); };
    im.src = url;
  });
}

// Фото храним в IndexedDB этого устройства (в localStorage не влезут).
async function photoPut(key, data) {
  try { const db = await idbOpen(); db.transaction("s", "readwrite").objectStore("s").put(data, "photo:" + key); }
  catch { /* хранилище недоступно — этап всё равно засчитан */ }
}
function photoGet(key) {
  return withTimeout((async () => {
    try {
      const db = await idbOpen();
      return await new Promise((res) => { const q = db.transaction("s").objectStore("s").get("photo:" + key); q.onsuccess = () => res(q.result || null); q.onerror = () => res(null); });
    } catch { return null; }
  })());
}
async function photosClear() {
  try {
    const db = await idbOpen();
    const st = db.transaction("s", "readwrite").objectStore("s");
    const q = st.getAllKeys();
    q.onsuccess = () => q.result.filter((k) => String(k).startsWith("photo:")).forEach((k) => st.delete(k));
  } catch { /* нечего чистить */ }
}

function showImage(im) {
  const close = () => m.remove();
  const m = el("div", { class: "modal img-modal", onclick: close },
    el("img", { src: im.src, alt: im.caption || "Снимок" }),
    im.caption ? el("div", { class: "sub", text: im.caption + " · нажмите, чтобы закрыть" }) : null);
  document.body.append(m);
}

/** Подтверждение удержанием: случайное касание не закроет этап. */
function confirmHold({ title, text, onConfirm, hold, cancel }) {
  const C = { hold: "УДЕРЖИВАЙТЕ ДЛЯ ПОДТВЕРЖДЕНИЯ", cancel: "ОТМЕНА", ...(entry?.confirm || {}), ...(hold ? { hold } : {}), ...(cancel ? { cancel } : {}) };
  const HOLD = 1600;
  const fill = el("i", { class: "hold-fill" });
  const lbl = el("span", { text: C.hold });
  const btn = el("button", { class: "btn block hold", type: "button" }, fill, lbl);
  let raf = 0, t0 = 0, fired = false;
  const step = () => {
    const k = (performance.now() - t0) / HOLD;
    fill.style.transform = `scaleX(${Math.min(1, k)})`;
    if (k >= 1) {
      fired = true; t0 = 0;
      lbl.textContent = "✔ ПОДТВЕРЖДЕНО";
      setTimeout(() => { m.remove(); onConfirm(); }, 350);
    } else raf = requestAnimationFrame(step);
  };
  const start = () => { if (fired || t0) return; t0 = performance.now(); sfx.beep(); raf = requestAnimationFrame(step); };
  const stop = () => { if (fired) return; cancelAnimationFrame(raf); t0 = 0; fill.style.transform = "scaleX(0)"; };
  btn.addEventListener("pointerdown", (e) => { e.preventDefault(); try { btn.setPointerCapture(e.pointerId); } catch { /* старый браузер */ } start(); });
  for (const ev of ["pointerup", "pointercancel", "lostpointercapture"]) btn.addEventListener(ev, stop);
  btn.addEventListener("keydown", (e) => { if ((e.key === " " || e.key === "Enter") && !e.repeat) { e.preventDefault(); start(); } });
  btn.addEventListener("keyup", (e) => { if (e.key === " " || e.key === "Enter") stop(); });
  btn.addEventListener("contextmenu", (e) => e.preventDefault());
  const close = () => { if (!fired) m.remove(); };
  const m = el("div", { class: "modal", onclick: (e) => { if (e.target === m) close(); } },
    el("div", { class: "panel" },
      el("div", { class: "modal-head" }, el("span", { class: "label amber", text: title }), el("button", { class: "x", type: "button", "aria-label": "Закрыть", text: "✕", onclick: close })),
      el("p", { text }),
      btn,
      el("div", { class: "hint-count", text: "Нажмите и держите кнопку, пока шкала не заполнится.", style: "margin:8px 0 12px;text-align:center" }),
      el("button", { class: "btn ghost block", type: "button", text: C.cancel, onclick: close })));
  document.body.append(m);
}

function dnaBox(dna) {
  const c = el("canvas");
  const box = el("div", { class: "dna-box reveal" }, c,
    el("div", {},
      el("div", { class: "dna-status" + (dna.results ? "" : " pulse"), text: dna.results ? "АНАЛИЗ ЗАВЕРШЁН" : dna.status }),
      dna.results ? null : el("div", { class: "progress" }, el("i")),
      el("div", { class: "hint-count", text: dna.note || "" }),
      dna.results ? el("ul", { class: "results" }, dna.results.map((r) => el("li", { text: r }))) : null));
  requestAnimationFrame(() => spiral(c));
  return box;
}

function lockedCard(next, n) {
  const t = next.teaser || { riddle: "", hints: [] };
  const used = () => Math.min(S.hints[n] || 0, t.hints.length);
  const hintsBox = el("div", { class: "hints" });
  const hintBtn = el("button", { class: "btn ghost block", type: "button" });
  const renderHints = () => {
    hintsBox.replaceChildren(...t.hints.slice(0, used()).map((h, i) => el("div", { class: "hint" }, el("span", { class: "label", text: `ЦУП · ПОДСКАЗКА ${i + 1}/${t.hints.length}` }), h)));
    const left = t.hints.length - used();
    hintBtn.textContent = left > 0 ? `ЗАПРОСИТЬ ПОДСКАЗКУ У ЦУП · ОСТАЛОСЬ ${left}` : "ЛИМИТ ПОДСКАЗОК ИСЧЕРПАН";
    hintBtn.disabled = left <= 0;
    hintBtn.hidden = t.hints.length === 0;
  };
  hintBtn.onclick = () => { S.hints[n] = used() + 1; save(); sfx.beep(); renderHints(); };

  const input = t.multiline
    ? el("textarea", { name: "code", rows: "3", autocomplete: "off", autocapitalize: "sentences", spellcheck: "false", enterkeyhint: "go", placeholder: t.placeholder || "ОТВЕТ", "aria-label": "Ответ", class: "long-answer" })
    : el("input", { name: "code", autocomplete: "off", autocapitalize: "characters", spellcheck: "false", enterkeyhint: "go", placeholder: t.placeholder || "КОД", "aria-label": "Код доступа" });
  if (t.multiline) input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); input.form.requestSubmit(); } });
  const btn = el("button", { class: "btn", type: "submit", text: "ВВОД" });
  const fb = el("div", { class: "feedback", role: "status" });
  const widths = [92, 78, 64, 84];

  const card = el("section", { class: "panel card locked" },
    el("div", { class: "card-head" }, el("span", { class: "label", text: `ОБЪЕКТ ${pad(n)} · ДОСТУП ОГРАНИЧЕН` }), el("span", { class: "status wait", text: "ОЖИДАНИЕ СИГНАЛА..." })),
    el("span", { class: "stamp", text: "ЗАСЕКРЕЧЕНО" }),
    el("div", { class: "redacted", "aria-hidden": "true" }, widths.map((w) => el("span", { style: `width:${w}%` }))),
    el("div", { class: "label", text: "ПЕРЕХВАЧЕННЫЙ ФРАГМЕНТ" }),
    el("p", { class: "riddle", text: t.riddle }),
    hintsBox, el("div", { style: "height:10px" }), hintBtn,
    el("div", { class: "divider" }),
    t.codeLabel ? el("div", { class: "code-call" }, t.codeLabel) : null,
    el("label", { class: "label", text: t.codeLabel ? "КОД ДОСТУПА" : "КОД ДОСТУПА · ВЫДАЁТСЯ НА МЕСТЕ" }),
    t.codeHint ? el("div", { class: "hint", style: "margin-top:8px" }, el("span", { class: "label", text: "ЦУП · ПОДСКАЗКА К КОДУ" }), t.codeHint) : null,
    el("div", { style: "height:8px" }),
    el("form", { class: "code-form" + (t.multiline ? " multi" : ""), onsubmit: async (e) => {
      e.preventDefault();
      const form = e.currentTarget;
      const v = input.value.trim();
      if (!v) return input.focus();
      btn.disabled = true; fb.className = "feedback"; fb.textContent = "ПРОВЕРКА КОДА...";
      const r = await tryCode(v, next.salt, DATA.blobs[next.id], next.id);
      btn.disabled = false;
      if (!r) {
        sfx.err();
        fb.className = "feedback err"; fb.textContent = t.wrong || "Код не распознан. Проверьте передачу и повторите.";
        form.classList.remove("shake"); void form.offsetWidth; form.classList.add("shake");
        return;
      }
      input.blur();
      fb.className = "feedback ok"; fb.textContent = "✔ КОД ПРИНЯТ";
      S.codes.push(r.code); S.times[n] = Date.now(); save();
      await unlockAnimation(card);
      stages.push(r.payload);
      consoleScreen({ reveal: r.payload.key });
    } }, input, btn),
    fb,
  );
  renderHints();
  return card;
}

async function unlockAnimation(card) {
  sfx.noise(0.9);
  card.classList.add("unlocking");
  card.append(el("div", { class: "declass", text: "РАССЕКРЕЧЕНО" }));
  await staticNoise(card, 1000);
  sfx.unlock();
  await sleep(350);
}

// ================================================================ 4. финал
async function finaleScreen() {
  const last = stages.at(-1);
  const F = last.finale;
  const patch = makePatch();
  const rows = stages.map((p) => el("tr", {},
    el("td", { text: S.times[p.n] ? hm(S.times[p.n]) : "—" }),
    el("td", { text: p.title }),
    el("td", { text: p.dna && !p.dna.results ? "⧗ АНАЛИЗ" : "✔ ВЫПОЛНЕНО" })));
  const incidents = (S.sec?.away || 0) + (S.sec?.copy || 0);
  const SC = DATA.pub.security;
  if (SC && incidents) rows.push(el("tr", { class: "incident" },
    el("td", { text: "⚠" }), el("td", { text: SC.journal }), el("td", { text: `ЗАФИКСИРОВАНО ×${incidents}` })));
  const msg = el("ul", { class: "tx message" });
  const skyStage = stages.find((s) => s.sky);
  // Фотоотчёт: снимки, переданные в фото-заданиях
  const photoPanel = el("div", { class: "panel", hidden: true }, el("div", { class: "label", text: "ФОТООТЧЁТ МИССИИ" }));
  for (const p of stages.filter((s) => s.photo)) {
    photoGet(p.key).then((src) => {
      if (!src) return;
      photoPanel.hidden = false;
      photoPanel.append(el("figure", { class: "stage-img" }, el("img", { src, alt: p.title }), el("figcaption", { text: p.title })));
    });
  }
  const dur = S.times.start && S.times.done ? S.times.done - S.times.start : 0;

  screen(el("section", { class: "finale" },
    el("div", { class: "panel finale-hero reveal" },
      patch,
      el("h1", { text: F.title }),
      el("div", { class: "sub", text: `КОМАНДИР ${String(entry.commander).toUpperCase()} · ${entry.mission}` + (dur ? ` · ВРЕМЯ МИССИИ ${Math.floor(dur / 3600e3)} Ч ${Math.floor((dur % 3600e3) / 60e3)} МИН` : "") })),
    el("div", { class: "panel" },
      el("div", { class: "label amber", text: F.messageTitle }),
      el("div", { style: "height:12px" }), msg),
    el("div", { class: "panel" },
      el("div", { class: "label", text: F.journalTitle }),
      el("table", { class: "log" }, el("tbody", {}, rows))),
    F.dna?.length ? el("div", { class: "panel" },
      el("div", { class: "label", text: F.dnaTitle }),
      F.dna.map((d) => dnaBox(d))) : null,
    photoPanel,
    el("div", { class: "actions", style: "display:grid;gap:10px" },
      skyStage ? el("button", { class: "btn block", type: "button", text: skyStage.sky.openButton, onclick: () => openSkyChart(skyStage.sky) }) : null,
      el("button", { class: "btn ghost block", type: "button", text: "ОТКРЫТЬ КОНСОЛЬ ЦУП", onclick: () => consoleScreen() })),
  ));
  await typeLines(msg, F.message, { instant: S.typed.finale, speed: 30 });
  S.typed.finale = true; save();
}

// ================================================================ звёздное небо
async function openSkyChart(sky) {
  sfx.beep();
  // 3D-небо (WebGL); если не поддерживается или не запустилось — плоская карта
  try {
    const m3 = await import("./sky3d.js");
    if (m3.webglOK()) return await m3.openSky3D(sky, { el, sfx, typeLines });
  } catch (e) { console.warn("3D-небо недоступно:", e); document.querySelector(".sky3d")?.remove(); }
  const mod = await import("./sky.js");
  mod.openSky(sky, { el, sfx, typeLines });
}

// ================================================================ сброс прогресса (для тестов)
function renderResetButton() {
  if (!DATA?.pub?.resetButton || document.getElementById("reset")) return;
  const b = el("button", { id: "reset", class: "corner-btn left", type: "button", title: "Сбросить прогресс", text: "↺ СБРОС", onclick: () =>
    confirmHold({
      title: "СБРОС ПРОГРЕССА",
      text: "Весь прогресс на этом устройстве будет стёрт: вход, открытые этапы, подсказки и подтверждения. Сайт начнётся с экрана сигнала.",
      hold: "УДЕРЖИВАЙТЕ, ЧТОБЫ СБРОСИТЬ",
      cancel: "ОТМЕНА",
      onConfirm: () => {
        S = { ...freshState(), device: S.device };
        photosClear();
        syncSound();
        save(); // новая ревизия перекрывает обе сохранённые копии
        entry = null; stages = [];
        document.querySelectorAll(".modal, .sky-overlay").forEach((m) => m.remove());
        document.body.style.overflow = "";
        sfx.err();
        boot();
      },
    }) });
  document.body.append(b);
}

// ================================================================ перенос прогресса
function showSync() {
  sfx.beep();
  const url = `${location.origin}${location.pathname}#sync=${[S.pw, ...S.codes].join(".")}&c=${S.completed}`;
  const fb = el("div", { class: "feedback ok", role: "status" });
  const close = () => m.remove();
  const copy = async () => {
    try {
      if (navigator.share) await navigator.share({ title: "ЦУП · BD-0712", url });
      else { await navigator.clipboard.writeText(url); fb.textContent = "✔ Ссылка скопирована"; }
    } catch { /* отменено */ }
  };
  const m = el("div", { class: "modal", onclick: (e) => { if (e.target === m) close(); } },
    el("div", { class: "panel" },
      el("div", { class: "modal-head" }, el("span", { class: "label amber", text: "КАНАЛ СИНХРОНИЗАЦИИ" }), el("button", { class: "x", type: "button", "aria-label": "Закрыть", text: "✕", onclick: close })),
      el("p", { text: "Откройте эту ссылку на другом устройстве (телефоне или ноутбуке): весь пройденный маршрут перенесётся туда." }),
      el("input", { readonly: true, value: url, style: "width:100%;min-height:44px;padding:8px 10px;border-radius:8px;background:rgba(0,0,0,.45);border:1px solid var(--line-strong);color:var(--green);font-size:12px", onfocus: (e) => e.target.select() }),
      el("div", { style: "height:10px" }),
      el("button", { class: "btn block", type: "button", text: navigator.share ? "ОТПРАВИТЬ ССЫЛКУ" : "СКОПИРОВАТЬ ССЫЛКУ", onclick: copy }),
      fb));
  document.body.append(m);
}

// ================================================================ отладка
function renderDebug() {
  document.querySelector(".debug")?.remove();
  const total = debug.codes.length;
  const jump = (k, done = false) => {
    S = { ...freshState(), sound: S.sound, pw: debug.pw, accepted: k >= 0, codes: debug.codes.slice(0, Math.max(0, k)), completed: done ? k : Math.max(0, k - 1), done };
    const now = Date.now();
    S.times.start = now - 8 * 3600e3;
    for (let i = 1; i <= Math.max(0, k); i++) S.times[i] = now - (total - i + 1) * 3600e3;
    if (done) S.times.done = now;
    save(); boot();
  };
  const b = (label, fn) => el("button", { type: "button", text: label, onclick: fn });
  const panel = el("details", { class: "debug" },
    el("summary", { text: "DEBUG" }),
    el("div", { class: "row" },
      b("Сброс", () => { S = freshState(); save(); boot(); }),
      b("Брифинг", () => { S = { ...freshState(), sound: S.sound, pw: debug.pw }; save(); boot(); }),
      b("0 этапов", () => jump(0)),
      ...debug.codes.map((_, i) => b(`до ${i + 1}`, () => jump(i + 1))),
      b("Финал", () => jump(total, true))),
    el("div", { class: "row" }, b("Без печати", () => { S.typed = new Proxy({}, { get: () => true }); boot(); }), b("Коды", () => alert(debug.codes.join(" · ")))),
  );
  document.body.append(panel);
}

// ================================================================ протокол безопасности («детектор AI»)
// Сайт не видит, что открыто рядом. Он видит только: (1) что вкладку свернули
// или переключились в другое приложение и на сколько; (2) копирование текста.
// Работает лишь на экранах с загадками: сигнал на входе и засекреченный объект.
const AWAY_KEY = "bd0712.away";
let awaySince = 0;
const puzzleActive = () => !!DATA?.pub?.security && (onSignal || !!document.querySelector("#app .card.locked"));

function goneAway() {
  if (awaySince || !puzzleActive()) return;
  awaySince = Date.now();
  try { sessionStorage.setItem(AWAY_KEY, String(awaySince)); } catch { /* приватный режим */ }
}
function cameBack() {
  if (!awaySince || document.visibilityState !== "visible") return;
  const sec = Math.round((Date.now() - awaySince) / 1000);
  awaySince = 0;
  try { sessionStorage.removeItem(AWAY_KEY); } catch { /* приватный режим */ }
  const C = DATA?.pub?.security;
  if (C && sec >= C.awayAfter && sec <= C.awayMax && puzzleActive()) securityAlarm("away", sec);
}
function checkAwayAfterReload() {
  let t = 0;
  try { t = Number(sessionStorage.getItem(AWAY_KEY)) || 0; } catch { /* нет хранилища */ }
  if (t && !awaySince) { awaySince = t; cameBack(); }
}
document.addEventListener("visibilitychange", () => (document.hidden ? goneAway() : cameBack()));
addEventListener("blur", goneAway);
addEventListener("focus", cameBack);
addEventListener("pagehide", goneAway);

document.addEventListener("copy", (e) => {
  const C = DATA?.pub?.security;
  if (!C || !puzzleActive()) return;
  if (e.target.closest?.("input, textarea, .modal")) return; // поле ввода и ссылка переноса — можно
  e.preventDefault();
  try { e.clipboardData.setData("text/plain", C.clipboard); } catch { /* старый браузер */ }
  securityAlarm("copy");
});

const plural = (n, [one, few, many]) => {
  const a = n % 10, b = n % 100;
  return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many;
};
function awayTime(sec) {
  const s = sec % 60, m = Math.floor(sec / 60);
  const ss = `${s} ${plural(s, ["секунда", "секунды", "секунд"])}`;
  return m ? `${m} ${plural(m, ["минута", "минуты", "минут"])}${s ? " " + ss : ""}` : ss;
}

function securityAlarm(kind, sec = 0) {
  const C = DATA.pub.security;
  S.sec = { away: 0, copy: 0, ...(S.sec || {}) };
  S.sec[kind]++; save();
  if (document.querySelector(".alarm")) return; // одна тревога за раз
  const n = S.sec.away + S.sec.copy;
  const text = kind === "away" ? C.awayText.replace("{time}", awayTime(sec)) : C.copyText;
  sfx.alarm();
  const close = () => m.remove();
  const m = el("div", { class: "modal alarm", role: "alertdialog", "aria-label": C.title },
    el("div", { class: "panel alarm-box" },
      el("div", { class: "alarm-lamp", "aria-hidden": "true" }),
      el("span", { class: "label", text: C.title }),
      el("p", { class: "alarm-text", text }),
      el("div", { class: "hint-count", text: C.note.replace("{n}", n) }),
      el("button", { class: "btn block", type: "button", text: C.button, onclick: close })));
  document.body.append(m);
}

// ================================================================ часы, звук, сеть
function tick() {
  const now = new Date();
  const t = `${pad(now.getDate())}.${pad(now.getMonth() + 1)} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  let tp = "";
  if (S.times.start) {
    const d = Math.max(0, Math.floor((now - S.times.start) / 1000));
    tp = ` · T+${pad(Math.floor(d / 3600))}:${pad(Math.floor((d % 3600) / 60))}:${pad(d % 60)}`;
  }
  document.querySelectorAll("[data-clock]").forEach((c) => (c.textContent = t + tp));
}
setInterval(tick, 1000);
for (const ev of ["online", "offline"]) addEventListener(ev, () => document.querySelectorAll("[data-net]").forEach((n) => {
  n.className = "light" + (navigator.onLine ? "" : " amber");
  n.textContent = navigator.onLine ? "СВЯЗЬ" : "АВТОНОМНО";
}));

const soundBtn = document.getElementById("sound");
function syncSound() {
  soundBtn.setAttribute("aria-pressed", String(S.sound));
  soundBtn.querySelector(".lbl").textContent = S.sound ? "ЗВУК: ВКЛ" : "ЗВУК: ВЫКЛ";
}
soundBtn.addEventListener("click", () => {
  S.sound = !S.sound; save(); setSound(S.sound); syncSound(); sfx.beep();
  if (S.sound && onSignal && !entry) { startAmbience(); document.querySelector(".tune-in")?.remove(); }
});
syncSound();
// Браузеры не дают включить звук без жеста — при любом касании или нажатии клавиши
// поднимаем аудио (звук включён по умолчанию) и запускаем фон экрана сигнала.
const wake = () => {
  if (!S.sound || audioRunning()) return;
  setSound(true);
  startAmbience();
};
addEventListener("pointerdown", wake);
addEventListener("keydown", wake);

// ================================================================ start
cosmos(document.getElementById("stars"));
if ("serviceWorker" in navigator && (location.protocol === "https:" || new URLSearchParams(location.search).has("sw"))) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
boot();
