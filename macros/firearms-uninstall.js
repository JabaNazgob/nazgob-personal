// Анимации огнестрела — тестовый макрос СНЯТИЯ всего, что поставил firearms-install.js.
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
