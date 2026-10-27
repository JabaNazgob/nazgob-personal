// Включение и выключение функций модуля.
//
// Каждая функция — флажок в настройках модуля. Обработчики хуков проверяют
// isFeatureEnabled() в начале, поэтому перезагрузка после переключения не нужна.
// Функции с постоянными данными (эффекты, флаги) слушают FEATURE_TOGGLED_HOOK и
// приводят их в порядок сами.

export const MODULE_ID = "nazgob-personal";
export const FEATURE_TOGGLED_HOOK = `${MODULE_ID}.featureToggled`;

/** Порядок здесь — порядок флажков в настройках модуля. */
export const FEATURES = Object.freeze([
  {
    id: "oneWhole",
    name: "«Одно целое»",
    hint: "Общие хиты наездника и скакуна, посадка перетаскиванием, изображение пары. Без неё не работают досягаемость, «Угроза малым», ауры верхом и max-heal пары. Выключение не разрывает пару: при включении хиты пересчитываются."
  },
  {
    id: "mountedReach",
    name: "Досягаемость от скакуна",
    hint: "Рукопашные атаки наездника верхом считают дальность от всего токена скакуна (эффект Midi-QOL rangeOverride)."
  },
  {
    id: "smallThreat",
    name: "«Угроза малым»",
    hint: "Преимущество на рукопашную атаку верхом по цели меньше скакуна."
  },
  {
    id: "mountedAuras",
    name: "Ауры верхом",
    hint: "Ауры наездника (Aura Effects 1.x) считаются от токена скакуна."
  },
  {
    id: "mountedWeapons",
    name: "Верховое оружие",
    hint: "Свойства оружия Ребреи «Верховой бой» (lchMounted: +2 урона по цели меньше скакуна) и «Наскок» (lchDash: доп. урон после прямого разбега от 10 футов)."
  },
  {
    id: "woundClosure",
    name: "Медальон затягивающихся ран",
    hint: "Удваивает лечение от Костей хитов, если медальон экипирован."
  },
  {
    id: "hitDieMaxHeal",
    name: "Max-heal для Костей хитов",
    hint: "Флаг Midi-QOL flags.midi-qol.grants.max.damage.heal максимизирует и броски Костей хитов."
  },
  {
    id: "mixedMaxHealing",
    name: "Max-heal при лечении пары",
    hint: "Исправляет общее лечение наездника и скакуна, когда max-heal есть только у одного из них."
  },
  {
    id: "firearmAnimations",
    name: "Анимации огнестрела",
    hint: "Выстрел, попадание, осечка и звук для огнестрела Ребреи (тип по gearId предмета, нужен Sequencer). Профили — в scripts/firearm-animations-v0.2.0.js."
  }
]);

const settingKey = id => `feature-${id}`;

export function registerFeatureSettings() {
  for (const feature of FEATURES) {
    game.settings.register(MODULE_ID, settingKey(feature.id), {
      name: `Функция: ${feature.name}`,
      hint: feature.hint,
      scope: "world",
      config: true,
      type: Boolean,
      default: feature.default ?? true,
      onChange: enabled => Hooks.callAll(FEATURE_TOGGLED_HOOK, feature.id, enabled)
    });
  }
}

export function isFeatureEnabled(id) {
  try {
    return game.settings.get(MODULE_ID, settingKey(id)) !== false;
  } catch {
    // Настройка ещё не зарегистрирована (до init) — считаем функцию выключенной.
    return false;
  }
}
