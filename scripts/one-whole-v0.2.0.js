// «Одно целое»: наездник и скакун с общим пулом хитов.
//
// Этот файл — единственный источник механики. Модуль импортирует его, а
// tools/build-macro.mjs собирает из него тестовый макрос (без `export`).
// Поэтому здесь нет импортов и всё состояние живёт внутри installOneWhole().
//
// Принципы, которые чинят ошибки версии 0.1.x:
// - Пара хранится ОДНИМ флагом на Actor наездника, а не на токенах. Токены —
//   только отображение, поэтому перенос между сценами, удаление и
//   пересоздание токенов не рвут и не дублируют связь.
// - Общий пул — это сами hp.value/hp.temp обоих Actor (зеркало). Отдельной
//   копии пула во флагах нет, расходиться нечему.
// - Пишет только активный ГМ, все записи идут через одну очередь.
// - Изменения ХП применяются как дельты, а не как абсолютные значения, так что
//   параллельные обновления не перетирают друг друга.
// - Эффект максимума создаётся с фиксированным _id, дубли невозможны. Бонус
//   берётся из hp.max партнёра, который не зависит от tempmax: циклического
//   пересчёта нет.

export const ONE_WHOLE_MODULE_ID = "nazgob-personal";
/** Ключ флага пары и аннотации урона в calcDamageOptions[MODULE_ID]. */
export const ONE_WHOLE_FLAG = "oneWhole";

const PAIR_FLAG = ONE_WHOLE_FLAG;
const ORIGINAL_TEXTURE_FLAG = "oneWholeOriginalTexture";
const HP_EVENT_FLAG = "oneWholeHpEvent";
const MAX_EFFECT_ID = "nazgobOneWholeHp";
const MAX_EFFECT_NAME = "Одно целое — общий максимум хитов";
const QUERY_NAME = `${ONE_WHOLE_MODULE_ID}.oneWhole`;
const CHANGED_HOOK = `${ONE_WHOLE_MODULE_ID}.oneWholeChanged`;
const BATCH_QUIET_MS = 200;
const BATCH_MAX_MS = 1000;

// ---------------------------------------------------------------------------
// Чистые функции (покрыты tests/one-whole.mjs)
// ---------------------------------------------------------------------------

/**
 * Разделение общего пула при спешивании (правило черты):
 * сначала скакун получает хиты, которые были у него перед посадкой; остаток
 * становится хитами наездника; если и он полон — остаток восстанавливает скакуна.
 */
export function splitSharedHp({ sharedHp, mountHpBeforePool, riderMax, mountMax }) {
  let pool = Math.max(0, Number(sharedHp) || 0);
  const safeRiderMax = Math.max(0, Number(riderMax) || 0);
  const safeMountMax = Math.max(0, Number(mountMax) || 0);
  const mountRestoreTarget = Math.min(Math.max(0, Number(mountHpBeforePool) || 0), safeMountMax);

  if (pool <= mountRestoreTarget) return { riderHp: 0, mountHp: Math.min(pool, safeMountMax) };

  let mountHp = mountRestoreTarget;
  pool -= mountHp;
  const riderHp = Math.min(pool, safeRiderMax);
  pool -= riderHp;
  if (pool > 0) mountHp += Math.min(pool, safeMountMax - mountHp);
  return { riderHp, mountHp };
}

/** Временные хиты делятся так же: сначала скакуну его прежние, остальное наезднику. */
export function splitSharedTemp({ sharedTemp, mountTempBeforePool }) {
  const pool = Math.max(0, Number(sharedTemp) || 0);
  const mountTemp = Math.min(pool, Math.max(0, Number(mountTempBeforePool) || 0));
  return { riderTemp: pool - mountTemp, mountTemp };
}

/**
 * Превращает одно изменение ХП Actor'а в событие пула.
 * `before` — ХП до обновления (dnd5e кладёт его в options.dnd5e.hp).
 */
export function hpEventFromChange({ role, before, after, annotation = null }) {
  const dValue = (Number(after?.value) || 0) - (Number(before?.value) || 0);
  const dTemp = (Number(after?.temp) || 0) - (Number(before?.temp) || 0);
  return {
    role,
    dValue,
    dTemp,
    beforeTemp: Math.max(0, Number(before?.temp) || 0),
    cross: annotation?.cross ?? null,
    group: annotation?.group ?? null,
    bothHit: Boolean(annotation?.bothHit),
    healScale: annotation?.healScale ?? null
  };
}

/**
 * Сводит пачку событий в новое значение пула.
 *
 * Урон группируется по источнику (workflow Midi или общее «окно» в 200 мс):
 * - задеты оба в одной группе → из пула вычитается больший урон один раз;
 * - задет один → вычитается больший из его урона и урона, который получил бы
 *   партнёр со своими сопротивлениями/уязвимостями (`cross`).
 * Лечение суммируется. Временные хиты общие: урон сначала снимает их, а
 * новые временные хиты заменяют текущие, только если их больше.
 */
export function resolvePoolBatch({ base, events = [], maxPool = Infinity }) {
  let value = Math.max(0, Number(base?.value) || 0);
  let temp = Math.max(0, Number(base?.temp) || 0);
  const groups = new Map();
  let heal = 0;
  let tempSet = null;

  for (const event of events) {
    const loss = Math.max(0, -event.dValue) + Math.max(0, -event.dTemp);
    const gain = Math.max(0, event.dValue);
    const scale = Number(event.healScale) > 0 ? Number(event.healScale) : 1;
    heal += Math.floor(gain * scale + 1e-9);
    if (event.dTemp > 0) tempSet = Math.max(tempSet ?? 0, event.beforeTemp + event.dTemp);
    if (loss <= 0) continue;

    const key = event.group ?? "~window";
    let group = groups.get(key);
    if (!group) {
      group = { bothHit: false, rider: { loss: 0, cross: 0 }, mount: { loss: 0, cross: 0 } };
      groups.set(key, group);
    }
    const side = event.role === "mount" ? group.mount : group.rider;
    side.loss += loss;
    side.cross += Math.max(0, Number(event.cross) || 0);
    group.bothHit ||= event.bothHit;
  }

  let damage = 0;
  for (const { bothHit, rider, mount } of groups.values()) {
    if (bothHit || (rider.loss > 0 && mount.loss > 0)) {
      damage += Math.max(rider.loss, mount.loss);
    } else {
      const side = rider.loss > 0 ? rider : mount;
      damage += Math.max(side.loss, side.cross);
    }
  }

  const absorbed = Math.min(temp, damage);
  temp -= absorbed;
  value = Math.max(0, value - (damage - absorbed));
  value = Math.min(Math.max(0, maxPool), value + heal);
  if (tempSet !== null) temp = Math.max(temp, tempSet);
  return { value, temp, damage, heal };
}

/** Обновление изображения токена скакуна (или null, если менять нечего). */
export function mountTextureUpdate(token, { active, mountedImage, mountedScale = 1, prototypeTexture = null }) {
  const id = ONE_WHOLE_MODULE_ID;
  const texture = token?.texture ?? {};
  const original = token?.flags?.[id]?.[ORIGINAL_TEXTURE_FLAG] ?? null;
  const signed = (reference, scale) => (Number(reference) < 0 ? -1 : 1) * scale;

  if (active) {
    if (!mountedImage) return null;
    const scale = Number(mountedScale) > 0 ? Number(mountedScale) : 1;
    const saved = original ?? (texture.src === mountedImage && prototypeTexture
      ? { src: prototypeTexture.src, scaleX: prototypeTexture.scaleX ?? 1, scaleY: prototypeTexture.scaleY ?? 1 }
      : { src: texture.src, scaleX: texture.scaleX ?? 1, scaleY: texture.scaleY ?? 1 });
    const scaleX = signed(saved.scaleX, scale);
    const scaleY = signed(saved.scaleY, scale);
    if (texture.src === mountedImage && texture.scaleX === scaleX && texture.scaleY === scaleY && original) return null;
    return {
      "texture.src": mountedImage,
      "texture.scaleX": scaleX,
      "texture.scaleY": scaleY,
      [`flags.${id}.${ORIGINAL_TEXTURE_FLAG}`]: saved
    };
  }

  const restore = original ?? (texture.src === mountedImage && prototypeTexture ? prototypeTexture : null);
  if (!restore?.src) return null;
  return {
    "texture.src": restore.src,
    "texture.scaleX": restore.scaleX ?? 1,
    "texture.scaleY": restore.scaleY ?? 1,
    ...(original ? { [`flags.${id}.-=${ORIGINAL_TEXTURE_FLAG}`]: null } : {})
  };
}

// ---------------------------------------------------------------------------
// Установка механики
// ---------------------------------------------------------------------------

/**
 * @param {object|() => object} configSource  {riderUuid, mountUuid, mountedImage, mountedScale}
 *                                             или функция, возвращающая такой объект.
 * @returns {object} API механики (см. конец функции).
 */
export function installOneWhole(configSource) {
  const MODULE_ID = ONE_WHOLE_MODULE_ID;
  const readConfig = () => {
    const raw = typeof configSource === "function" ? configSource() : configSource;
    return {
      riderUuid: String(raw?.riderUuid ?? "").trim(),
      mountUuid: String(raw?.mountUuid ?? "").trim(),
      mountedImage: String(raw?.mountedImage ?? "").trim(),
      mountedScale: Number(raw?.mountedScale) > 0 ? Number(raw.mountedScale) : 1,
      // "activeGM" — пишет активный ГМ (модуль стоит у всех клиентов).
      // "self" — пишет клиент ГМа, где установлена механика (тестовый макрос).
      authority: raw?.authority === "self" ? "self" : "activeGM",
      // Выключенная механика остаётся установленной, но её хуки ничего не делают.
      enabled: raw?.enabled !== false,
      debug: Boolean(raw?.debug)
    };
  };
  const enabled = () => readConfig().enabled;

  const hookIds = [];
  // Проверка в обёртке, а не в каждом обработчике: результат (false у preMoveToken) не теряется.
  const on = (name, fn) => hookIds.push([name, Hooks.on(name, (...args) => (enabled() ? fn(...args) : undefined))]);
  const log = (...args) => console.log(`[${MODULE_ID}] Одно целое |`, ...args);
  const fail = (message, err) => {
    console.error(`[${MODULE_ID}] Одно целое | ${message}`, err);
    ui.notifications?.error(`Одно целое: ${message}${err?.message ? ` (${err.message})` : ""}`);
  };
  const internal = (extra = {}) => ({ ...extra, [MODULE_ID]: { ...(extra[MODULE_ID] ?? {}), internal: true } });
  const isInternal = options => Boolean(options?.[MODULE_ID]?.internal);
  // Единственный клиент, который пишет в документы пары. В режиме "self" это
  // клиент с механикой, если он владеет обоими Actor (ГМ или игрок-владелец).
  const ownsPair = () => Boolean(riderActor()?.isOwner && mountActor()?.isOwner);
  const isGM = () => (readConfig().authority === "self" ? ownsPair() : Boolean(game.user?.isActiveGM));
  const debug = (...args) => { if (readConfig().debug) log(...args); };

  // --- Акторы и токены ------------------------------------------------------

  function worldActor(uuid) {
    if (!uuid) return null;
    try {
      const doc = fromUuidSync(uuid);
      return doc?.documentName === "Actor" && !doc.isToken ? doc : null;
    } catch {
      return null;
    }
  }
  const riderActor = () => worldActor(readConfig().riderUuid);
  const mountActor = () => worldActor(readConfig().mountUuid);

  function actorRole(actor) {
    if (!actor || actor.isToken) return null;
    if (actor === riderActor()) return "rider";
    if (actor === mountActor()) return "mount";
    return null;
  }

  const tokensOf = (actor, scene) => actor && scene
    ? scene.tokens.filter(token => token.actorLink && token.actorId === actor.id)
    : [];
  const asDoc = token => token?.document ?? token ?? null;
  const isRiderToken = token => { const doc = asDoc(token); return Boolean(doc?.actorLink && doc.actorId && doc.actorId === riderActor()?.id); };
  const isMountToken = token => { const doc = asDoc(token); return Boolean(doc?.actorLink && doc.actorId && doc.actorId === mountActor()?.id); };

  // --- Состояние пары -------------------------------------------------------

  const STATUSES = new Set(["joining", "active", "splitting"]);
  const rawPairFlag = () => riderActor()?.flags?.[MODULE_ID]?.[PAIR_FLAG] ?? null;
  // Флаг без известного статуса (остаток прерванной записи) парой не считается.
  const pairState = () => { const flag = rawPairFlag(); return STATUSES.has(flag?.status) ? flag : null; };
  const pairActive = () => pairState()?.status === "active";

  function hpOf(actor) {
    const hp = actor?.system?.attributes?.hp ?? {};
    return {
      value: Math.max(0, Number(hp.value) || 0),
      temp: Math.max(0, Number(hp.temp) || 0),
      max: Math.max(0, Number(hp.max) || 0),
      effectiveMax: Math.max(0, Number(hp.effectiveMax ?? hp.max) || 0)
    };
  }

  function appliedBonus(actor) {
    const effect = actor?.effects?.get(MAX_EFFECT_ID);
    if (!effect || effect.disabled) return 0;
    return effect.changes.reduce((sum, change) => sum + (Number(change.value) || 0), 0);
  }

  /** Собственный максимум (hp.max + tempmax) без бонуса «Одного целого». */
  const ownMax = actor => Math.max(0, hpOf(actor).effectiveMax - appliedBonus(actor));
  // Общий максимум — сумма собственных максимумов. Бонус каждому равен
  // собственному максимуму партнёра, поэтому у обоих effectiveMax совпадает
  // с ним. От собственного бонуса ownMax не зависит: обратной связи нет.
  const poolMax = () => ownMax(riderActor()) + ownMax(mountActor());

  // --- Очередь записей ГМ ----------------------------------------------------

  let queue = Promise.resolve();
  function enqueue(label, operation) {
    const run = queue.then(operation).catch(err => fail(label, err));
    queue = run;
    return run;
  }

  // --- Эффекты максимума хитов ------------------------------------------------

  function maxEffectData(bonus) {
    return {
      name: MAX_EFFECT_NAME,
      img: "icons/environment/people/cavalry.webp",
      disabled: false,
      transfer: false,
      changes: [{
        key: "system.attributes.hp.tempmax",
        mode: CONST.ACTIVE_EFFECT_MODES.ADD,
        value: String(Math.max(0, Math.round(bonus))),
        priority: 20
      }],
      flags: { [MODULE_ID]: { [PAIR_FLAG]: true } }
    };
  }

  async function ensureMaxEffect(actor, bonus) {
    const data = maxEffectData(bonus);
    const existing = actor.effects.get(MAX_EFFECT_ID);
    if (existing) {
      const current = existing.changes?.[0];
      const same = !existing.disabled && existing.changes.length === 1
        && current.key === data.changes[0].key && String(current.value) === data.changes[0].value
        && Number(current.mode) === data.changes[0].mode;
      if (!same) await existing.update({ disabled: false, changes: data.changes }, internal());
      return;
    }
    try {
      await actor.createEmbeddedDocuments("ActiveEffect", [{ _id: MAX_EFFECT_ID, ...data }], internal({ keepId: true }));
    } catch (err) {
      // Эффект с этим _id уже есть (гонка с другим клиентом) — просто обновляем.
      const raced = actor.effects.get(MAX_EFFECT_ID);
      if (!raced) throw err;
      await raced.update({ disabled: false, changes: data.changes }, internal());
    }
  }

  async function syncMaxEffects() {
    const rider = riderActor();
    const mount = mountActor();
    if (!rider || !mount) return;
    await ensureMaxEffect(rider, ownMax(mount));
    await ensureMaxEffect(mount, ownMax(rider));
  }

  async function removeMaxEffects() {
    for (const actor of [riderActor(), mountActor()]) {
      if (actor?.effects.get(MAX_EFFECT_ID)) {
        await actor.deleteEmbeddedDocuments("ActiveEffect", [MAX_EFFECT_ID], internal());
      }
    }
  }

  // --- Запись пула ---------------------------------------------------------

  // Последнее значение пула, записанное этим ГМ. База для дельт.
  let poolCache = null;
  // Пока true, изменения ХП обоих Actor собираются в события пула.
  let recording = false;

  async function setHp(actor, { value, temp }) {
    const hp = hpOf(actor);
    const update = {};
    if (value !== undefined && hp.value !== value) update["system.attributes.hp.value"] = value;
    if (temp !== undefined && hp.temp !== temp) update["system.attributes.hp.temp"] = temp;
    if (!Object.keys(update).length) return;
    // Зеркальная запись — не новый урон: проверка концентрации здесь не нужна.
    await actor.update(update, internal({ dnd5e: { concentrationCheck: false } }));
  }

  async function writePool(pool) {
    const value = Math.min(Math.max(0, Math.round(pool.value)), poolMax());
    const temp = Math.max(0, Math.round(pool.temp));
    poolCache = { value, temp };
    await Promise.all([setHp(riderActor(), poolCache), setHp(mountActor(), poolCache)]);
    // Последний записанный пул хранится в паре: если механика была выключена
    // (перезагрузка страницы), по нему восстанавливаются пропущенные изменения.
    const saved = pairState()?.lastPool;
    if (pairState() && (saved?.value !== value || saved?.temp !== temp)) {
      await riderActor().update({ [`flags.${MODULE_ID}.${PAIR_FLAG}.lastPool`]: { value, temp } }, internal());
    }
  }

  async function writePairFlag(state) {
    const rider = riderActor();
    if (!state) await rider.update({ [`flags.${MODULE_ID}.-=${PAIR_FLAG}`]: null }, internal());
    else await rider.update({ [`flags.${MODULE_ID}.${PAIR_FLAG}`]: state }, internal());
  }

  // --- События ХП (только активный ГМ) --------------------------------------

  let pendingEvents = [];
  let batchTimer = null;
  let batchStarted = 0;

  function addEvent(event) {
    pendingEvents.push(event);
    const now = Date.now();
    if (!batchTimer) batchStarted = now;
    clearTimeout(batchTimer);
    const wait = Math.max(0, Math.min(BATCH_QUIET_MS, batchStarted + BATCH_MAX_MS - now));
    batchTimer = setTimeout(() => {
      batchTimer = null;
      enqueue("не удалось применить изменение общих хитов", resolveBatchNow);
    }, wait);
  }

  async function resolveBatchNow() {
    if (!pendingEvents.length) return;
    const events = pendingEvents;
    pendingEvents = [];
    if (!pairActive()) return;

    const base = poolCache ?? events.find(event => event.before)?.before ?? hpOf(riderActor());
    const result = resolvePoolBatch({ base, events, maxPool: poolMax() });
    log("пул", base, "→", { value: result.value, temp: result.temp },
      `(урон ${result.damage}, лечение ${result.heal}, событий ${events.length})`);
    await writePool(result);
  }

  async function flushEvents() {
    clearTimeout(batchTimer);
    batchTimer = null;
    while (pendingEvents.length) await resolveBatchNow();
  }

  // --- Посадка / спешивание -----------------------------------------------

  async function pairNow() {
    const rider = riderActor();
    const mount = mountActor();
    if (!rider || !mount) {
      ui.notifications.warn("Одно целое: проверьте UUID наездника и скакуна в настройках.");
      return false;
    }
    const state = pairState();
    if (state?.status === "active") return true;
    if (state?.status === "splitting") await finishSplit();
    if (!readConfig().mountedImage) {
      ui.notifications.warn("Одно целое: не указано изображение пары — токен скакуна останется прежним.");
    }

    // Чтение ХП и включение записи событий — синхронно, без await между ними:
    // всё, что придёт позже, учтётся как дельта к пулу.
    const riderHp = hpOf(rider);
    const mountHp = hpOf(mount);
    recording = true;
    poolCache = null;
    await writePairFlag({
      status: "joining",
      mountActorId: mount.id,
      mountHpBefore: mountHp.value,
      mountTempBefore: mountHp.temp,
      pool: { value: riderHp.value + mountHp.value, temp: riderHp.temp + mountHp.temp },
      split: null
    });
    await finishJoin();
    return true;
  }

  async function finishJoin() {
    const state = pairState();
    if (state?.status !== "joining") return;
    recording = true;
    await syncMaxEffects();
    await writePool(state.pool);
    await writePairFlag({ ...pairState(), status: "active", pool: null });
    log("пара объединена, общий пул", poolCache);
    await reconcileTokens();
  }

  async function unpairNow() {
    const state = pairState();
    if (!state) return true;
    if (state.status === "joining") await finishJoin();
    if (pairState()?.status === "active") {
      await flushEvents();
      // Пул читается синхронно вместе с остановкой записи событий.
      const rider = riderActor();
      const mount = mountActor();
      const pool = poolCache ?? { value: hpOf(rider).value, temp: hpOf(rider).temp };
      recording = false;
      const fresh = pairState();
      const hp = splitSharedHp({
        sharedHp: pool.value,
        mountHpBeforePool: fresh.mountHpBefore,
        riderMax: ownMax(rider),
        mountMax: ownMax(mount)
      });
      const temp = splitSharedTemp({ sharedTemp: pool.temp, mountTempBeforePool: fresh.mountTempBefore });
      await writePairFlag({
        ...fresh,
        status: "splitting",
        split: {
          rider: { value: hp.riderHp, temp: temp.riderTemp },
          mount: { value: hp.mountHp, temp: temp.mountTemp }
        }
      });
    }
    await finishSplit();
    return true;
  }

  async function finishSplit() {
    const state = pairState();
    if (state?.status !== "splitting") return;
    recording = false;
    pendingEvents = [];
    await removeMaxEffects();
    await setHp(riderActor(), state.split.rider);
    await setHp(mountActor(), state.split.mount);
    await writePairFlag(null);
    poolCache = null;
    log("пара разделена", state.split);
    await reconcileTokens();
  }

  // --- Токены: изображение скакуна и положение наездника -------------------

  function prototypeTextureOf(actor) {
    const texture = actor?.prototypeToken?.texture;
    return texture?.src ? { src: texture.src, scaleX: texture.scaleX ?? 1, scaleY: texture.scaleY ?? 1 } : null;
  }

  async function snapRider(riderToken, mountToken) {
    const moved = riderToken.x !== mountToken.x || riderToken.y !== mountToken.y
      || (riderToken.elevation ?? 0) !== (mountToken.elevation ?? 0);
    if (moved) {
      await riderToken.move([{
        x: mountToken.x,
        y: mountToken.y,
        elevation: mountToken.elevation ?? 0,
        action: "displace",
        snapped: false,
        explicit: true,
        checkpoint: true
      }], {
        method: "api",
        constrainOptions: { ignoreWalls: true, ignoreCost: true },
        autoRotate: false,
        showRuler: false,
        ...internal()
      });
    }
    // Наездник лежит поверх скакуна, чтобы его можно было выделить и взять в цель.
    if (riderToken.sort <= mountToken.sort) await riderToken.update({ sort: mountToken.sort + 1 }, internal());
  }

  async function reconcileTokens() {
    if (!isGM()) return;
    const config = readConfig();
    const rider = riderActor();
    const mount = mountActor();
    if (!rider || !mount) return;
    const active = pairActive();
    const prototypeTexture = prototypeTextureOf(mount);

    for (const scene of game.scenes) {
      const mountTokens = tokensOf(mount, scene);
      const updates = [];
      for (const token of mountTokens) {
        const update = mountTextureUpdate(token, {
          active,
          mountedImage: config.mountedImage,
          mountedScale: config.mountedScale,
          prototypeTexture
        });
        if (update) updates.push({ _id: token.id, ...update });
      }
      if (updates.length) await scene.updateEmbeddedDocuments("Token", updates, internal());
      if (active && mountTokens.length) {
        for (const riderToken of tokensOf(rider, scene)) await snapRider(riderToken, mountTokens[0]);
      }
    }
    refreshRiderMeshes();
  }

  // --- Скрытие картинки наездника (локально на каждом клиенте) --------------

  function shouldHideRiderMesh(token) {
    if (!token || token.isPreview || !isRiderToken(token) || !pairActive()) return false;
    return tokensOf(mountActor(), token.document.parent).length > 0;
  }

  function refreshRiderMeshes() {
    if (!canvas?.ready) return;
    for (const token of canvas.tokens.placeables) {
      if (isRiderToken(token)) token.renderFlags.set({ refreshState: true, refreshMesh: true });
    }
  }

  // --- Запросы к ГМ ---------------------------------------------------------

  function runAction(action) {
    if (action === "pair") return enqueue("не удалось объединить пару", pairNow);
    if (action === "unpair") return enqueue("не удалось разделить пару", unpairNow);
    if (action === "resync") return enqueue("не удалось синхронизировать пару", resyncNow);
    throw new Error(`Неизвестное действие ${action}`);
  }

  async function requestAction(action) {
    if (!enabled()) {
      ui.notifications.warn("Одно целое: механика выключена в настройках модуля.");
      return false;
    }
    if (isGM()) return Boolean(await runAction(action));
    const gm = game.users.activeGM;
    if (!gm || !(QUERY_NAME in CONFIG.queries)) {
      ui.notifications.warn("Одно целое: для этого действия нужен активный ГМ.");
      return false;
    }
    try {
      return Boolean(await gm.query(QUERY_NAME, { action, userId: game.user.id }, { timeout: 30000 }));
    } catch (err) {
      fail("ГМ не выполнил запрос", err);
      return false;
    }
  }

  // Обработчик query не получает отправителя, поэтому он передаётся в данных.
  async function handleQuery({ action, userId } = {}) {
    if (!enabled() || !isGM()) return false;
    const user = game.users.get(userId);
    if (!user || !riderActor()?.testUserPermission(user, "OWNER")) return false;
    return Boolean(await runAction(action));
  }

  // --- Диалоги перемещения наездника ----------------------------------------

  const openDialogs = new Set();

  async function confirm(content) {
    return await foundry.applications.api.DialogV2.confirm({
      window: { title: "Одно целое" },
      content: `<p>${content}</p>`,
      rejectClose: false,
      modal: true
    }) === true;
  }

  function movementWaypoints(movement) {
    return [...movement.passed.waypoints, ...movement.pending.waypoints]
      .filter(waypoint => !waypoint.intermediate)
      .map(({ x, y, elevation, width, height, shape, action, snapped, explicit, checkpoint }) =>
        ({ x, y, elevation, width, height, shape, action, snapped, explicit, checkpoint }));
  }

  async function askUnpair(riderToken, movement) {
    if (openDialogs.has(riderToken.uuid)) return;
    openDialogs.add(riderToken.uuid);
    try {
      if (!await confirm("Разъединить наездника и скакуна?")) return;
      if (!await requestAction("unpair")) return;
      const waypoints = movementWaypoints(movement);
      if (!waypoints.length) return;
      await riderToken.move(waypoints, {
        method: movement.method,
        constrainOptions: { ...(movement.constrainOptions ?? {}) },
        autoRotate: movement.autoRotate,
        showRuler: movement.showRuler
      });
    } finally {
      openDialogs.delete(riderToken.uuid);
    }
  }

  async function askPair(riderToken) {
    if (openDialogs.has(riderToken.uuid)) return;
    openDialogs.add(riderToken.uuid);
    try {
      if (await confirm("Объединить наездника и скакуна?")) await requestAction("pair");
    } finally {
      openDialogs.delete(riderToken.uuid);
    }
  }

  // Токен нужного Actor, но без привязки к актёру: его ХП — отдельная копия,
  // механика с ним не работает. Предупреждаем один раз на токен.
  const unlinkedWarned = new Set();
  function warnIfUnlinked(token) {
    const doc = asDoc(token);
    if (!doc?.actorId || doc.actorLink || unlinkedWarned.has(doc.uuid)) return;
    if (doc.actorId !== riderActor()?.id && doc.actorId !== mountActor()?.id) return;
    unlinkedWarned.add(doc.uuid);
    ui.notifications.warn(`Одно целое: токен «${doc.name}» не привязан к актёру (Link Actor Data) — механика его не видит.`);
  }

  function onPreMoveToken(document, movement, operation) {
    warnIfUnlinked(document);
    if (isInternal(operation) || !isRiderToken(document) || !pairState()) return;
    // Наездника и скакуна двигают вместе одной операцией — это не спешивание.
    const moving = operation?.movement ?? {};
    if (tokensOf(mountActor(), document.parent).some(token => moving[token.id])) return;
    askUnpair(document, movement).catch(err => fail("ошибка спешивания", err));
    return false;
  }

  function onMoveToken(document, movement, operation, user) {
    if (isInternal(operation)) return;
    if (user?.id === game.user.id) warnIfUnlinked(document);

    // Скакун двинулся — наездник следует тем же путём (пишет только ГМ).
    if (isMountToken(document)) {
      if (!isGM() || !pairActive()) return;
      const moving = operation?.movement ?? {};
      const path = movement.passed.waypoints.map(({ x, y, elevation, action, checkpoint }) =>
        ({ x, y, elevation, action, snapped: false, explicit: true, checkpoint }));
      for (const riderToken of tokensOf(riderActor(), document.parent)) {
        if (moving[riderToken.id] || !path.length) continue;
        riderToken.move(path, {
          method: "api",
          constrainOptions: { ignoreWalls: true, ignoreCost: true },
          autoRotate: false,
          showRuler: false,
          ...internal({ [MODULE_ID]: { follow: true } })
        }).catch(err => fail("наездник не смог последовать за скакуном", err));
      }
      return;
    }

    // Наездника перенесли на скакуна — предложить объединение.
    if (user?.id !== game.user.id || !isRiderToken(document)) return;
    if (pairState()) return debug("перемещение наездника: пара уже", pairState().status);
    if (movement.pending?.waypoints?.length) return debug("перемещение наездника ещё не закончено");
    const scene = document.parent;
    const grid = scene.grid.size;
    const destination = movement.destination;
    const cx = destination.x + (document.width * grid) / 2;
    const cy = destination.y + (document.height * grid) / 2;
    const mounts = tokensOf(mountActor(), scene);
    const onMount = mounts.some(token =>
      cx >= token.x && cx <= token.x + token.width * grid && cy >= token.y && cy <= token.y + token.height * grid);
    debug("перемещение наездника", { center: { x: cx, y: cy }, mounts: mounts.map(token =>
      ({ x: token.x, y: token.y, w: token.width * grid, h: token.height * grid })), onMount });
    if (onMount) askPair(document).catch(err => fail("ошибка посадки", err));
  }

  // --- Аннотация урона (на клиенте, который применяет урон) -----------------

  // Сырые описания урона для dnd5e Actor#applyDamage: options → damages.
  const rawDamageByOptions = new WeakMap();
  let computingCross = false;

  function crossDamage(partner, rawDamages, options) {
    if (!partner || !rawDamages?.length) return null;
    computingCross = true;
    try {
      const result = partner.calculateDamage(foundry.utils.deepClone(rawDamages), { ...options });
      return result ? Math.max(0, Number(result.amount) || 0) : null;
    } catch (err) {
      console.warn(`[${MODULE_ID}] Одно целое | не удалось посчитать урон партнёру`, err);
      return null;
    } finally {
      computingCross = false;
    }
  }

  const partnerOf = role => (role === "rider" ? mountActor() : riderActor());

  const ActorClass = CONFIG.Actor.documentClass;
  const originalApplyDamage = ActorClass.prototype.applyDamage;
  ActorClass.prototype.applyDamage = function (damages, options = {}) {
    if (!computingCross && enabled() && actorRole(this) && pairState()) {
      const raw = Number.isNumeric(damages) ? [{ value: Number(damages) }] : damages;
      if (Array.isArray(raw)) rawDamageByOptions.set(options, foundry.utils.deepClone(raw));
    }
    return originalApplyDamage.call(this, damages, options);
  };

  function onPreApplyDamage(actor, amount, updates, options) {
    const role = actorRole(actor);
    if (!role || !pairState() || !updates) return;
    let annotation = options?.[MODULE_ID]?.[PAIR_FLAG] ?? null;
    if (!annotation && amount > 0) {
      const raw = rawDamageByOptions.get(options);
      annotation = { cross: raw ? crossDamage(partnerOf(role), raw, options) : null, group: null, bothHit: false };
    }
    if (!annotation) return;
    updates[`flags.${MODULE_ID}.${HP_EVENT_FLAG}`] = { ...annotation, id: foundry.utils.randomID() };
  }

  // Midi-QOL: урон по цели уже посчитан со спасброском цели. Здесь же считаем,
  // сколько получил бы партнёр, и отмечаем, задет ли он тем же workflow.
  function onMidiTargetDamage(token, { workflow, damageItem } = {}) {
    const actor = asDoc(token)?.actor;
    const role = actorRole(actor);
    if (!role || !pairState() || !damageItem?.calcDamageOptions || damageItem.wasHit === false) return;
    const partner = partnerOf(role);
    const hitTokens = [...(workflow?.hitTargets ?? []), ...(workflow?.hitTargetsEC ?? [])];
    const bothHit = hitTokens.some(hit => asDoc(hit)?.actorId === partner?.id);
    const options = damageItem.calcDamageOptions;
    const existing = options[MODULE_ID]?.[PAIR_FLAG] ?? {};
    const cross = bothHit ? null : crossDamage(partner, damageItem.rawDamageDetail, {
      ...options,
      [MODULE_ID]: undefined,
      midi: { ...(options.midi ?? {}), targetUuid: tokensOf(partner, asDoc(token)?.parent)[0]?.uuid }
    });
    options[MODULE_ID] = {
      ...(options[MODULE_ID] ?? {}),
      [PAIR_FLAG]: { ...existing, cross, bothHit, group: workflow?.uuid ?? workflow?.id ?? null }
    };
  }

  // Урон применил клиент без механики (например, ГМ для атаки врага). Midi
  // передаёт в опциях обновления атакующего и множитель спасброска, а сами
  // броски урона лежат в последнем чат-сообщении атакующего.
  function crossFromChatMessage(role, options) {
    const midi = options?.midi;
    const sourceId = midi?.sourceActorUuid ? fromUuidSync(midi.sourceActorUuid)?.id : null;
    if (!sourceId) return {};
    const messages = game.messages?.contents ?? [];
    for (let index = messages.length - 1; index >= Math.max(0, messages.length - 20); index -= 1) {
      const message = messages[index];
      if (message.speaker?.actor !== sourceId) continue;
      const raw = (message.rolls ?? [])
        .filter(roll => roll.options?.type && roll.options.type !== "healing" && roll.options.type !== "temphp")
        .map(roll => ({ value: Number(roll.total) || 0, type: roll.options.type, properties: new Set(roll.options.properties ?? []) }));
      if (!raw.length) continue;
      const cross = crossDamage(partnerOf(role), raw, {
        multiplier: options.multiplier ?? 1,
        invertHealing: true,
        midi: { ...midi, targetUuid: undefined }
      });
      debug("урон партнёру по чат-сообщению", { message: message.id, raw, cross });
      return { cross, group: `message:${message.id}` };
    }
    return {};
  }

  // --- Обработчики документов -----------------------------------------------

  let maxRefreshTimer = null;
  function scheduleMaxRefresh() {
    if (!isGM() || !pairActive()) return;
    clearTimeout(maxRefreshTimer);
    maxRefreshTimer = setTimeout(() => enqueue("не удалось обновить максимум хитов", async () => {
      if (!pairActive()) return;
      await syncMaxEffects();
      const max = poolMax();
      const rider = hpOf(riderActor());
      if (Math.max(rider.value, hpOf(mountActor()).value) > max) {
        await writePool({ value: max, temp: poolCache?.temp ?? rider.temp });
      }
    }), 100);
  }

  let lastStatus = pairState()?.status ?? null;

  function onUpdateActor(actor, changes, options) {
    const role = actorRole(actor);
    if (!role) return;

    const status = pairState()?.status ?? null;
    if (role === "rider" && status !== lastStatus) {
      lastStatus = status;
      refreshRiderMeshes();
      Hooks.callAll(CHANGED_HOOK, { active: status === "active", state: pairState(), api });
    }

    if (!isGM() || isInternal(options)) return;
    scheduleMaxRefresh();
    if (!recording) return;
    const hpChanges = changes.system?.attributes?.hp;
    if (!hpChanges || !("value" in hpChanges || "temp" in hpChanges)) return;

    const before = options?.dnd5e?.hp;
    const after = hpOf(actor);
    // Midi передаёт calcDamageOptions в опции обновления, так что аннотация
    // доходит даже если урон применил клиент без этой механики.
    const annotation = changes.flags?.[MODULE_ID]?.[HP_EVENT_FLAG] ?? options?.[MODULE_ID]?.[PAIR_FLAG] ?? null;
    if (!before) {
      // Нет данных «до» — считаем новое значение абсолютным для пула.
      poolCache = { value: after.value, temp: after.temp };
      addEvent({ role, dValue: 0, dTemp: 0, beforeTemp: after.temp });
      return;
    }
    const event = hpEventFromChange({ role, before, after, annotation });
    event.before = { value: Number(before.value) || 0, temp: Number(before.temp) || 0 };
    if (!annotation && event.dValue + event.dTemp < 0) Object.assign(event, crossFromChatMessage(role, options));
    if (event.dValue || event.dTemp) addEvent(event);
  }

  function onEmbeddedChange(document, ...args) {
    const options = args.length >= 3 ? args[1] : args[0];
    if (isInternal(options) || !actorRole(document.parent)) return;
    scheduleMaxRefresh();
  }

  function onTokenCreatedOrDeleted(document) {
    if (!isRiderToken(document) && !isMountToken(document)) return;
    refreshRiderMeshes();
    if (isGM() && pairState()) enqueue("не удалось обновить токены пары", reconcileTokens);
  }

  // --- Восстановление после перезагрузки и миграция с 0.1.x -----------------

  async function cleanupLegacy() {
    let cleaned = 0;
    for (const actor of [riderActor(), mountActor()]) {
      if (!actor) continue;
      const legacy = actor.effects.filter(effect =>
        effect.flags?.[MODULE_ID]?.sharedMaxEffect || effect.flags?.[MODULE_ID]?.mountedReachEffect);
      if (legacy.length) {
        await actor.deleteEmbeddedDocuments("ActiveEffect", legacy.map(effect => effect.id), internal());
        cleaned += legacy.length;
      }
    }
    for (const scene of game.scenes) {
      const updates = [];
      for (const token of scene.tokens) {
        const flags = token.flags?.[MODULE_ID] ?? {};
        const pair = flags.mountedPair;
        const link = flags.mountedRiderLink;
        if (!pair && !link) continue;
        const update = { _id: token.id };
        if (pair) {
          if (pair.visual?.mountTexture) update["texture.src"] = pair.visual.mountTexture;
          const scale = Number(pair.mountScale) > 0 ? Number(pair.mountScale) : 1;
          update["texture.scaleX"] = scale;
          update["texture.scaleY"] = scale;
          update[`flags.${MODULE_ID}.-=mountedPair`] = null;
        }
        if (link) {
          if (link.riderTexture) update["texture.src"] = link.riderTexture;
          update[`flags.${MODULE_ID}.-=mountedRiderLink`] = null;
        }
        updates.push(update);
      }
      if (updates.length) {
        await scene.updateEmbeddedDocuments("Token", updates, internal());
        cleaned += updates.length;
      }
    }
    if (cleaned) {
      log(`удалены остатки версии 0.1.x (${cleaned})`);
      ui.notifications.info("Одно целое: удалены эффекты и флаги старой версии верхового боя. Проверьте текущие хиты наездника и скакуна.");
    }
  }

  async function resyncNow() {
    await cleanupLegacy();
    if (rawPairFlag() && !pairState()) {
      log("удалён повреждённый флаг пары", rawPairFlag());
      await writePairFlag(null);
    }
    const state = pairState();
    if (state?.status === "joining") return finishJoin();
    if (state?.status === "splitting") return finishSplit();
    if (state?.status === "active") {
      recording = true;
      await syncMaxEffects();
      const rider = hpOf(riderActor());
      const mount = hpOf(mountActor());
      const lastPool = state.lastPool;
      if (poolCache) {
        await writePool(poolCache);
      } else if (lastPool) {
        // Изменения, пропущенные пока механика не работала, — как одна пачка:
        // урон по обоим считается одним событием (больший), лечение суммируется.
        const events = [["rider", rider], ["mount", mount]].map(([role, hp]) =>
          hpEventFromChange({ role, before: lastPool, after: hp }));
        const result = resolvePoolBatch({ base: lastPool, events, maxPool: poolMax() });
        if (events.some(event => event.dValue || event.dTemp)) {
          log("восстановлены пропущенные изменения хитов", { lastPool, rider, mount, result });
          ui.notifications.info(`Одно целое: пока механика была выключена, хиты менялись — общий пул пересчитан (${lastPool.value} → ${result.value}).`);
        }
        await writePool(result);
      } else {
        // Пул ещё ни разу не сохранялся (пара из версии без lastPool): берём меньшее.
        if (rider.value !== mount.value || rider.temp !== mount.temp) {
          log("хиты пары расходились, взято меньшее значение", { rider, mount });
        }
        await writePool({ value: Math.min(rider.value, mount.value), temp: Math.min(rider.temp, mount.temp) });
      }
    } else {
      recording = false;
      await removeMaxEffects();
    }
    await reconcileTokens();
    return true;
  }

  // --- Регистрация ----------------------------------------------------------

  on("updateActor", onUpdateActor);
  for (const name of ["createActiveEffect", "updateActiveEffect", "deleteActiveEffect", "createItem", "updateItem", "deleteItem"]) {
    on(name, onEmbeddedChange);
  }
  on("dnd5e.preApplyDamage", onPreApplyDamage);
  on("midi-qol.preTargetDamageApplication", onMidiTargetDamage);
  on("preMoveToken", onPreMoveToken);
  on("moveToken", onMoveToken);
  on("createToken", onTokenCreatedOrDeleted);
  on("deleteToken", onTokenCreatedOrDeleted);
  on("refreshToken", token => { if (token.mesh && shouldHideRiderMesh(token)) token.mesh.alpha = 0; });
  on("canvasReady", () => {
    refreshRiderMeshes();
    if (isGM() && pairState()) enqueue("не удалось обновить токены пары", reconcileTokens);
  });

  const previousQuery = CONFIG.queries[QUERY_NAME];
  CONFIG.queries[QUERY_NAME] = handleQuery;

  function diagnose() {
    const scene = canvas?.scene ?? null;
    const actorInfo = actor => actor && {
      name: actor.name,
      id: actor.id,
      owner: actor.isOwner,
      hp: (({ value, temp, max, tempmax, effectiveMax }) => ({ value, temp, max, tempmax, effectiveMax }))(actor.system.attributes.hp),
      oneWholeEffect: Boolean(actor.effects.get(MAX_EFFECT_ID))
    };
    const tokenInfo = actor => (scene?.tokens ?? []).filter(token => token.actorId === actor?.id).map(token =>
      ({ name: token.name, linked: token.actorLink, x: token.x, y: token.y, size: `${token.width}x${token.height}`, img: token.texture.src }));
    return {
      user: game.user.name,
      writer: isGM(),
      config: readConfig(),
      flag: rawPairFlag(),
      paired: pairActive(),
      scene: scene?.name ?? null,
      rider: actorInfo(riderActor()),
      mount: actorInfo(mountActor()),
      riderTokens: tokenInfo(riderActor()),
      mountTokens: tokenInfo(mountActor())
    };
  }

  // Проверки и досинхронизация при установке и при каждом включении механики:
  // пока она была выключена, хиты пары могли разойтись.
  function start() {
    if (!riderActor() || !mountActor()) {
      ui.notifications.error("Одно целое: не найден Actor наездника или скакуна — проверьте UUID.");
    }
    if (readConfig().authority === "self" && !ownsPair()) {
      ui.notifications.warn("Одно целое: у вас нет прав владельца на наездника и скакуна — механика не сможет записывать изменения.");
    }
    const report = diagnose();
    log(`установлено; пишет ${isGM() ? "этот клиент" : `активный ГМ (${game.users.activeGM?.name ?? "нет"})`}`, report);
    for (const [label, tokens] of [["наездника", report.riderTokens], ["скакуна", report.mountTokens]]) {
      if (!canvas?.scene) break;
      if (!tokens.length) ui.notifications.warn(`Одно целое: на текущей сцене нет токена ${label}.`);
      else if (!tokens.some(token => token.linked)) ui.notifications.warn(`Одно целое: токен ${label} на сцене не привязан к актёру.`);
    }
    if (isGM()) runAction("resync");
  }

  if (enabled()) start();
  else log("установлено, но выключено в настройках");
  refreshRiderMeshes();

  const api = {
    get config() { return readConfig(); },
    riderActor,
    mountActor,
    get enabled() { return enabled(); },
    isPaired: () => enabled() && pairActive(),
    pairState,
    pair: () => requestAction("pair"),
    unpair: () => requestAction("unpair"),
    resync: () => requestAction("resync"),
    /** Состояние механики для отладки: copy(JSON.stringify(NazgobOneWhole.diagnose(), null, 1)) */
    diagnose,
    /** Вызывается после включения/выключения механики в настройках. */
    enabledChanged() {
      lastStatus = pairState()?.status ?? null;
      if (enabled()) start();
      else {
        // Без кэша пула resync при включении пересчитает пропущенное по lastPool.
        clearTimeout(batchTimer);
        clearTimeout(maxRefreshTimer);
        batchTimer = null;
        pendingEvents = [];
        poolCache = null;
      }
      refreshRiderMeshes();
    },
    /** Совместимость с остальными верховыми механиками модуля. */
    getPairFromToken(token) {
      const doc = asDoc(token);
      if (!enabled() || !pairActive() || !doc?.parent || (!isRiderToken(doc) && !isMountToken(doc))) return null;
      const riderToken = tokensOf(riderActor(), doc.parent)[0];
      const mountToken = tokensOf(mountActor(), doc.parent)[0];
      if (!riderToken || !mountToken) return null;
      return {
        state: {
          pairId: PAIR_FLAG,
          poolActive: true,
          tearingDown: false,
          riderTokenUuid: riderToken.uuid,
          mountTokenUuid: mountToken.uuid
        },
        riderToken,
        mountToken
      };
    },
    uninstall() {
      for (const [name, id] of hookIds) Hooks.off(name, id);
      hookIds.length = 0;
      clearTimeout(batchTimer);
      clearTimeout(maxRefreshTimer);
      ActorClass.prototype.applyDamage = originalApplyDamage;
      if (previousQuery) CONFIG.queries[QUERY_NAME] = previousQuery;
      else delete CONFIG.queries[QUERY_NAME];
      refreshRiderMeshes();
    }
  };
  return api;
}
