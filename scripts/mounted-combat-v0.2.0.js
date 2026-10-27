import { ONE_WHOLE_FLAG, installOneWhole } from "./one-whole-v0.2.0.js";
import { FEATURE_TOGGLED_HOOK, MODULE_ID, isFeatureEnabled } from "./features-v0.2.0.js";

export { MODULE_ID };

export const MOUNTED_COMBAT_CONFIG = Object.freeze({
  woundClosureItemName: "Медальон затягивающихся ран"
});

const SIZE_RANKS = new Map([
  ["tiny", 0],
  ["sm", 1], ["small", 1],
  ["med", 2], ["medium", 2],
  ["lg", 3], ["large", 3],
  ["huge", 4],
  ["grg", 5], ["gargantuan", 5]
]);

export function sizeRank(size) {
  return SIZE_RANKS.get(String(size ?? "").toLowerCase()) ?? -1;
}

function isInternal(options) {
  return Boolean(options?.[MODULE_ID]?.internal);
}

function internalOptions(extra = {}) {
  return { ...extra, [MODULE_ID]: { ...(extra?.[MODULE_ID] ?? {}), internal: true } };
}

function error(message, err) {
  console.error(`[${MODULE_ID}] ${message}`, err);
  globalThis.ui?.notifications?.error?.(`${message}${err?.message ? `: ${err.message}` : ""}`);
}

function asTokenDocument(token) {
  return token?.document ?? token ?? null;
}

// ---------------------------------------------------------------------------
// «Одно целое»: настройки и установка ядра (scripts/one-whole-v0.2.0.js)
// ---------------------------------------------------------------------------

let oneWhole = null;

const ONE_WHOLE_DEFAULT_IMAGE = "assets/Characters/%D0%9F%D0%B5%D1%80%D1%81%D0%BE%D0%BD%D0%B0%D0%B6%D0%B8%20%D0%B8%D0%B3%D1%80%D0%BE%D0%BA%D0%BE%D0%B2/%D0%92%D0%B8%D0%BA%D1%82%D0%BE%D1%80%20%D0%BD%D0%B0%20%D0%96%D0%BE%D1%80%D0%B8%D0%BA%D0%B5.webp";

/** Пара, в которой состоит токен, или null (см. installOneWhole().getPairFromToken). */
export function getPairFromToken(token) {
  return oneWhole?.getPairFromToken(token) ?? null;
}

function registerOneWholeSettings() {
  const resync = () => { if (game.ready && game.user.isActiveGM) oneWhole?.resync(); };
  const settings = [
    ["oneWholeRiderUuid", { name: "Одно целое: UUID наездника", type: String, default: "Actor.mOmeXQtCSMIDWYYl" }],
    ["oneWholeMountUuid", { name: "Одно целое: UUID скакуна", type: String, default: "Actor.F4SsuskhKj3OA2f2" }],
    ["oneWholeMountedImage", {
      name: "Одно целое: изображение пары",
      hint: "Изображение токена скакуна, пока на нём сидит наездник. Исходное изображение сохраняется во флаге токена и возвращается при спешивании.",
      type: String,
      default: ONE_WHOLE_DEFAULT_IMAGE,
      filePicker: "imagevideo"
    }],
    ["oneWholeMountedScale", {
      name: "Одно целое: масштаб изображения пары",
      type: Number,
      default: 1
    }]
  ];
  for (const [key, data] of settings) {
    game.settings.register(MODULE_ID, key, {
      hint: "Перед изменением UUID спешьте наездника.",
      scope: "world",
      config: true,
      onChange: resync,
      ...data
    });
  }
}

function oneWholeConfig() {
  return {
    riderUuid: game.settings.get(MODULE_ID, "oneWholeRiderUuid"),
    mountUuid: game.settings.get(MODULE_ID, "oneWholeMountUuid"),
    mountedImage: game.settings.get(MODULE_ID, "oneWholeMountedImage"),
    mountedScale: game.settings.get(MODULE_ID, "oneWholeMountedScale"),
    enabled: isFeatureEnabled("oneWhole")
  };
}

// ---------------------------------------------------------------------------
// Медальон затягивающихся ран и max-heal для Костей хитов
// ---------------------------------------------------------------------------

export function hasEquippedWoundClosureMedallion(actor) {
  const items = actor?.items;
  const medallion = items?.find?.(item => item?.name === MOUNTED_COMBAT_CONFIG.woundClosureItemName);
  return Boolean(medallion?.system?.equipped);
}

export function hasMaxHealingDiceGrant(actor) {
  const getProperty = globalThis.foundry?.utils?.getProperty;
  const value = getProperty?.(actor, "flags.midi-qol.grants.max.damage.heal")
    ?? actor?.flags?.["midi-qol"]?.grants?.max?.damage?.heal;
  return value === true || value === "true" || value === 1 || value === "1";
}

/**
 * D&D5e constructs Hit Die BasicRoll instances before evaluating them and fires
 * dnd5e.postHitDieRollConfiguration at that point. Midi-QOL's max-healing grant
 * does not affect this native Hit Die workflow, so mirror that grant here by
 * forcing every DiceTerm in the Hit Die roll to its maximum face. Fixed bonuses
 * such as Constitution remain untouched.
 */
export function maximizeHitDieRollsIfGranted(rolls, { subject } = {}) {
  if (!hasMaxHealingDiceGrant(subject)) return;

  for (const roll of (Array.isArray(rolls) ? rolls : [rolls])) {
    let changed = false;
    for (const die of (roll?.dice ?? [])) {
      const faces = Number(die?.faces);
      if (!Number.isInteger(faces) || faces <= 0 || !Array.isArray(die?.modifiers)) continue;
      const modifier = `min${faces}`;
      if (die.modifiers.includes(modifier)) continue;
      die.modifiers.push(modifier);
      changed = true;
    }
    if (changed) roll?.resetFormula?.();
  }
}

/**
 * D&D5e 5.2.x fires dnd5e.rollHitDie after evaluating the roll but before applying HP updates.
 * By this point maximizeHitDieRollsIfGranted has already mirrored Midi-QOL's max-healing grant for native Hit Dice.
 * The medallion therefore only doubles the final hit-die roll total and replaces the pending HP update.
 */
export function handleWoundClosureHitDie(rolls, { subject, updates } = {}) {
  const hpPath = "system.attributes.hp.value";
  if (!subject || !updates?.actor || !Object.prototype.hasOwnProperty.call(updates.actor, hpPath)) return;
  if (!hasEquippedWoundClosureMedallion(subject)) return;

  const hp = subject.system?.attributes?.hp;
  const currentHp = Number(hp?.value);
  const effectiveMax = Number(hp?.effectiveMax ?? hp?.max);
  if (!Number.isFinite(currentHp) || !Number.isFinite(effectiveMax)) return;

  const rollTotal = (Array.isArray(rolls) ? rolls : [rolls])
    .reduce((total, roll) => total + (Number(roll?.total) || 0), 0);
  const missingHp = Math.max(0, effectiveMax - currentHp);
  const healing = Math.min(missingHp, Math.max(0, rollTotal) * 2);
  updates.actor[hpPath] = currentHp + healing;
}

// ---------------------------------------------------------------------------
// Max-heal при одновременном лечении всадника и скакуна
// ---------------------------------------------------------------------------

export function planMixedTargetMaxHealing({ actionType, targets = [], pairResolver }) {
  const inactive = { active: false, orderedTargets: [...targets], pairIds: [], maxTargetUuids: [] };
  if (String(actionType ?? "").toLowerCase() !== "heal") return inactive;

  const tokenDocs = [...targets].map(asTokenDocument).filter(Boolean);
  const targetUuids = new Set(tokenDocs.map(token => token.uuid).filter(Boolean));
  const affectedPairs = new Map();

  for (const tokenDoc of tokenDocs) {
    const state = pairResolver?.(tokenDoc)?.state;
    if (!state?.poolActive || !state.pairId) continue;
    if (!targetUuids.has(state.riderTokenUuid) || !targetUuids.has(state.mountTokenUuid)) continue;
    const riderToken = tokenDocs.find(token => token.uuid === state.riderTokenUuid);
    const mountToken = tokenDocs.find(token => token.uuid === state.mountTokenUuid);
    if (!riderToken || !mountToken) continue;
    if (hasMaxHealingDiceGrant(riderToken.actor) === hasMaxHealingDiceGrant(mountToken.actor)) continue;
    affectedPairs.set(state.pairId, state);
  }
  if (!affectedPairs.size) return inactive;

  const affectedTokenUuids = new Set();
  for (const state of affectedPairs.values()) {
    affectedTokenUuids.add(state.riderTokenUuid);
    affectedTokenUuids.add(state.mountTokenUuid);
  }

  // Reordering the workflow forces Midi-QOL to make a normal shared roll.
  // Do not do that if an unrelated target also grants max healing: this module only
  // corrects the mounted pair and must not silently change another creature's healing.
  if (tokenDocs.some(token => hasMaxHealingDiceGrant(token.actor) && !affectedTokenUuids.has(token.uuid))) {
    return inactive;
  }

  return {
    active: true,
    orderedTargets: orderTargetsNonMaxFirst(targets),
    pairIds: [...affectedPairs.keys()],
    maxTargetUuids: tokenDocs
      .filter(token => affectedTokenUuids.has(token.uuid) && hasMaxHealingDiceGrant(token.actor))
      .map(token => token.uuid)
  };
}

const midiMixedHealingContexts = new WeakMap();

function replaceSetOrder(set, orderedValues) {
  if (!set?.clear || !set?.add) return false;
  set.clear();
  for (const value of orderedValues) set.add(value);
  return true;
}

function orderTargetsNonMaxFirst(targets = []) {
  return [...targets].sort((a, b) => {
    const aMax = hasMaxHealingDiceGrant(asTokenDocument(a)?.actor) ? 1 : 0;
    const bMax = hasMaxHealingDiceGrant(asTokenDocument(b)?.actor) ? 1 : 0;
    return aMax - bMax;
  });
}

export function prepareMixedTargetMaxHealing(workflow, pairResolver = getPairFromToken) {
  if (!workflow || !workflow.targets) return false;
  const originalTargets = [...workflow.targets];
  const originalHitTargets = workflow.hitTargets ? [...workflow.hitTargets] : null;
  const plan = planMixedTargetMaxHealing({
    actionType: workflow?.activity?.actionType ?? workflow?.item?.system?.actionType,
    targets: originalTargets,
    pairResolver
  });
  if (!plan.active) return false;

  midiMixedHealingContexts.set(workflow, { ...plan, originalTargets, originalHitTargets, rolledTotal: null, maxTotal: null });
  replaceSetOrder(workflow.targets, plan.orderedTargets);
  if (workflow.hitTargets && originalHitTargets) {
    replaceSetOrder(workflow.hitTargets, orderTargetsNonMaxFirst(originalHitTargets));
  }
  return true;
}

function workflowDamageRolls(workflow) {
  if (Array.isArray(workflow?.damageRolls)) return workflow.damageRolls.filter(Boolean);
  if (workflow?.damageRolls && Symbol.iterator in Object(workflow.damageRolls)) return [...workflow.damageRolls].filter(Boolean);
  if (workflow?.damageRoll) return [workflow.damageRoll];
  return [];
}

async function maximizeExistingRollTotal(roll) {
  const formula = roll?.formula;
  if (!formula) return Number(roll?.total) || 0;
  const RollClass = globalThis.Roll ?? roll?.constructor;
  if (typeof RollClass !== "function") return Number(roll?.total) || 0;
  try {
    const clone = new RollClass(formula, roll?.data ?? {}, { ...(roll?.options ?? {}) });
    const evaluated = clone.evaluate
      ? await clone.evaluate({ maximize: true })
      : await clone.roll?.({ maximize: true });
    return Number(evaluated?.total ?? clone.total) || 0;
  } catch (err) {
    error("Не удалось вычислить максимальное лечение для смешанной верховой пары", err);
    return Number(roll?.total) || 0;
  }
}

function restoreMixedTargetOrder(workflow) {
  const context = midiMixedHealingContexts.get(workflow);
  if (!context) return;
  replaceSetOrder(workflow?.targets, context.originalTargets);
  if (workflow?.hitTargets && context.originalHitTargets) replaceSetOrder(workflow.hitTargets, context.originalHitTargets);
}

export async function captureMixedTargetMaxHealingRoll(workflow) {
  const context = midiMixedHealingContexts.get(workflow);
  if (!context || context.rolledTotal !== null) return false;

  // Midi has already decided whether to maximize by this stage, so both target
  // sets can be restored immediately. Midi v13 checks hitTargets before targets.
  restoreMixedTargetOrder(workflow);

  const rolls = workflowDamageRolls(workflow);
  context.rolledTotal = rolls.reduce((sum, roll) => sum + (Number(roll?.total) || 0), 0);
  let maxTotal = 0;
  for (const roll of rolls) maxTotal += await maximizeExistingRollTotal(roll);
  context.maxTotal = maxTotal;
  return true;
}

/**
 * Для цели с max-heal общий пул получает лечение, увеличенное в
 * maxTotal / rolledTotal раз. «Одно целое» применяет этот множитель при сведении
 * событий ХП (healScale в аннотации урона).
 */
export function annotateMixedTargetHealing(token, { workflow, damageItem } = {}) {
  const context = midiMixedHealingContexts.get(workflow);
  const tokenUuid = asTokenDocument(token)?.uuid;
  const options = damageItem?.calcDamageOptions;
  if (!context || !options || !context.maxTargetUuids.includes(tokenUuid)) return false;
  const rolled = Number(context.rolledTotal) || 0;
  const maximum = Number(context.maxTotal) || 0;
  if (maximum <= rolled) return false;
  const healScale = rolled > 0 ? maximum / rolled : maximum;
  const existing = options[MODULE_ID]?.[ONE_WHOLE_FLAG] ?? {};
  options[MODULE_ID] = { ...(options[MODULE_ID] ?? {}), [ONE_WHOLE_FLAG]: { ...existing, healScale } };
  return true;
}

function clearMixedTargetMaxHealing(workflow) {
  restoreMixedTargetOrder(workflow);
  midiMixedHealingContexts.delete(workflow);
}

// ---------------------------------------------------------------------------
// Досягаемость, «Угроза малым» и ауры верхом
// ---------------------------------------------------------------------------

const REACH_EFFECT_ID = "nazgobMountReach";
const REACH_EFFECT_FLAG = "oneWholeReach";
const REACH_EFFECT_NAME = "Верховой боец — досягаемость от скакуна";

export function buildMountedReachEffectData({
  riderActorId,
  customMode = globalThis.CONST?.ACTIVE_EFFECT_MODES?.CUSTOM ?? 0
}) {
  const safeRiderActorId = JSON.stringify(String(riderActorId ?? ""));
  const value = `activity.actor && activity.actor.id === ${safeRiderActorId}`;
  return {
    name: REACH_EFFECT_NAME,
    img: "icons/environment/people/cavalry.webp",
    disabled: false,
    transfer: false,
    changes: ["mwak", "msak"].map(actionType => ({
      key: `flags.midi-qol.rangeOverride.attack.${actionType}`,
      mode: customMode,
      value,
      priority: 20
    })),
    flags: { [MODULE_ID]: { [REACH_EFFECT_FLAG]: true } }
  };
}

// Midi-QOL's rangeOverride lets melee attacks use the full mount footprint as
// an alternative origin without changing either token's size. Fixed _id: no duplicates.
// Эффект — постоянные данные, поэтому выключение функции его снимает.
async function syncMountedReachEffects() {
  if (!game.user.isActiveGM) return;
  const active = Boolean(oneWhole?.isPaired()) && isFeatureEnabled("mountedReach");
  const rider = oneWhole?.riderActor();
  const mount = oneWhole?.mountActor();
  if (!rider || !mount) return;
  for (const actor of [rider, mount]) {
    const existing = actor.effects.get(REACH_EFFECT_ID);
    if (!active) {
      if (existing) await actor.deleteEmbeddedDocuments("ActiveEffect", [REACH_EFFECT_ID], internalOptions());
      continue;
    }
    const data = buildMountedReachEffectData({ riderActorId: rider.id });
    if (existing) {
      const same = JSON.stringify(existing.changes) === JSON.stringify(data.changes) && !existing.disabled;
      if (!same) await existing.update({ disabled: false, changes: data.changes }, internalOptions());
    } else {
      await actor.createEmbeddedDocuments("ActiveEffect", [{ _id: REACH_EFFECT_ID, ...data }], internalOptions({ keepId: true }))
        .catch(err => { if (!actor.effects.get(REACH_EFFECT_ID)) throw err; });
    }
  }
}

export function shouldGrantSmallThreat({ poolActive, actionType, mountSize, targetSize, targetIsMounted }) {
  if (!poolActive || String(actionType ?? "").toLowerCase() !== "mwak" || targetIsMounted) return false;
  const mountRank = sizeRank(mountSize);
  const targetRank = sizeRank(targetSize);
  return mountRank >= 0 && targetRank >= 0 && targetRank < mountRank;
}

function isPhysicallyMountedRider(tokenDoc) {
  const pair = getPairFromToken(tokenDoc);
  return Boolean(pair && tokenDoc?.uuid === pair.state.riderTokenUuid);
}

export function handleSmallThreatPreAttackConfig(workflow) {
  const riderToken = asTokenDocument(workflow?.token);
  if (!riderToken) return false;
  const pair = getPairFromToken(riderToken);
  if (!pair || riderToken.uuid !== pair.state.riderTokenUuid) return false;

  const targets = [...(workflow?.targets ?? [])].map(asTokenDocument).filter(Boolean);
  if (targets.length !== 1) return false;
  const target = targets[0];

  const qualifies = shouldGrantSmallThreat({
    poolActive: Boolean(pair.state.poolActive),
    actionType: workflow?.activity?.actionType ?? workflow?.item?.system?.actionType,
    mountSize: pair.mountToken?.actor?.system?.traits?.size,
    targetSize: target.actor?.system?.traits?.size,
    targetIsMounted: isPhysicallyMountedRider(target)
  });
  if (!qualifies) return false;

  const tracker = workflow?.tracker ?? workflow?.attackRollModifierTracker;
  if (!tracker?.advantage?.add) return false;
  tracker.advantage.add(`${MODULE_ID}.mounted-combat.small-threat`, "Верховой боец: Угроза малым");
  return true;
}

export function effectiveAuraFootprintToken(sourceToken, pairResolver = getPairFromToken) {
  if (!sourceToken) return sourceToken;
  const pair = pairResolver?.(sourceToken);
  if (!pair?.mountToken || sourceToken.uuid !== pair.state?.riderTokenUuid) return sourceToken;
  return pair.mountToken;
}

function auraEffectsIsActive() {
  return Boolean(globalThis.game?.modules?.get?.("auraeffects")?.active);
}

let auraEffectsHelpersPromise = null;

async function loadAuraEffectsHelpers() {
  if (!auraEffectsIsActive()) return null;
  auraEffectsHelpersPromise ??= import("../../auraeffects/scripts/helpers.mjs")
    .then(module => {
      const required = ["getAllAuraEffects", "getNearbyTokens", "executeScript", "removeAndReplaceAuras"];
      if (!required.every(key => typeof module?.[key] === "function")) {
        throw new Error("Неподдерживаемая версия Aura Effects: отсутствует API ветки 1.x");
      }
      return module;
    })
    .catch(err => {
      auraEffectsHelpersPromise = null;
      console.warn(`[${MODULE_ID}] Не удалось загрузить интеграцию Aura Effects 1.x`, err);
      return null;
    });
  return auraEffectsHelpersPromise;
}

function auraChildSourceUuid(effect) {
  const fromAura = effect?.getFlag?.("auraeffects", "fromAura") ?? effect?.flags?.auraeffects?.fromAura ?? null;
  // Aura Effects 1.x may still have legacy boolean-style fromAura flags.
  // In that form the actual source UUID lives in origin.
  if (fromAura === true) return effect?.origin ?? null;
  return fromAura ?? effect?.origin ?? null;
}

function auraDispositionAllows(riderToken, targetToken, effect) {
  const wanted = Number(effect?.system?.disposition) || 0;
  if (wanted === 0) return true;
  return (Number(riderToken?.disposition) || 0) * (Number(targetToken?.disposition) || 0) === wanted;
}

function sceneActorsByUuid(scene) {
  const actors = new Map();
  for (const token of scene?.tokens ?? []) {
    if (token?.actor?.uuid) actors.set(token.actor.uuid, token.actor);
  }
  return actors;
}

/**
 * Reconciles Aura Effects 1.x child effects for a mounted rider.
 * Aura Effects itself still owns/evaluates the source aura. We only change
 * geometry by asking its own helpers for nearby tokens using the mount as the
 * measuring token, while scripts and source data continue to use the rider.
 */
export async function reconcileMountedAuraPair(pair, {
  helpers = null,
  activeGM = globalThis.game?.users?.activeGM ?? null,
  footprintToken = null
} = {}) {
  if (!pair?.riderToken?.actor || !pair?.mountToken || !activeGM?.query) return false;
  helpers ??= await loadAuraEffectsHelpers();
  if (!helpers) return false;

  const riderToken = pair.riderToken;
  const scene = riderToken.parent ?? pair.mountToken.parent;
  if (!scene) return false;
  footprintToken ??= effectiveAuraFootprintToken(riderToken, () => pair) ?? riderToken;

  const [activeSourceEffects = [], inactiveSourceEffects = []] = helpers.getAllAuraEffects(riderToken.actor) ?? [];
  const activeUuids = new Set(activeSourceEffects.map(effect => effect.uuid));
  const allSourceEffects = [...activeSourceEffects, ...inactiveSourceEffects];
  if (!allSourceEffects.length) return true;

  const sceneActors = sceneActorsByUuid(scene);
  const toRemove = new Map();
  const toApply = {};

  for (const sourceEffect of allSourceEffects) {
    const desiredActorUuids = new Set();

    if (activeUuids.has(sourceEffect.uuid)) {
      const radius = Number(sourceEffect.system?.distance) || 0;
      if (radius > 0) {
        const nearbyTokens = helpers.getNearbyTokens(footprintToken, radius, {
          disposition: 0,
          collisionTypes: sourceEffect.system?.collisionTypes ?? []
        }) ?? [];

        for (const targetToken of nearbyTokens) {
          const targetActor = targetToken?.actor;
          if (!targetActor?.uuid || targetActor === riderToken.actor) continue;
          if (!auraDispositionAllows(riderToken, targetToken, sourceEffect)) continue;
          if (!helpers.executeScript(riderToken, targetToken, sourceEffect)) continue;
          desiredActorUuids.add(targetActor.uuid);
        }
      }
    }

    for (const actor of sceneActors.values()) {
      const matchingChildren = [...(actor.effects ?? [])].filter(effect => auraChildSourceUuid(effect) === sourceEffect.uuid);
      if (!desiredActorUuids.has(actor.uuid)) {
        for (const child of matchingChildren) if (child?.uuid) toRemove.set(child.uuid, child);
        continue;
      }
      if (!matchingChildren.length) (toApply[actor.uuid] ??= []).push(sourceEffect.uuid);
    }
  }

  if (toRemove.size) await helpers.removeAndReplaceAuras([...toRemove.values()], scene);
  if (Object.keys(toApply).length) await activeGM.query("auraeffects.applyAuraEffects", toApply);
  return true;
}

/** Пара токенов наездника и скакуна на сцене — даже если пара разъединена. */
function scenePairTokens(scene) {
  const rider = oneWhole?.riderActor();
  const mount = oneWhole?.mountActor();
  const find = actor => actor ? scene?.tokens?.find(token => token.actorLink && token.actorId === actor.id) : null;
  const riderToken = find(rider);
  const mountToken = find(mount);
  return riderToken && mountToken ? { riderToken, mountToken, state: {} } : null;
}

export async function reconcileAllMountedAuras() {
  if (!auraEffectsIsActive() || !globalThis.canvas?.ready || !canvas.scene) return 0;
  if (!globalThis.game?.user?.isActiveGM) return 0;
  const helpers = await loadAuraEffectsHelpers();
  const activeGM = game.users?.activeGM;
  const tokens = scenePairTokens(canvas.scene);
  if (!helpers || !activeGM || !tokens) return 0;
  // Пока наездник верхом, дальность аур считается от скакуна; иначе — от наездника.
  // Выключенная функция тоже доходит сюда один раз, чтобы вернуть ауры к наезднику.
  const pair = isFeatureEnabled("mountedAuras") ? getPairFromToken(tokens.riderToken) : null;
  const footprintToken = pair ? pair.mountToken : tokens.riderToken;
  await reconcileMountedAuraPair(pair ?? tokens, { helpers, activeGM, footprintToken });
  return 1;
}

let mountedAuraReconcileTimer = null;
let mountedAuraReconcileRunning = false;
let mountedAuraReconcileAgain = false;

function scheduleMountedAuraReconciliation(delay = 40) {
  if (!auraEffectsIsActive() || !globalThis.game?.user?.isActiveGM) return;
  if (mountedAuraReconcileRunning) {
    mountedAuraReconcileAgain = true;
    return;
  }
  if (mountedAuraReconcileTimer) clearTimeout(mountedAuraReconcileTimer);
  mountedAuraReconcileTimer = setTimeout(async () => {
    mountedAuraReconcileTimer = null;
    mountedAuraReconcileRunning = true;
    try {
      await reconcileAllMountedAuras();
    } catch (err) {
      error("Ошибка пересчёта верховых аур", err);
    } finally {
      mountedAuraReconcileRunning = false;
      if (mountedAuraReconcileAgain) {
        mountedAuraReconcileAgain = false;
        scheduleMountedAuraReconciliation(delay);
      }
    }
  }, delay);
}

function scheduleMountedAuraAfterMovement(token) {
  const animation = token?.object?.movementAnimationPromise;
  if (animation?.then) Promise.resolve(animation).finally(() => scheduleMountedAuraReconciliation());
  else scheduleMountedAuraReconciliation();
}

export function registerAuraEffectsHooks(hooks = globalThis.Hooks) {
  if (!hooks?.on) return;
  hooks.on("moveToken", token => {
    if (isFeatureEnabled("mountedAuras")) scheduleMountedAuraAfterMovement(token);
  });
  for (const name of ["updateToken", "createToken", "deleteToken", "createActiveEffect", "updateActiveEffect",
    "deleteActiveEffect", "updateActor", "updateCombat", "createCombatant", "deleteCombatant"]) {
    hooks.on(name, () => {
      if (isFeatureEnabled("mountedAuras")) scheduleMountedAuraReconciliation();
    });
  }
}

// ---------------------------------------------------------------------------
// Свойства оружия Ребреи (rebreya-main): «Верховой бой» и «Наскок»
// ---------------------------------------------------------------------------
// Свойства — ключи system.properties, которые регистрирует ребрея:
// lchMounted («Верховой бой»: +2 урона, если цель меньше вашего скакуна) и
// lchDash («Наскок»: доп. урон после прямого разбега от 10 футов к цели).
// Кости наскока — flags.rebreya-main.lichWeaponPropertyValues.dashDice.
// Ограничения на вид атаки в правилах нет: «Верховой бой» есть и у луков,
// и у огнестрела (Лук всадника, Драгун).

const mountedWeaponMovementByActor = new Map();
const mountedWeaponChargeUsedByActor = new Map();
const mountedWeaponProcessedWorkflows = new WeakSet();

function itemHasSystemProperty(item, propertyId) {
  const properties = item?.system?.properties;
  if (typeof properties?.has === "function") return properties.has(propertyId);
  if (Array.isArray(properties)) return properties.includes(propertyId);
  return Boolean(properties?.[propertyId]);
}

function mountedWeaponChargeFormula(item) {
  if (!itemHasSystemProperty(item, "lchDash")) return null;
  const raw = item?.flags?.["rebreya-main"]?.lichWeaponPropertyValues?.dashDice;
  // В листе ребреи кости можно ввести по-русски: «1к2».
  const formula = String(raw ?? "").trim().replace(/(\d)\s*[кК]\s*(\d)/gu, "$1d$2");
  return formula || null;
}

export function mountedWeaponProfile(item) {
  if (!item || typeof item !== "object") return null;
  const mountedBonus = itemHasSystemProperty(item, "lchMounted") ? 2 : 0;
  const charge = mountedWeaponChargeFormula(item);
  return mountedBonus || charge ? { mountedBonus, charge } : null;
}

export function shouldGrantMountedWeaponBonus({ physicallyMounted, mountSize, targetSize }) {
  if (!physicallyMounted) return false;
  const mountRank = sizeRank(mountSize);
  const targetRank = sizeRank(targetSize);
  return mountRank >= 0 && targetRank >= 0 && targetRank < mountRank;
}

export function combatTurnKey(combat) {
  if (!combat || combat.started === false || combat.round == null || combat.turn == null) return null;
  const round = Number(combat.round);
  const turn = Number(combat.turn);
  if (!combat.id || !Number.isInteger(round) || round < 1 || !Number.isInteger(turn) || turn < 0) return null;
  return `${combat.id}:${round}:${turn}`;
}

function pointXY(point) {
  if (!point) return null;
  const x = Number(point.x);
  const y = Number(point.y);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

function pointsEqual(a, b, tolerance = 0.01) {
  return Boolean(a && b)
    && Math.abs(Number(a.x) - Number(b.x)) <= tolerance
    && Math.abs(Number(a.y) - Number(b.y)) <= tolerance;
}

function segmentVector(segment) {
  if (!segment?.start || !segment?.end) return { x: 0, y: 0 };
  return {
    x: Number(segment.end.x) - Number(segment.start.x),
    y: Number(segment.end.y) - Number(segment.start.y)
  };
}

function sameForwardDirection(a, b) {
  const va = segmentVector(a);
  const vb = segmentVector(b);
  const la = Math.hypot(va.x, va.y);
  const lb = Math.hypot(vb.x, vb.y);
  if (la <= 0.001 || lb <= 0.001) return false;
  const cross = Math.abs((va.x * vb.y) - (va.y * vb.x));
  const tolerance = Math.max(0.01, la * lb * 1e-6);
  const dot = (va.x * vb.x) + (va.y * vb.y);
  return cross <= tolerance && dot > 0;
}

export function lastStraightSegment(points = []) {
  const clean = [];
  for (const raw of points) {
    const point = pointXY(raw);
    if (!point || pointsEqual(clean.at(-1), point)) continue;
    clean.push(point);
  }
  if (clean.length < 2) return null;

  let startIndex = clean.length - 2;
  const last = { start: clean.at(-2), end: clean.at(-1) };
  for (let index = clean.length - 3; index >= 0; index -= 1) {
    const previous = { start: clean[index], end: clean[index + 1] };
    if (!sameForwardDirection(previous, last)) break;
    startIndex = index;
  }
  return { start: clean[startIndex], end: clean.at(-1) };
}

export function mergeStraightSegments(previous, next) {
  if (!next) return previous ?? null;
  if (!previous) return next;
  if (!pointsEqual(previous.end, next.start) || !sameForwardDirection(previous, next)) return next;
  return { start: previous.start, end: next.end };
}

function pointDistance(a, b) {
  return Math.hypot(Number(a?.x) - Number(b?.x), Number(a?.y) - Number(b?.y));
}

export function segmentMovesTowardTarget(segment, targetPoint) {
  if (!segment?.start || !segment?.end || !targetPoint) return false;
  return pointDistance(segment.end, targetPoint) + 0.01 < pointDistance(segment.start, targetPoint);
}

// Атаки оружием в Midi; fwak — огнестрел ребреи.
const WEAPON_ATTACK_TYPES = new Set(["mwak", "rwak", "fwak"]);

export function planMountedWeaponDamage({
  item,
  actionType,
  physicallyMounted,
  mountSize,
  targetSize,
  inCombat,
  chargeUsed,
  chargeDistance,
  movedTowardTarget
}) {
  const profile = mountedWeaponProfile(item);
  if (!profile || !WEAPON_ATTACK_TYPES.has(String(actionType ?? "").toLowerCase())) {
    return { formula: null, mountedBonus: 0, chargeFormula: null, consumeCharge: false };
  }

  const mountedBonus = shouldGrantMountedWeaponBonus({ physicallyMounted, mountSize, targetSize })
    ? profile.mountedBonus
    : 0;
  const chargeFormula = inCombat && !chargeUsed && Number(chargeDistance) >= 10 && movedTowardTarget
    ? profile.charge
    : null;
  const parts = [];
  if (mountedBonus) parts.push(String(mountedBonus));
  if (chargeFormula) parts.push(chargeFormula);
  return {
    formula: parts.length ? parts.join(" + ") : null,
    mountedBonus,
    chargeFormula,
    consumeCharge: Boolean(chargeFormula)
  };
}

function movementPointToCenter(point, tokenDoc) {
  const gridSize = globalThis.canvas?.grid?.size ?? globalThis.canvas?.dimensions?.size ?? 100;
  const xy = pointXY(point);
  if (!xy) return null;
  const width = Number(point?.width ?? tokenDoc?.width) || 1;
  const height = Number(point?.height ?? tokenDoc?.height) || 1;
  return { x: xy.x + ((width * gridSize) / 2), y: xy.y + ((height * gridSize) / 2) };
}

function movementStraightSegment(document, movement) {
  const rawPoints = [movement?.origin, ...(movement?.passed?.waypoints ?? []), movement?.destination];
  const centers = rawPoints.map(point => movementPointToCenter(point, document)).filter(Boolean);
  return lastStraightSegment(centers);
}

function measureStraightSegmentDistance(segment, scene = globalThis.canvas?.scene) {
  if (!segment) return 0;
  try {
    const measured = scene?.grid?.measurePath?.([segment.start, segment.end]);
    const distance = Number(measured?.distance);
    if (Number.isFinite(distance)) return Math.max(0, distance);
  } catch (err) {
    console.warn(`[${MODULE_ID}] Не удалось измерить прямой отрезок Наскока через grid.measurePath`, err);
  }
  const gridSize = Number(globalThis.canvas?.grid?.size ?? globalThis.canvas?.dimensions?.size) || 100;
  const gridDistance = Number(scene?.grid?.distance ?? globalThis.canvas?.dimensions?.distance) || 5;
  return pointDistance(segment.start, segment.end) * (gridDistance / gridSize);
}

function tokenCenterPoint(tokenDoc) {
  const objectCenter = tokenDoc?.object?.center;
  if (objectCenter && Number.isFinite(Number(objectCenter.x)) && Number.isFinite(Number(objectCenter.y))) {
    return { x: Number(objectCenter.x), y: Number(objectCenter.y) };
  }
  return movementPointToCenter(tokenDoc, tokenDoc);
}

function logicalMovementActor(document) {
  const pair = getPairFromToken(document);
  if (!pair) return document?.actor ?? null;
  // Движение скакуна — это движение всадника. Собственные перемещения всадника
  // верхом либо отменяются диалогом спешивания, либо являются внутренним следованием.
  if (document.uuid === pair.state.mountTokenUuid) return pair.riderToken?.actor ?? null;
  return null;
}

export function recordMountedWeaponMovement(document, movement, operation, user) {
  if (isInternal(operation)) return false;
  if (user?.id && globalThis.game?.user?.id && user.id !== game.user.id) return false;
  const turnKey = combatTurnKey(globalThis.game?.combat);
  if (!turnKey) return false;

  const actor = logicalMovementActor(document);
  if (!actor?.uuid) return false;
  const segment = movementStraightSegment(document, movement);
  if (!segment) return false;

  const previous = mountedWeaponMovementByActor.get(actor.uuid);
  const merged = previous?.turnKey === turnKey ? mergeStraightSegments(previous.segment, segment) : segment;
  mountedWeaponMovementByActor.set(actor.uuid, {
    turnKey,
    segment: merged,
    distance: measureStraightSegmentDistance(merged, document?.parent)
  });
  return true;
}

function actionTypeForWorkflow(workflow) {
  return workflow?.activity?.actionType ?? workflow?.item?.system?.actionType;
}

function hitTargetForWeaponWorkflow(workflow) {
  const hits = [...(workflow?.hitTargets ?? [])].map(asTokenDocument).filter(Boolean);
  return hits.length === 1 ? hits[0] : null;
}

function physicalRiderPairForWorkflow(workflow) {
  const riderToken = asTokenDocument(workflow?.token);
  const pair = riderToken ? getPairFromToken(riderToken) : null;
  return pair && riderToken.uuid === pair.state.riderTokenUuid ? pair : null;
}

function chargeStateForWorkflow(workflow, target) {
  const actorUuid = workflow?.actor?.uuid;
  const turnKey = combatTurnKey(globalThis.game?.combat);
  if (!actorUuid || !turnKey) {
    return { inCombat: false, chargeUsed: false, chargeDistance: 0, movedTowardTarget: false, turnKey: null };
  }
  const movement = mountedWeaponMovementByActor.get(actorUuid);
  const current = movement?.turnKey === turnKey ? movement : null;
  const targetPoint = tokenCenterPoint(target);
  return {
    inCombat: true,
    chargeUsed: mountedWeaponChargeUsedByActor.get(actorUuid) === turnKey,
    chargeDistance: current?.distance ?? 0,
    movedTowardTarget: Boolean(current?.segment && segmentMovesTowardTarget(current.segment, targetPoint)),
    turnKey
  };
}

export async function applyMountedWeaponDamage(workflow) {
  if (!workflow || mountedWeaponProcessedWorkflows.has(workflow)) return false;
  const profile = mountedWeaponProfile(workflow?.item);
  if (!profile || !WEAPON_ATTACK_TYPES.has(String(actionTypeForWorkflow(workflow) ?? "").toLowerCase())) return false;
  const target = hitTargetForWeaponWorkflow(workflow);
  if (!target) return false;

  const pair = physicalRiderPairForWorkflow(workflow);
  const charge = chargeStateForWorkflow(workflow, target);
  const plan = planMountedWeaponDamage({
    item: workflow.item,
    actionType: actionTypeForWorkflow(workflow),
    physicallyMounted: Boolean(pair),
    mountSize: pair?.mountToken?.actor?.system?.traits?.size,
    targetSize: target.actor?.system?.traits?.size,
    ...charge
  });
  if (!plan.formula) return false;

  const RollClass = globalThis.Roll;
  if (typeof RollClass !== "function" || typeof workflow.setBonusDamageRolls !== "function") return false;
  const labels = [];
  if (plan.mountedBonus) labels.push("Верховой бой");
  if (plan.chargeFormula) labels.push("Наскок");
  const bonusRoll = new RollClass(plan.formula, workflow.actor?.getRollData?.() ?? {}, {
    flavor: labels.join(" + ") || "Верховое оружие"
  });
  const existing = Array.isArray(workflow.bonusDamageRolls) ? [...workflow.bonusDamageRolls] : [];
  await workflow.setBonusDamageRolls([...existing, bonusRoll]);
  mountedWeaponProcessedWorkflows.add(workflow);

  if (plan.consumeCharge && workflow.actor?.uuid && charge.turnKey) {
    mountedWeaponChargeUsedByActor.set(workflow.actor.uuid, charge.turnKey);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Регистрация
// ---------------------------------------------------------------------------

function syncReach() {
  syncMountedReachEffects().catch(err => error("Ошибка эффекта досягаемости верхом", err));
}

/** Вызывается из scripts/main-v0.2.0.js после регистрации флажков функций. */
export function registerMountedCombat() {
  Hooks.once("init", registerOneWholeSettings);

  Hooks.once("ready", () => {
    oneWhole = installOneWhole(oneWholeConfig);
    syncReach();
    console.log(`[${MODULE_ID}] Mounted combat automation ready.`);
  });

  Hooks.on(`${MODULE_ID}.oneWholeChanged`, () => {
    if (!game.user.isActiveGM) return;
    syncReach();
    scheduleMountedAuraReconciliation();
  });

  Hooks.on(FEATURE_TOGGLED_HOOK, id => {
    if (id === "oneWhole") oneWhole?.enabledChanged();
    if (id === "oneWhole" || id === "mountedReach") syncReach();
    if (id === "oneWhole" || id === "mountedAuras") scheduleMountedAuraReconciliation();
  });

  Hooks.on("dnd5e.postHitDieRollConfiguration", (rolls, config) => {
    if (isFeatureEnabled("hitDieMaxHeal")) maximizeHitDieRollsIfGranted(rolls, config);
  });
  Hooks.on("dnd5e.rollHitDie", (rolls, data) => {
    if (isFeatureEnabled("woundClosure")) handleWoundClosureHitDie(rolls, data);
  });

  // These are observer/modifier hooks, not veto hooks. Never propagate helper booleans:
  // Midi-QOL interprets an explicit false from preDamageRoll as "block the roll".
  Hooks.on("midi-qol.preDamageRoll", workflow => {
    if (isFeatureEnabled("mixedMaxHealing")) prepareMixedTargetMaxHealing(workflow);
  });
  Hooks.on("midi-qol.DamageRollComplete", async workflow => {
    // Без контекста из preDamageRoll захват ничего не делает — проверка не нужна.
    await captureMixedTargetMaxHealingRoll(workflow);
    if (!isFeatureEnabled("mountedWeapons")) return;
    try {
      await applyMountedWeaponDamage(workflow);
    } catch (err) {
      error("Ошибка автоматизации свойств верхового оружия", err);
    }
  });
  Hooks.on("midi-qol.preTargetDamageApplication", (token, data) => { annotateMixedTargetHealing(token, data); });
  // Очистка всегда: функцию могли выключить посреди workflow.
  Hooks.on("midi-qol.RollComplete", workflow => { clearMixedTargetMaxHealing(workflow); });
  Hooks.on("midi-qol.postCleanup", workflow => { clearMixedTargetMaxHealing(workflow); });
  Hooks.on("midi-qol.preAttackConfig", workflow => {
    if (isFeatureEnabled("smallThreat")) handleSmallThreatPreAttackConfig(workflow);
  });

  Hooks.on("moveToken", (document, movement, operation, user) => {
    if (isFeatureEnabled("mountedWeapons")) recordMountedWeaponMovement(document, movement, operation, user);
  });

  registerAuraEffectsHooks();
}

export const mountedCombatApi = {
  get oneWhole() { return oneWhole; },
  getPairFromToken,
  reconcileAllMountedAuras
};
