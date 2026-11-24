// Нормализация кодов: регистр, пробелы, кириллица в любой раскладке.
// Используется и сборщиком (канонический код), и сайтом (варианты ввода).

const TRANSLIT = {
  А: "A", Б: "B", В: "V", Г: "G", Ґ: "G", Д: "D", Е: "E", Ё: "E", Є: "YE",
  Ж: "ZH", З: "Z", И: "I", І: "I", Ї: "YI", Й: "Y", К: "K", Л: "L", М: "M",
  Н: "N", О: "O", П: "P", Р: "R", С: "S", Т: "T", У: "U", Ф: "F", Х: "H",
  Ц: "TS", Ч: "CH", Ш: "SH", Щ: "SCH", Ъ: "", Ы: "Y", Ь: "", Э: "E", Ю: "YU",
  Я: "YA",
};

// Кириллические буквы, которые выглядят как латинские (на случай, если код
// прочитали с бумажки и набрали «похожими» буквами в русской раскладке).
const LOOKALIKE = {
  А: "A", В: "B", Е: "E", К: "K", М: "M", Н: "H", О: "O", Р: "P", С: "C",
  Т: "T", У: "Y", Х: "X", І: "I",
};

function clean(s) {
  return String(s || "")
    .toUpperCase()
    .replace(/[\s\-_.,·:;'"«»!?]/g, "");
}

function mapWith(s, table) {
  let out = "";
  for (const ch of s) out += ch in table ? table[ch] : ch in TRANSLIT ? TRANSLIT[ch] : ch;
  return out;
}

/** Канонический вид кода (как его хранит сборщик). */
export function canonical(s) {
  return mapWith(clean(s), TRANSLIT);
}

/** Все разумные варианты прочтения ввода — проверяются по очереди. */
export function candidates(s) {
  const c = clean(s);
  const list = [mapWith(c, TRANSLIT), mapWith(c, LOOKALIKE)];
  // 0 ↔ O — частая путаница при наборе.
  list.push(list[0].replace(/0/g, "O"));
  return [...new Set(list)].filter(Boolean);
}
