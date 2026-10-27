// Анимации огнестрела — тестовый макрос УСТАНОВКИ вместо модуля nazgob-personal.
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

  // Анимации и звуки огнестрела через Sequencer.
  //
  // Всё берётся из данных Ребреи (модуль rebreya-main), без разбора названий:
  // - огнестрел — system.type.value "firearmPrimitive"/"firearmAdvanced" или
  //   флаг firearmClass, как в isFirearmItem() ребреи;
  // - тип оружия — flags.rebreya-main.gearId (id предмета в data/gear.json);
  // - осечку бросает сама ребрея в dnd5e.postRollAttack и сразу ставит
  //   flags.rebreya-main.firearmJammed. Атака при этом проходит (оружие клинит
  //   после выстрела), поэтому играется выстрел, а следом — клин;
  // - перезарядку ребрея выполняет сама в preUseActivity и отменяет
  //   использование активности, так что хуков Midi у неё нет. Анимация
  //   срабатывает по результату её метода reloadFirearm
  //   (game.rebreyaMain.combatAttackService), если реально заряжен хотя бы один
  //   патрон; вид перезарядки — из свойства «Перезарядка» оружия.
  //   Очистка затвора анимации не имеет.
  //
  // Выстрел проигрывает клиент, который делает бросок атаки (хук Midi-QOL
  // AttackRollComplete — попадания и осечка к этому моменту уже известны).
  // Sequencer сам рассылает анимацию остальным клиентам.
  //
  // Слои и числа выстрела, клина и затвора взяты из макросов «Выстрел DIME» и
  // «Перезарядить DIME». Профиль — FIREARM_TYPES[gearId].profile; правки из
  // макроса накладываются поверх по ключам, null выключает слой.
  // Файлы — ключи базы Sequencer (JB2A, PSFX) или пути к файлам.
  //
  // Этот файл — единственный источник механики. Модуль импортирует его, а
  // tools/build-macro.mjs собирает из него тестовые макросы (без import/export).
  // Поэтому импорт здесь один (MODULE_ID), а хуки ставит installFirearmAnimations().

  const MODULE_ID = "nazgob-personal";

  const REBREYA_ID = "rebreya-main";
  const REBREYA_FIREARM_WEAPON_TYPES = new Set(["firearmPrimitive", "firearmAdvanced"]);
  const SOUND_DIR = "assets/audio/sound/item sound";

  const isPlainObject = value => Boolean(value) && typeof value === "object" && !Array.isArray(value);

  /** Наложение правок: объекты сливаются по ключам, остальное (массивы, null) заменяет. */
  function mergeProfile(base, ...patches) {
    const result = structuredClone(base);
    for (const patch of patches) {
      if (!isPlainObject(patch)) continue;
      for (const [key, value] of Object.entries(patch)) {
        result[key] = isPlainObject(value) && isPlainObject(result[key])
          ? mergeProfile(result[key], value)
          : structuredClone(value);
      }
    }
    return result;
  }

  // Затвор и выброс гильзы.
  const BOLT_CYCLE = {
    sound: { file: `${SOUND_DIR}/bolt.ogg`, volume: 0.85 },
    casing: {
      ejectDelay: 260,
      flight: 480,
      width: 0.12,
      height: 0.035,
      radius: 0.01,
      fillColor: "#C99A42",
      lineColor: "#4A3416",
      lineSize: 1
    },
    casingSound: {
      files: [1, 2, 3, 4, 5].map(index => `${SOUND_DIR}/casing${index}.ogg`),
      volume: 0.6
    }
  };

  const ADVANCED_SHOT = {
    sound: { file: "psfx.ranged-weapons.guns.single-fire.revolver", volume: 0.85 },
    // Размеры — в клетках сетки, как .size(..., { gridUnits: true }).
    muzzleFlash: { file: "jb2a.explosion_side.01.orange.0", width: 0.65, height: 0.32, playbackRate: 2.5, opacity: 0.95 },
    smoke: { file: "jb2a.smoke.puff.side.grey.0", width: 0.7, height: 0.45, playbackRate: 1.25, opacity: 0.65 },
    bullet: { file: "jb2a.bullet.01.orange", playbackRate: 1.5 },
    // scale — доля размера цели (.scaleToObject).
    impact: { file: "jb2a.impact.012.orange", delay: 90, scale: 0.35, playbackRate: 1.4 },
    /** Облако дыма на стрелке (у примитивного оружия). */
    cloud: null,
    /** Пауза между выстрелами по нескольким целям, мс. */
    targetInterval: 150
  };

  const JAM = {
    /** Задержка клина после выстрела, мс. */
    delay: 300,
    sound: { file: `${SOUND_DIR}/jam.ogg`, volume: 0.8 },
    smoke: { file: "jb2a.smoke.puff.side.grey.0", width: 0.38, height: 0.25, playbackRate: 1.7, opacity: 0.55 }
  };

  /**
   * Продвинутый огнестрел. reload — по виду перезарядки из ребреи
   * (reloadKindOf): magazine — «Смена магазина», single — «Перезарядка»,
   * breechless — «Безмагазинное»; вид без записи — без анимации.
   * afterShot — затвор после выстрела (кроме выстрела с клином), через
   * случайную паузу от delayMin до delayMax мс.
   */
  const ADVANCED = {
    shot: ADVANCED_SHOT,
    jam: JAM,
    afterShot: null,
    reload: {
      magazine: { sound: { file: `${SOUND_DIR}/reload-rifle.mp3`, volume: 0.85 } }
    }
  };

  /** Примитивное: глухой выстрел, облако дыма на стрелке, без анимации перезарядки. */
  const PRIMITIVE = mergeProfile(ADVANCED, {
    shot: {
      sound: { file: `${SOUND_DIR}/musket-shot.wav`, volume: 0.9 },
      cloud: {
        file: "jb2a.smoke.plumes_loop.01.grey",
        // Доля размера стрелка; облако висит duration мс и тает за fadeOut мс.
        scale: 1.6,
        opacity: 0.6,
        delay: 120,
        duration: 2500,
        fadeIn: 250,
        fadeOut: 1500
      }
    },
    reload: null
  });

  const RIFLE = mergeProfile(ADVANCED, { afterShot: { delayMin: 250, delayMax: 600, ...BOLT_CYCLE } });

  /** Тяжёлая винтовка: затвор как у винтовки, свой звук выстрела. */
  const HEAVY_RIFLE = mergeProfile(RIFLE, { shot: { sound: { file: `${SOUND_DIR}/shot-heavy-SR.wav` } } });

  /**
   * Ключ — gearId предмета в ребрее. Огнестрел ребреи без записи здесь
   * (Мушкетон, Драгун, пистолеты и т. д.) анимаций не получает.
   */
  const FIREARM_TYPES = Object.freeze({
    "revol-ver": { label: "Револьвер", profile: ADVANCED },
    karabin: { label: "Карабин", profile: ADVANCED },
    vintovka: { label: "Винтовка", profile: RIFLE },
    "tyazhelaya-vintovka": { label: "Тяжёлая винтовка", profile: HEAVY_RIFLE },
    arkebuza: { label: "Аркебуза", profile: PRIMITIVE },
    mushket: { label: "Мушкет", profile: PRIMITIVE }
  });

  const rebreyaFlags = item => item?.flags?.[REBREYA_ID] ?? {};

  /** Огнестрел по правилам ребреи (её isFirearmItem). */
  function isRebreyaFirearm(item) {
    if (item?.type !== "weapon") return false;
    if (REBREYA_FIREARM_WEAPON_TYPES.has(String(item.system?.type?.value ?? ""))) return true;
    return Boolean(String(rebreyaFlags(item).firearmClass ?? "").trim());
  }

  /** Тип огнестрела предмета (gearId из FIREARM_TYPES) или null. */
  function firearmTypeOf(item) {
    if (!isRebreyaFirearm(item)) return null;
    const gearId = String(rebreyaFlags(item).gearId ?? "").trim();
    return Object.hasOwn(FIREARM_TYPES, gearId) ? gearId : null;
  }

  /** Ребрея ставит флаг заклинивания при осечке; заклиненным оружием атаковать нельзя. */
  function isFirearmJammed(item) {
    return rebreyaFlags(item).firearmJammed?.value === true;
  }

  /**
   * Вид перезарядки по значению свойства «Перезарядка» ребреи
   * (flags.rebreya-main.lichWeaponPropertyValues.reload: «Смена магазина 6»,
   * «Долгая перезарядка 1», «Безмагазинное 2»…).
   */
  function reloadKindOf(item) {
    const text = String(rebreyaFlags(item).lichWeaponPropertyValues?.reload ?? "").toLowerCase();
    if (/смен\S*\s+магазин/u.test(text)) return "magazine";
    if (/безмагазин/u.test(text)) return "breechless";
    if (/перезарядк/u.test(text)) return "single";
    return null;
  }

  /** Профиль типа; overrides — { gearId: правки } (для тестов из макроса). */
  function firearmProfile(typeId, overrides = {}) {
    return mergeProfile(FIREARM_TYPES[typeId]?.profile ?? {}, overrides?.[typeId]);
  }

  // ---------------------------------------------------------------------------
  // Геометрия (чистые функции, покрыты tests/mounted-combat.mjs)
  // ---------------------------------------------------------------------------

  const centerOf = token => ({ x: token.center.x, y: token.center.y });

  /** Единичный вектор на цель; без цели — по повороту токена (0° — вверх). */
  function aimDirection(source, target = null) {
    if (target && target !== source) {
      const from = centerOf(source);
      const to = centerOf(target);
      const distance = Math.hypot(to.x - from.x, to.y - from.y);
      if (distance > 0) return { x: (to.x - from.x) / distance, y: (to.y - from.y) / distance };
    }
    const angle = ((source.document?.rotation ?? 0) * Math.PI) / 180;
    return { x: Math.sin(angle), y: -Math.cos(angle) };
  }

  /** Дуло — у края токена в сторону выстрела. */
  function muzzlePoint(source, dir, gridSize) {
    const width = source.w ?? source.document.width * gridSize;
    const height = source.h ?? source.document.height * gridSize;
    const reach = Math.max(width, height) * 0.42;
    const center = centerOf(source);
    return { x: center.x + dir.x * reach, y: center.y + dir.y * reach };
  }

  /** Гильза вылетает вправо-назад от оружия и крутится в полёте. */
  function casingPath(source, dir, gridSize, random = Math.random) {
    const center = centerOf(source);
    const right = { x: -dir.y, y: dir.x };
    const origin = {
      x: center.x + dir.x * gridSize * 0.04 + right.x * gridSize * 0.1,
      y: center.y + dir.y * gridSize * 0.04 + right.y * gridSize * 0.1
    };
    const side = gridSize * (0.38 + random() * 0.18);
    const back = gridSize * (0.05 + random() * 0.14);
    const weaponAngle = (Math.atan2(dir.y, dir.x) * 180) / Math.PI;
    return {
      origin,
      end: { x: origin.x + right.x * side - dir.x * back, y: origin.y + right.y * side - dir.y * back },
      rotation: weaponAngle + 25 + random() * 40,
      spin: 900 + random() * 720
    };
  }

  // ---------------------------------------------------------------------------
  // Слои Sequencer
  // ---------------------------------------------------------------------------

  const asTokenObject = token => token?.object ?? token ?? null;
  const tokenUuid = token => (token?.document ?? token)?.uuid ?? null;
  const gridSize = () => canvas.dimensions.size;

  function sequencerReady() {
    return Boolean(game.modules.get("sequencer")?.active && typeof globalThis.Sequence === "function");
  }

  // softFail: отсутствующий файл не прерывает остальную последовательность.
  const newSequence = () => new Sequence({ moduleName: MODULE_ID, softFail: true });

  function addSound(sequence, layer, delay = 0) {
    const file = Array.isArray(layer?.files) ? layer.files[Math.floor(Math.random() * layer.files.length)] : layer?.file;
    if (!file) return;
    sequence.sound().file(file).volume(layer.volume ?? 1).delay(delay);
  }

  /** Эффект у дула, развёрнутый к цели, размером в клетках. */
  function addMuzzleEffect(sequence, layer, at, towards, delay = 0) {
    if (!layer?.file) return;
    sequence.effect().file(layer.file).atLocation(at).rotateTowards(towards)
      .size({ width: layer.width, height: layer.height }, { gridUnits: true })
      .playbackRate(layer.playbackRate ?? 1).opacity(layer.opacity ?? 1).delay(delay);
  }

  function addShot(sequence, shot, source, target, hit, delay) {
    const aimPoint = centerOf(target);
    const muzzle = muzzlePoint(source, aimDirection(source, target), gridSize());
    addSound(sequence, shot.sound, delay);
    addMuzzleEffect(sequence, shot.muzzleFlash, muzzle, aimPoint, delay);
    addMuzzleEffect(sequence, shot.smoke, muzzle, aimPoint, delay);
    if (shot.bullet?.file) {
      sequence.effect().file(shot.bullet.file).atLocation(muzzle).stretchTo(aimPoint)
        .playbackRate(shot.bullet.playbackRate ?? 1).missed(!hit).delay(delay);
    }
    if (hit && shot.impact?.file) {
      sequence.effect().file(shot.impact.file).atLocation(target).delay(delay + (shot.impact.delay ?? 0))
        .scaleToObject(shot.impact.scale ?? 1, { uniform: true }).randomRotation()
        .playbackRate(shot.impact.playbackRate ?? 1);
    }
    const cloud = shot.cloud;
    if (cloud?.file) {
      sequence.effect().file(cloud.file).atLocation(source).delay(delay + (cloud.delay ?? 0))
        .scaleToObject(cloud.scale ?? 1, { uniform: true }).opacity(cloud.opacity ?? 1)
        .duration(cloud.duration).fadeIn(cloud.fadeIn ?? 0).fadeOut(cloud.fadeOut ?? 0);
    }
  }

  function addJam(sequence, jam, source, target, delay) {
    const dir = aimDirection(source, target);
    const muzzle = muzzlePoint(source, dir, gridSize());
    const towards = target ? centerOf(target) : { x: muzzle.x + dir.x * 100, y: muzzle.y + dir.y * 100 };
    addSound(sequence, jam.sound, delay);
    addMuzzleEffect(sequence, jam.smoke, muzzle, towards, delay);
  }

  /** Механика оружия: звук, а при наличии casing — вылетающая гильза и её звук. */
  function addMechanism(sequence, layers, source, target, delay = 0) {
    addSound(sequence, layers.sound, delay);
    const casing = layers.casing;
    if (!casing) return;
    const { origin, end, rotation, spin } = casingPath(source, aimDirection(source, target), gridSize());
    sequence.effect().atLocation(origin).delay(delay + casing.ejectDelay)
      .shape("roundedRect", {
        name: "casing",
        width: casing.width,
        height: casing.height,
        radius: casing.radius,
        gridUnits: true,
        fillColor: casing.fillColor,
        fillAlpha: 1,
        lineColor: casing.lineColor,
        lineSize: casing.lineSize
      })
      .duration(casing.flight)
      .moveTowards(end, { rotate: false, ease: "easeOutQuad" })
      .rotate(rotation)
      .rotateOut(spin, casing.flight, { ease: "linear" })
      .fadeOut(100, { delay: -80 });
    addSound(sequence, layers.casingSound, delay + casing.ejectDelay + casing.flight - 40);
  }

  const randomBetween = (min = 0, max = min) => min + Math.random() * Math.max(0, max - min);

  // ---------------------------------------------------------------------------
  // Установка
  // ---------------------------------------------------------------------------

  /**
   * Ставит хук выстрела и обёртку перезарядки ребреи.
   * @param {object} [options]
   * @param {() => boolean} [options.isEnabled]  проверка при каждом срабатывании (флажок модуля)
   * @param {object} [options.overrides]          { gearId: правки профиля }
   * @param {boolean} [options.debug]             журнал решений в консоли
   * @returns {object} API (см. конец функции), в том числе uninstall()
   */
  function installFirearmAnimations({ isEnabled = () => true, overrides = {}, debug = false } = {}) {
    const log = (...args) => { if (debug) console.log(`[${MODULE_ID}] Огнестрел |`, ...args); };
    let active = true;
    let sequencerWarned = false;
    const profileOf = typeId => firearmProfile(typeId, overrides);

    function ready() {
      if (sequencerReady()) return true;
      if (!sequencerWarned) console.warn(`[${MODULE_ID}] Анимации огнестрела: модуль Sequencer не включён.`);
      sequencerWarned = true;
      return false;
    }

    /** Выстрел по целям; затем клин (jammed) или затвор (afterShot профиля). */
    async function play(typeId, sourceToken, targets = [], { hitTargets = null, jammed = false } = {}) {
      const source = asTokenObject(sourceToken);
      const targetList = [...targets].map(asTokenObject).filter(Boolean);
      if (!source || !targetList.length || !FIREARM_TYPES[typeId] || !ready()) return false;
      const profile = profileOf(typeId);
      const hits = hitTargets ? new Set([...hitTargets].map(tokenUuid)) : null;
      const interval = profile.shot?.targetInterval ?? 0;
      const lastShot = (targetList.length - 1) * interval;
      const sequence = newSequence();
      targetList.forEach((target, index) => {
        if (profile.shot) addShot(sequence, profile.shot, source, target, !hits || hits.has(tokenUuid(target)), index * interval);
      });
      // Заклинившее оружие затвор не передёргивает.
      if (jammed && profile.jam) {
        addJam(sequence, profile.jam, source, targetList[0], lastShot + (profile.jam.delay ?? 0));
      } else if (!jammed && profile.afterShot) {
        const after = profile.afterShot;
        addMechanism(sequence, after, source, targetList.at(-1), lastShot + randomBetween(after.delayMin, after.delayMax));
      }
      log("выстрел", { typeId, targets: targetList.length, jammed, afterShot: Boolean(!jammed && profile.afterShot) });
      await sequence.play();
      return true;
    }

    /** Перезарядка; kind — вид из reloadKindOf. Нет записи в профиле — нет анимации. */
    async function playReload(typeId, sourceToken, kind) {
      const source = asTokenObject(sourceToken);
      const layers = FIREARM_TYPES[typeId] ? profileOf(typeId).reload?.[kind] : null;
      if (!layers) {
        log("перезарядка без анимации", { typeId, kind });
        return false;
      }
      if (!source || !ready()) return false;
      const sequence = newSequence();
      addMechanism(sequence, layers, source, [...(game.user.targets ?? [])][0] ?? null);
      log("перезарядка", { typeId, kind });
      await sequence.play();
      return true;
    }

    async function onAttack(workflow) {
      const item = workflow?.item;
      if (!isRebreyaFirearm(item)) return false;
      const typeId = firearmTypeOf(item);
      if (!typeId) {
        log(`нет профиля для gearId «${rebreyaFlags(item).gearId ?? ""}» (${item.name})`);
        return false;
      }
      const source = workflow.token ?? workflow.actor?.getActiveTokens?.()?.[0];
      // Заклиненным оружием атаковать нельзя: флаг здесь — клин от этого выстрела.
      const jammed = isFirearmJammed(item);
      log("атака", { item: item.name, typeId, jammed, targets: workflow.targets?.size, hits: workflow.hitTargets?.size });
      return play(typeId, source, workflow.targets ?? [], { hitTargets: workflow.hitTargets ?? null, jammed });
    }

    const hookId = Hooks.on("midi-qol.AttackRollComplete", workflow => {
      if (!active || !isEnabled()) return;
      // Не возвращаем промис/булево в Midi: ошибки анимации не должны ломать атаку.
      onAttack(workflow).catch(err => console.error(`[${MODULE_ID}] Ошибка анимации огнестрела`, err));
    });

    // --- Перезарядка ребреи -----------------------------------------------------

    // Аргументы reloadFirearm: (actorOrItem, weaponOrId).
    function weaponFromArgs([actorOrItem, weaponOrId] = [], result = null) {
      if (actorOrItem?.documentName === "Item") return actorOrItem;
      if (weaponOrId?.documentName === "Item") return weaponOrId;
      const id = result?.weaponId ?? (typeof weaponOrId === "string" ? weaponOrId : null);
      return id ? actorOrItem?.items?.get?.(id) ?? null : null;
    }

    function afterReload(args, result) {
      if (result?.success !== true || !(Number(result.loaded) > 0)) {
        return log("перезарядка без анимации: ребрея ничего не зарядила", result);
      }
      const weapon = weaponFromArgs(args, result);
      const typeId = firearmTypeOf(weapon);
      if (!typeId) return log(`перезарядка: нет профиля для gearId «${rebreyaFlags(weapon).gearId ?? ""}»`);
      const source = weapon.actor?.getActiveTokens?.()?.[0] ?? canvas.tokens?.controlled?.[0];
      playReload(typeId, source, reloadKindOf(weapon))
        .catch(err => console.error(`[${MODULE_ID}] Ошибка анимации огнестрела`, err));
    }

    let restore = null;
    function wrapRebreya() {
      const service = game.rebreyaMain?.combatAttackService;
      const original = service?.reloadFirearm;
      if (typeof original !== "function") {
        console.warn(`[${MODULE_ID}] Анимации огнестрела: сервис атак ребреи не найден — перезарядка без анимации.`);
        return;
      }
      const hadOwn = Object.hasOwn(service, "reloadFirearm");
      const wrapper = async function (...args) {
        const result = await original.apply(this, args);
        if (active && isEnabled()) {
          try { afterReload(args, result); }
          catch (err) { console.error(`[${MODULE_ID}] Ошибка анимации огнестрела`, err); }
        }
        return result;
      };
      service.reloadFirearm = wrapper;
      restore = () => {
        // Если поверх обернул кто-то ещё — оставляем: неактивная обёртка просто пропускает вызов.
        if (service.reloadFirearm !== wrapper) return;
        if (hadOwn) service.reloadFirearm = original;
        else delete service.reloadFirearm;
      };
    }
    // Модуль ставится до ready, макрос — после.
    if (globalThis.game?.rebreyaMain) wrapRebreya();
    else Hooks.once("ready", () => { if (active) wrapRebreya(); });

    return {
      FIREARM_TYPES,
      overrides,
      isRebreyaFirearm,
      firearmTypeOf,
      isFirearmJammed,
      reloadKindOf,
      profile: profileOf,
      /** Проверка без атаки: play("vintovka", token, [...game.user.targets]) */
      play,
      /** playReload("vintovka", token, "magazine") */
      playReload,
      uninstall() {
        active = false;
        Hooks.off("midi-qol.AttackRollComplete", hookId);
        restore?.();
        restore = null;
      }
    };
  }

  globalThis.NazgobFirearms = installFirearmAnimations({ overrides: SHOT_OVERRIDES, debug: DEBUG });
  ui.notifications.info(`Огнестрел: анимации установлены (профили: ${Object.keys(FIREARM_TYPES).join(", ")}).`);
})();
