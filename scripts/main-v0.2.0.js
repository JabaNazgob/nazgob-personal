// Точка входа модуля: флажки функций, верховые механики, анимации огнестрела.
import { FEATURES, MODULE_ID, isFeatureEnabled, registerFeatureSettings } from "./features-v0.2.0.js";
import { mountedCombatApi, registerMountedCombat } from "./mounted-combat-v0.2.0.js";
import { installFirearmAnimations } from "./firearm-animations-v0.2.0.js";

// Флажки регистрируются первыми, чтобы стоять в начале настроек модуля.
Hooks.once("init", registerFeatureSettings);
registerMountedCombat();
const firearms = installFirearmAnimations({ isEnabled: () => isFeatureEnabled("firearmAnimations") });

Hooks.once("ready", () => {
  const api = {
    MODULE_ID,
    features: FEATURES.map(feature => feature.id),
    isFeatureEnabled,
    firearms
  };
  // Геттер oneWhole переносится как есть: механика ставится в том же ready.
  Object.defineProperties(api, Object.getOwnPropertyDescriptors(mountedCombatApi));
  game.modules.get(MODULE_ID).api = api;
  // Старое имя из README и консольных команд.
  globalThis.NazgobMountedCombat = api;
});
