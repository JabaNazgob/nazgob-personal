// Собирает тестовые Script-макросы из ядер модуля.
//   node tools/build-macro.mjs          — записать macros/*.js
//   node tools/build-macro.mjs --check  — проверить, что макросы не устарели
import { readFile, writeFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const corePath = new URL("scripts/one-whole-v0.2.0.js", root);
const macroPath = new URL("macros/one-whole-test.js", root);
const firearmCorePath = new URL("scripts/firearm-animations-v0.2.0.js", root);

export async function buildMacro() {
  const core = (await readFile(corePath, "utf8")).replace(/^export /gm, "");
  return `// «Одно целое» — тестовый макрос вместо модуля nazgob-personal.
// СГЕНЕРИРОВАН из scripts/one-whole-v0.2.0.js командой: node tools/build-macro.mjs
// Не правьте код ниже настроек вручную — правьте ядро и пересоберите макрос.
//
// Как пользоваться:
// 1. Выключите модуль nazgob-personal и перезагрузите мир.
// 2. Создайте макрос типа Script, вставьте этот файл, укажите настройки ниже.
// 3. Запустите макрос. ГМ не нужен: достаточно прав владельца (Owner) на
//    Actor наездника и скакуна. Механика работает до перезагрузки страницы,
//    повторный запуск переустанавливает её (например, после правки настроек).
//    Пишет в документы именно этот клиент — запускайте макрос только в одном окне.
// Ограничения режима макроса: хуки есть только у клиента, где запущен макрос.
// Остальные не увидят скрытия картинки наездника. Пока этот клиент закрыт,
// хиты пары не синхронизируются.
// Консоль: NazgobOneWhole.pair() / .unpair() / .resync() / .isPaired() / .uninstall()

// ======================== Настройки ========================
const RIDER_UUID = "Actor.mOmeXQtCSMIDWYYl";
const MOUNT_UUID = "Actor.F4SsuskhKj3OA2f2";
const MOUNTED_IMAGE = "assets/Characters/%D0%9F%D0%B5%D1%80%D1%81%D0%BE%D0%BD%D0%B0%D0%B6%D0%B8%20%D0%B8%D0%B3%D1%80%D0%BE%D0%BA%D0%BE%D0%B2/%D0%92%D0%B8%D0%BA%D1%82%D0%BE%D1%80%20%D0%BD%D0%B0%20%D0%96%D0%BE%D1%80%D0%B8%D0%BA%D0%B5.webp"; // путь к изображению пары, например "worlds/мир/assets/mounted.webp"
const MOUNTED_SCALE = 1;
const DEBUG = true; // подробный журнал в консоли (F12) с префиксом [nazgob-personal]
// ===========================================================

if (game.modules.get("nazgob-personal")?.active) {
  ui.notifications.warn("Одно целое: модуль nazgob-personal включён — макрос не нужен. Выключите модуль, чтобы тестировать макрос.");
  return;
}
globalThis.NazgobOneWhole?.uninstall?.();

${core}
globalThis.NazgobOneWhole = installOneWhole({
  riderUuid: RIDER_UUID,
  mountUuid: MOUNT_UUID,
  mountedImage: MOUNTED_IMAGE,
  mountedScale: MOUNTED_SCALE,
  authority: "self",
  debug: DEBUG
});
ui.notifications.info(\`Одно целое: механика установлена из макроса (пара \${NazgobOneWhole.isPaired() ? "объединена" : "разделена"}).\`);
`;
}

const FIREARMS_INSTALL_HEADER = `// Анимации огнестрела — тестовый макрос УСТАНОВКИ вместо модуля nazgob-personal.
// СГЕНЕРИРОВАН из scripts/firearm-animations-v0.2.0.js командой: node tools/build-macro.mjs
// Не правьте код ниже настроек вручную — правьте ядро и пересоберите макрос.
//
// Заменяет on-use макросы «Выстрел DIME» и «Перезарядить DIME» — уберите их с
// оружия, иначе анимации будут двойными. Ставит:
// - выстрел — хук Midi AttackRollComplete; следом клин при осечке, у винтовок
//   (без клина) — затвор с гильзой, у примитивного оружия — облако дыма;
// - звук смены магазина — после перезарядки ребреей.
// Звуки (musket-shot.wav, reload-rifle.mp3 и др.) лежат в "assets/audio/sound/item sound".
//
// Как пользоваться:
// 1. Макрос типа Script (или вставьте весь текст в консоль F12 — он в обёртке).
// 2. Запустите. Повторный запуск переустанавливает всё, например после правки
//    SHOT_OVERRIDES. Снять без перезагрузки — макрос firearms-uninstall.js.
// Работает только у этого клиента: анимация играет, когда стреляет/перезаряжает
// ЭТОТ клиент (Sequencer сам показывает её остальным). Нужны Midi-QOL,
// Sequencer, JB2A, PSFX и ребрея.
// Консоль: NazgobFirearms.play("vintovka", token, [...game.user.targets], { jammed: false })
//          NazgobFirearms.playReload("vintovka", token, "magazine")
//          NazgobFirearms.profile("arkebuza") / .overrides / .uninstall()
`;

export async function buildFirearmsInstallMacro() {
  const core = (await readFile(firearmCorePath, "utf8"))
    .replace(/^import \{ MODULE_ID \} from .*$/m, `const MODULE_ID = "nazgob-personal";`)
    .replace(/^export /gm, "");
  if (/^import /m.test(core)) throw new Error("В ядре огнестрела появился новый import — макрос его не увидит");
  const indent = text => text.replace(/^(?=.)/gm, "  ");
  return `${FIREARMS_INSTALL_HEADER}
(async () => {
  // ======================== Настройки ========================
  const DEBUG = true; // журнал решений в консоли (F12) с префиксом [nazgob-personal] Огнестрел
  // Правки профилей, ключ — gearId из ребреи (revol-ver, karabin, vintovka,
  // tyazhelaya-vintovka, arkebuza, mushket). Сливаются по ключам с профилем,
  // null выключает слой. Разделы: shot (sound, muzzleFlash, smoke, bullet,
  // impact, cloud), jam (sound, smoke), afterShot (delayMin, delayMax, sound,
  // casing, casingSound), reload.magazine (sound). Пример:
  //   arkebuza: { shot: { sound: { file: "путь/к/выстрелу.ogg", volume: 0.9 } } }
  const SHOT_OVERRIDES = {
  };
  // ===========================================================

  const module = game.modules.get("nazgob-personal");
  if (module?.active && module.api?.isFeatureEnabled?.("firearmAnimations") !== false) {
    ui.notifications.warn("Огнестрел: в модуле nazgob-personal анимации уже включены. Выключите модуль или флажок «Анимации огнестрела».");
    return;
  }
  if (!game.modules.get("sequencer")?.active) ui.notifications.warn("Огнестрел: модуль Sequencer не включён — анимаций не будет.");
  if (!game.modules.get("psfx")?.active) ui.notifications.warn("Огнестрел: модуль PSFX не включён — не будет звука выстрела.");
  if (!game.modules.get("rebreya-main")?.active) ui.notifications.warn("Огнестрел: модуль rebreya-main не включён — огнестрел не распознается.");
  globalThis.NazgobFirearms?.uninstall?.();

${indent(core)}
  globalThis.NazgobFirearms = installFirearmAnimations({ overrides: SHOT_OVERRIDES, debug: DEBUG });
  ui.notifications.info(\`Огнестрел: анимации установлены (профили: \${Object.keys(FIREARM_TYPES).join(", ")}).\`);
})();
`;
}

export function buildFirearmsUninstallMacro() {
  return `// Анимации огнестрела — тестовый макрос СНЯТИЯ всего, что поставил firearms-install.js.
// СГЕНЕРИРОВАН командой: node tools/build-macro.mjs
// Макрос типа Script или вставка в консоль F12. Перезагрузка не нужна.
(() => {
  if (!globalThis.NazgobFirearms) {
    ui.notifications.info("Огнестрел: анимации не установлены.");
    return;
  }
  globalThis.NazgobFirearms.uninstall();
  delete globalThis.NazgobFirearms;
  ui.notifications.info("Огнестрел: анимации сняты.");
})();
`;
}

/** Все макросы: путь → содержимое. */
export async function buildMacros() {
  return new Map([
    ["macros/one-whole-test.js", await buildMacro()],
    ["macros/firearms-install.js", await buildFirearmsInstallMacro()],
    ["macros/firearms-uninstall.js", buildFirearmsUninstallMacro()]
  ]);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replaceAll("\\", "/").split("/").pop())) {
  const check = process.argv.includes("--check");
  let stale = false;
  for (const [path, macro] of await buildMacros()) {
    const url = new URL(path, root);
    if (check) {
      const current = await readFile(url, "utf8").catch(() => "");
      if (current !== macro) {
        console.error(`${path} устарел: выполните node tools/build-macro.mjs`);
        stale = true;
      } else {
        console.log(`${path} актуален`);
      }
    } else {
      await writeFile(url, macro);
      console.log(`Записан ${path}`);
    }
  }
  if (stale) process.exit(1);
}
