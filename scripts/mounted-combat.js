export const MODULE_ID = "nazgob-personal";

export const MOUNTED_COMBAT_CONFIG = Object.freeze({
  mountItemName: "Сесть на скакуна",
  dismountItemName: "Спешиться со скакуна",
  riderOffset: Object.freeze({ x: 0.5, y: 0 }),
  maxMountDistance: 5,
  transparentTexture: `modules/${MODULE_ID}/assets/transparent.png`,
  woundClosureItemName: "Медальон затягивающихся ран"
});

const INCAPACITATING_STATUSES = new Set([
  "incapacitated",
  "paralyzed",
  "petrified",
  "stunned",
  "unconscious"
]);

const SIZE_RANKS = new Map([
  ["tiny", 0],
  ["sm", 1], ["small", 1],
  ["med", 2], ["medium", 2],
  ["lg", 3], ["large", 3],
  ["huge", 4],
  ["grg", 5], ["gargantuan", 5]
]);

export function parseAllowedActorUuids(html = "") {
  const uuids = [];
  const seen = new Set();
  const regex = /@UUID\[(Actor\.[^\]]+)\]/g;
  for (const match of String(html).matchAll(regex)) {
    const uuid = match[1];
    if (seen.has(uuid)) continue;
    seen.add(uuid);
    uuids.push(uuid);
  }
  return uuids;
}

export function parseMountDefinitions(html = "") {
  const source = String(html);
  const actorRegex = /@UUID\[(Actor\.[^\]]+)\]/g;
  const matches = [...source.matchAll(actorRegex)];
  const definitions = [];

  for (let index = 0; index < matches.length; index += 1) {
    const actorUuid = matches[index][1];
    const sectionStart = matches[index].index + matches[index][0].length;
    const sectionEnd = matches[index + 1]?.index ?? source.length;
    const section = source.slice(sectionStart, sectionEnd);
    const textureMatch = section.match(
      /mountedTexture\s*:\s*(?:"([^"]+)"|'([^']+)'|`([^`]+)`|([^\r\n<]+))/i
    );
    const mountedTexture = (textureMatch?.[1] ?? textureMatch?.[2] ?? textureMatch?.[3] ?? textureMatch?.[4] ?? "")
      .replace(/&nbsp;/gi, " ")
      .trim() || null;

    definitions.push({ actorUuid, mountedTexture });
  }

  return definitions;
}

export function mountedTextureFromItemDescription(html, actorUuid) {
  return parseMountDefinitions(html).find(definition => definition.actorUuid === actorUuid)?.mountedTexture ?? null;
}

export function splitSharedHp({ sharedHp, mountHpBeforePool, riderMax, mountMax }) {
  let pool = Math.max(0, Number(sharedHp) || 0);
  const safeRiderMax = Math.max(0, Number(riderMax) || 0);
  const safeMountMax = Math.max(0, Number(mountMax) || 0);
  const mountRestoreTarget = Math.min(
    Math.max(0, Number(mountHpBeforePool) || 0),
    safeMountMax
  );

  if (pool <= mountRestoreTarget) {
    return { riderHp: 0, mountHp: Math.min(pool, safeMountMax) };
  }

  let mountHp = mountRestoreTarget;
  pool -= mountHp;

  const riderHp = Math.min(pool, safeRiderMax);
  pool -= riderHp;

  if (pool > 0 && mountHp < safeMountMax) {
    const extraMount = Math.min(pool, safeMountMax - mountHp);
    mountHp += extraMount;
  }

  return { riderHp, mountHp };
}

export function splitSharedTemp({ sharedTemp, mountTempBeforePool }) {
  const pool = Math.max(0, Number(sharedTemp) || 0);
  const mountRestoreTarget = Math.max(0, Number(mountTempBeforePool) || 0);
  const mountTemp = Math.min(pool, mountRestoreTarget);
  return {
    riderTemp: pool - mountTemp,
    mountTemp
  };
}

export function isRiderIncapacitated({ hp, statuses = [] }) {
  if ((Number(hp) || 0) <= 0) return true;
  for (const status of statuses) {
    if (INCAPACITATING_STATUSES.has(String(status).toLowerCase())) return true;
  }
  return false;
}

export function candidateDismountOffsets() {
  const offsets = [];
  for (let x = -1; x <= 2; x += 1) {
    offsets.push({ x, y: -1 }, { x, y: 2 });
  }
  for (let y = 0; y <= 1; y += 1) {
    offsets.push({ x: -1, y }, { x: 2, y });
  }

  const riderX = MOUNTED_COMBAT_CONFIG.riderOffset.x;
  const riderY = MOUNTED_COMBAT_CONFIG.riderOffset.y;
  return offsets.sort((a, b) => {
    const da = ((a.x - riderX) ** 2) + ((a.y - riderY) ** 2);
    const db = ((b.x - riderX) ** 2) + ((b.y - riderY) ** 2);
    if (da !== db) return da - db;
    if (a.y !== b.y) return a.y - b.y;
    return a.x - b.x;
  });
}

export function sizeRank(size) {
  return SIZE_RANKS.get(String(size ?? "").toLowerCase()) ?? -1;
}

const PAIR_FLAG = "mountedPair";
const RIDER_LINK_FLAG = "mountedRiderLink";

// Dismount is asynchronous. Delayed movement/Midi callbacks can resume while
// teardown is running, so use both a runtime barrier and a persisted marker.
const tearingDownPairs = new Set();

function pairIsTearingDown(stateOrPairId) {
  const pairId = typeof stateOrPairId === "string" ? stateOrPairId : stateOrPairId?.pairId;
  return Boolean(stateOrPairId?.tearingDown || (pairId && tearingDownPairs.has(pairId)));
}

function getLivePairForMutation(pair) {
  const pairId = pair?.state?.pairId;
  const mountToken = pair?.mountToken;
  if (!pairId || !mountToken?.getFlag || pairIsTearingDown(pairId)) return null;
  const state = mountToken.getFlag(MODULE_ID, PAIR_FLAG);
  if (!state?.pairId || state.pairId !== pairId || pairIsTearingDown(state)) return null;
  const riderToken = resolveUuidSync(state.riderTokenUuid);
  const link = riderToken?.getFlag?.(MODULE_ID, RIDER_LINK_FLAG);
  if (!riderToken || link?.pairId !== pairId || link?.mountTokenUuid !== mountToken.uuid) return null;
  return { state, mountToken, riderToken };
}

const WARNINGS = Object.freeze({
  "rider-token": "Не удалось определить токен персонажа. Выберите его на текущей сцене и повторите попытку.",
  "target-count": "Выберите целью ровно одного скакуна.",
  "not-allowed": "Выбранное существо не указано в описании особенности как доступный скакун.",
  "not-owner": "У вас нет прав управления выбранным скакуном.",
  "too-far": "Скакун должен находиться не дальше 5 футов.",
  "rider-size": "Эта версия автоматизации поддерживает только всадника размером токена 1×1.",
  "mount-size": "Эта версия автоматизации поддерживает только скакуна размером токена 2×2.",
  "already-paired": "Один из этих токенов уже состоит в верховой паре.",
  "no-texture": "Для выбранного скакуна не указан mountedTexture в описании особенности.",
  "no-dismount-cell": "Рядом со скакуном нет свободной клетки для спешивания.",
  "midi-missing": "Для этой автоматизации должен быть включён Midi-QOL."
});

export function validateMountCandidate({
  targetCount,
  targetActorUuid,
  allowedActorUuids,
  isOwner,
  distance,
  riderWidth,
  riderHeight,
  mountWidth,
  mountHeight,
  riderPaired,
  mountPaired,
  mountedTexture
}) {
  if (targetCount !== 1) return { ok: false, code: "target-count" };
  if (!allowedActorUuids?.includes(targetActorUuid)) return { ok: false, code: "not-allowed" };
  if (!isOwner) return { ok: false, code: "not-owner" };
  if (!Number.isFinite(distance) || distance > MOUNTED_COMBAT_CONFIG.maxMountDistance) {
    return { ok: false, code: "too-far" };
  }
  if (Number(riderWidth) !== 1 || Number(riderHeight) !== 1) return { ok: false, code: "rider-size" };
  if (Number(mountWidth) !== 2 || Number(mountHeight) !== 2) return { ok: false, code: "mount-size" };
  if (riderPaired || mountPaired) return { ok: false, code: "already-paired" };
  if (!mountedTexture) return { ok: false, code: "no-texture" };
  return { ok: true, code: null };
}

export function isMountToggleItemName(name) {
  return name === MOUNTED_COMBAT_CONFIG.mountItemName || name === MOUNTED_COMBAT_CONFIG.dismountItemName;
}

function internalOptions(extra = {}) {
  return {
    ...extra,
    [MODULE_ID]: { ...(extra?.[MODULE_ID] ?? {}), internal: true }
  };
}

function isInternal(options) {
  return Boolean(options?.[MODULE_ID]?.internal);
}

function warn(code, fallback) {
  const message = WARNINGS[code] ?? fallback ?? code;
  globalThis.ui?.notifications?.warn?.(message);
  return false;
}

function error(message, err) {
  console.error(`[${MODULE_ID}] ${message}`, err);
  globalThis.ui?.notifications?.error?.(`${message}${err?.message ? `: ${err.message}` : ""}`);
}

export function resolveActivityItem(activity) {
  const candidate = activity?.item
    ?? (activity?.parent?.documentName === "Item" ? activity.parent : null);
  if (!candidate) return null;

  // dnd5e.preUseActivity receives an Activity belonging to a cloned Item.
  // Map that clone back to the embedded Actor Item so renames and flags persist.
  const actor = candidate.actor ?? candidate.parent;
  const original = actor?.items?.get?.(candidate.id);
  return original ?? candidate;
}

function activityItem(activity) {
  return resolveActivityItem(activity);
}

function tokenBaseActorUuid(tokenDoc) {
  return tokenDoc?.actorId ? `Actor.${tokenDoc.actorId}` : null;
}

function actorMatchesToken(actor, tokenObject) {
  if (!actor || !tokenObject?.actor) return false;
  return tokenObject.actor === actor || tokenObject.actor.id === actor.id || tokenObject.document?.actorId === actor.id;
}

function resolveRiderTokenDocument(activity) {
  const item = activityItem(activity);
  const actor = item?.actor ?? activity?.actor ?? null;
  if (!actor || !globalThis.canvas?.ready) return null;

  const syntheticToken = actor.token?.document ?? actor.token;
  if (syntheticToken?.documentName === "Token" && syntheticToken.parent?.id === canvas.scene?.id) {
    return syntheticToken;
  }

  const controlled = canvas.tokens?.controlled?.filter(token => actorMatchesToken(actor, token)) ?? [];
  if (controlled.length === 1) return controlled[0].document;

  const active = canvas.tokens?.placeables?.filter(token => actorMatchesToken(actor, token)) ?? [];
  if (active.length === 1) return active[0].document;
  return null;
}

function resolveUuidSync(uuid) {
  if (!uuid) return null;
  try {
    return globalThis.fromUuidSync?.(uuid) ?? null;
  } catch (err) {
    console.warn(`[${MODULE_ID}] Не удалось разрешить UUID ${uuid}`, err);
    return null;
  }
}

async function resolveUuid(uuid) {
  if (!uuid) return null;
  try {
    return await globalThis.fromUuid?.(uuid);
  } catch (err) {
    console.warn(`[${MODULE_ID}] Не удалось разрешить UUID ${uuid}`, err);
    return null;
  }
}

export function getPairFromToken(tokenDoc) {
  if (!tokenDoc?.getFlag) return null;

  const ownState = tokenDoc.getFlag(MODULE_ID, PAIR_FLAG);
  if (ownState?.pairId) {
    const riderToken = resolveUuidSync(ownState.riderTokenUuid);
    return { state: ownState, mountToken: tokenDoc, riderToken };
  }

  const link = tokenDoc.getFlag(MODULE_ID, RIDER_LINK_FLAG);
  if (!link?.mountTokenUuid) return null;
  const mountToken = resolveUuidSync(link.mountTokenUuid);
  const state = mountToken?.getFlag?.(MODULE_ID, PAIR_FLAG);
  if (!state?.pairId || state.pairId !== link.pairId) return null;
  return { state, mountToken, riderToken: tokenDoc };
}

function makePairId() {
  return globalThis.foundry?.utils?.randomID?.() ?? globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

function riderMountedPosition(mountToken) {
  const gridSize = globalThis.canvas?.grid?.size ?? globalThis.canvas?.dimensions?.size ?? 100;
  return {
    x: Number(mountToken.x) + (gridSize * MOUNTED_COMBAT_CONFIG.riderOffset.x),
    y: Number(mountToken.y) + (gridSize * MOUNTED_COMBAT_CONFIG.riderOffset.y),
    elevation: Number(mountToken.elevation) || 0
  };
}

function mountedTransparentTexture() {
  return MOUNTED_COMBAT_CONFIG.transparentTexture;
}

async function writePairState(mountToken, state) {
  await mountToken.update({
    [`flags.${MODULE_ID}.${PAIR_FLAG}`]: state
  }, internalOptions());
  return state;
}

async function clearTokenPairFlags(tokenDoc, { pair = false, link = false } = {}) {
  const update = {};
  if (pair) update[`flags.${MODULE_ID}.-=${PAIR_FLAG}`] = null;
  if (link) update[`flags.${MODULE_ID}.-=${RIDER_LINK_FLAG}`] = null;
  if (Object.keys(update).length) await tokenDoc.update(update, internalOptions());
}

async function renameToggleItem(item, mounted) {
  if (!item?.update) return;
  const desired = mounted ? MOUNTED_COMBAT_CONFIG.dismountItemName : MOUNTED_COMBAT_CONFIG.mountItemName;
  if (item.name !== desired) await item.update({ name: desired }, internalOptions());
}

async function findPairItem(state, riderToken, passedItem = null) {
  if (passedItem?.uuid === state.itemUuid) return passedItem;
  const byUuid = await resolveUuid(state.itemUuid);
  if (byUuid?.documentName === "Item") return byUuid;
  return riderToken?.actor?.items?.find?.(item => isMountToggleItemName(item.name)) ?? null;
}

export async function mountPair(riderToken, mountToken, item, mountedTexture) {
  const riderPos = riderMountedPosition(mountToken);
  const riderOriginalSort = Number(riderToken.sort) || 0;
  const mountOriginalSort = Number(mountToken.sort) || 0;
  const riderMountedSort = Math.max(riderOriginalSort, mountOriginalSort) + 1;
  const pairId = makePairId();

  const state = {
    version: 1,
    pairId,
    tearingDown: false,
    riderTokenUuid: riderToken.uuid,
    mountTokenUuid: mountToken.uuid,
    riderActorUuid: tokenBaseActorUuid(riderToken),
    mountActorUuid: tokenBaseActorUuid(mountToken),
    itemUuid: item?.uuid ?? null,
    poolActive: false,
    sharedHp: null,
    sharedTemp: null,
    sharedMax: null,
    mountHpBeforePool: null,
    mountTempBeforePool: null,
    riderMaxBonus: 0,
    mountMaxBonus: 0,
    visual: {
      riderTexture: riderToken.texture?.src ?? null,
      mountTexture: mountToken.texture?.src ?? null,
      riderSort: riderOriginalSort,
      mountSort: mountOriginalSort
    }
  };

  await mountToken.update({
    "texture.src": mountedTexture,
    [`flags.${MODULE_ID}.${PAIR_FLAG}`]: state
  }, internalOptions());

  await riderToken.update({
    x: riderPos.x,
    y: riderPos.y,
    elevation: riderPos.elevation,
    sort: riderMountedSort,
    "texture.src": mountedTransparentTexture(),
    [`flags.${MODULE_ID}.${RIDER_LINK_FLAG}`]: {
      pairId,
      mountTokenUuid: mountToken.uuid,
      itemUuid: item?.uuid ?? null,
      riderTexture: riderToken.texture?.src ?? null,
      riderSort: riderOriginalSort
    }
  }, internalOptions());

  await renameToggleItem(item, true);

  // Midi-QOL's rangeOverride lets melee attacks use the full 2x2 mount
  // footprint as an alternative origin without changing either token's size.
  const mountedPair = getPairFromToken(mountToken);
  if (mountedPair) await ensureMountedReachEffects(mountedPair);

  // Pool activation is added by the shared-HP layer below. Keeping this call
  // conditional makes the physical-pair layer independently usable while loading.
  if (typeof activatePool === "function") {
    const fresh = getPairFromToken(mountToken);
    if (fresh && !runtimeRiderIncapacitated(fresh)) await activatePool(fresh);
  }

  const finalPair = getPairFromToken(mountToken);
  if (finalPair && auraEffectsIsActive()) {
    await reconcilePairAuraGeometry(finalPair, { physicallyMounted: true });
  }
  return finalPair;
}

function basicDismountPosition(mountToken) {
  const gridSize = globalThis.canvas?.grid?.size ?? globalThis.canvas?.dimensions?.size ?? 100;
  const sceneRect = globalThis.canvas?.dimensions?.sceneRect;
  for (const offset of candidateDismountOffsets()) {
    const point = {
      x: Number(mountToken.x) + (offset.x * gridSize),
      y: Number(mountToken.y) + (offset.y * gridSize),
      elevation: Number(mountToken.elevation) || 0
    };
    if (sceneRect && !sceneRect.contains(point.x + gridSize / 2, point.y + gridSize / 2)) continue;
    return point;
  }
  return null;
}

function cancelPairRuntimeWork(pairId) {
  if (!pairId) return;
  movementSyncPending.delete(pairId);
  midiSuppressionByPair.delete(pairId);
  for (const [key, context] of midiWorkflowContexts) {
    if (!context?.pairs?.has?.(pairId)) continue;
    context.pairs.delete(pairId);
    if (!context.pairs.size) {
      midiWorkflowContexts.delete(key);
      if (context.workflow) clearMixedTargetMaxHealing(context.workflow);
    }
  }
}

export async function dismountPair(riderToken, item = null) {
  const pair = getPairFromToken(riderToken);
  if (!pair?.state?.pairId || pairIsTearingDown(pair.state)) return false;
  const { state, mountToken } = pair;
  const pairId = state.pairId;
  const dismountPosition = (typeof findDismountPosition === "function")
    ? findDismountPosition(pair)
    : basicDismountPosition(mountToken);
  if (!dismountPosition) return warn("no-dismount-cell");

  // Set the barrier synchronously, before the first await.
  tearingDownPairs.add(pairId);
  cancelPairRuntimeWork(pairId);
  const teardownState = { ...state, tearingDown: true };
  let workingPair = { ...pair, state: teardownState };

  try {
    await writePairState(mountToken, teardownState);
    workingPair = getPairFromToken(mountToken) ?? workingPair;

    if (workingPair.state.poolActive && typeof deactivatePool === "function") {
      await deactivatePool(workingPair, { allowTeardown: true });
      workingPair = getPairFromToken(mountToken) ?? workingPair;
    }

    await removeMountedReachEffects(workingPair);
    const finalState = workingPair.state;
    const toggleItem = await findPairItem(finalState, riderToken, item);

    // Relationship first, cosmetics second. Once both flags are gone, stale
    // callbacks cannot rediscover or resurrect this pair.
    await Promise.all([
      clearTokenPairFlags(mountToken, { pair: true }),
      clearTokenPairFlags(riderToken, { link: true })
    ]);

    await Promise.all([
      mountToken.update({
        "texture.src": finalState.visual?.mountTexture ?? mountToken.texture?.src,
        sort: finalState.visual?.mountSort ?? mountToken.sort
      }, internalOptions()),
      riderToken.update({
        x: dismountPosition.x,
        y: dismountPosition.y,
        elevation: dismountPosition.elevation,
        sort: finalState.visual?.riderSort ?? riderToken.sort,
        "texture.src": finalState.visual?.riderTexture ?? riderToken.texture?.src
      }, internalOptions())
    ]);

    if (auraEffectsIsActive()) {
      await reconcilePairAuraGeometry(workingPair, { physicallyMounted: false });
    }
    await renameToggleItem(toggleItem, false);
    return true;
  } finally {
    cancelPairRuntimeWork(pairId);
    tearingDownPairs.delete(pairId);
  }
}

function getItemDescriptionHtml(item) {
  return item?.system?.description?.value ?? item?.system?.description ?? "";
}

function getDistanceBetweenTokens(riderToken, mountToken) {
  const midi = globalThis.MidiQOL;
  if (!midi?.computeDistance || !riderToken?.object || !mountToken?.object) return NaN;
  try {
    return Number(midi.computeDistance(riderToken.object, mountToken.object, { wallsBlock: false }));
  } catch (err) {
    console.warn(`[${MODULE_ID}] Ошибка измерения расстояния Midi-QOL`, err);
    return NaN;
  }
}

export async function toggleFromActivity(activity) {
  const item = activityItem(activity);
  if (!item || !isMountToggleItemName(item.name)) return false;
  const riderToken = resolveRiderTokenDocument(activity);
  if (!riderToken) return warn("rider-token");

  const existingPair = getPairFromToken(riderToken);
  if (existingPair || item.name === MOUNTED_COMBAT_CONFIG.dismountItemName) {
    if (!existingPair) {
      await renameToggleItem(item, false);
      return warn("already-paired", "Связь со скакуном не найдена; название особенности восстановлено.");
    }
    return dismountPair(riderToken, item);
  }

  if (!globalThis.MidiQOL?.computeDistance) return warn("midi-missing");

  const targetObjects = [...(globalThis.game?.user?.targets ?? [])];
  if (targetObjects.length !== 1) return warn("target-count");
  const mountToken = targetObjects[0]?.document;
  if (!mountToken) return warn("target-count");

  const targetActorUuid = tokenBaseActorUuid(mountToken);
  const itemDescription = getItemDescriptionHtml(item);
  const allowedActorUuids = parseAllowedActorUuids(itemDescription);
  const mountedTexture = mountedTextureFromItemDescription(itemDescription, targetActorUuid);
  const validation = validateMountCandidate({
    targetCount: targetObjects.length,
    targetActorUuid,
    allowedActorUuids,
    isOwner: Boolean(mountToken.isOwner && mountToken.actor?.isOwner),
    distance: getDistanceBetweenTokens(riderToken, mountToken),
    riderWidth: riderToken.width,
    riderHeight: riderToken.height,
    mountWidth: mountToken.width,
    mountHeight: mountToken.height,
    riderPaired: Boolean(getPairFromToken(riderToken)),
    mountPaired: Boolean(getPairFromToken(mountToken)),
    mountedTexture
  });
  if (!validation.ok) return warn(validation.code);

  await mountPair(riderToken, mountToken, item, mountedTexture);
  return true;
}

function onPreUseActivity(activity) {
  const item = activityItem(activity);
  if (!item || !isMountToggleItemName(item.name)) return;
  Promise.resolve()
    .then(() => toggleFromActivity(activity))
    .catch(err => error("Ошибка автоматизации верхового боя", err));
  return false;
}


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

export function planMixedTargetMaxHealing({ actionType, targets = [], pairResolver }) {
  if (String(actionType ?? "").toLowerCase() !== "heal") {
    return { active: false, orderedTargets: [...targets], pairIds: [], maxTargetUuids: [] };
  }

  const tokenDocs = [...targets].map(asTokenDocument).filter(Boolean);
  const targetUuids = new Set(tokenDocs.map(token => token.uuid).filter(Boolean));
  const affectedPairs = new Map();

  for (const tokenDoc of tokenDocs) {
    const pair = pairResolver?.(tokenDoc);
    const state = pair?.state;
    if (!state?.poolActive || !state.pairId) continue;
    if (!targetUuids.has(state.riderTokenUuid) || !targetUuids.has(state.mountTokenUuid)) continue;

    const riderToken = tokenDocs.find(token => token.uuid === state.riderTokenUuid);
    const mountToken = tokenDocs.find(token => token.uuid === state.mountTokenUuid);
    if (!riderToken || !mountToken) continue;
    const riderMax = hasMaxHealingDiceGrant(riderToken.actor);
    const mountMax = hasMaxHealingDiceGrant(mountToken.actor);
    if (riderMax === mountMax) continue;
    affectedPairs.set(state.pairId, state);
  }

  if (!affectedPairs.size) {
    return { active: false, orderedTargets: [...targets], pairIds: [], maxTargetUuids: [] };
  }

  const affectedTokenUuids = new Set();
  for (const state of affectedPairs.values()) {
    affectedTokenUuids.add(state.riderTokenUuid);
    affectedTokenUuids.add(state.mountTokenUuid);
  }

  // Reordering the workflow forces Midi-QOL to make a normal shared roll.
  // Do not do that if an unrelated target also grants max healing: this module only
  // corrects the mounted pair and must not silently change another creature's healing.
  const hasExternalMaxTarget = tokenDocs.some(token =>
    hasMaxHealingDiceGrant(token.actor) && !affectedTokenUuids.has(token.uuid)
  );
  if (hasExternalMaxTarget) {
    return { active: false, orderedTargets: [...targets], pairIds: [], maxTargetUuids: [] };
  }

  const maxTargetUuids = tokenDocs
    .filter(token => affectedTokenUuids.has(token.uuid) && hasMaxHealingDiceGrant(token.actor))
    .map(token => token.uuid);
  const orderedTargets = [...targets].sort((a, b) => {
    const aMax = hasMaxHealingDiceGrant(asTokenDocument(a)?.actor) ? 1 : 0;
    const bMax = hasMaxHealingDiceGrant(asTokenDocument(b)?.actor) ? 1 : 0;
    return aMax - bMax;
  });

  return {
    active: true,
    orderedTargets,
    pairIds: [...affectedPairs.keys()],
    maxTargetUuids
  };
}

export function adjustHealingEntryForTargetMax(entry, { rolledTotal, maxTotal } = {}) {
  const normalized = damageEntryFromDamageItem(entry);
  const healing = Math.max(0, normalized.newHP - normalized.oldHP);
  const rolled = Math.max(0, Number(rolledTotal) || 0);
  const maximum = Math.max(0, Number(maxTotal) || 0);
  if (!healing || maximum <= rolled) return normalized;

  const adjustedHealing = rolled > 0
    ? Math.max(healing, Math.floor((healing * maximum / rolled) + 1e-9))
    : Math.max(healing, maximum);
  return {
    ...normalized,
    newHP: normalized.oldHP + adjustedHealing
  };
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

function registerBaseHooks() {
  Hooks.on("dnd5e.preUseActivity", onPreUseActivity);
  Hooks.on("dnd5e.postHitDieRollConfiguration", maximizeHitDieRollsIfGranted);
  Hooks.on("dnd5e.rollHitDie", handleWoundClosureHitDie);
  Hooks.on("canvasReady", () => {
    Promise.resolve()
      .then(() => repairMountedPairsOnCanvas())
      .catch(err => error("Ошибка восстановления верховых пар после загрузки сцены", err));
  });
  Hooks.once("ready", () => {
    globalThis.NazgobMountedCombat = {
      MODULE_ID,
      config: MOUNTED_COMBAT_CONFIG,
      toggleFromActivity,
      mountPair,
      dismountPair,
      getPairFromToken,
      repairMountedPairsOnCanvas
    };
    console.log(`[${MODULE_ID}] Mounted combat automation ready.`);
  });
}

if (typeof globalThis.Hooks !== "undefined") registerBaseHooks();

export function riderPositionForMountCoordinates(mount, gridSize) {
  return {
    x: Number(mount.x) + (Number(gridSize) * MOUNTED_COMBAT_CONFIG.riderOffset.x),
    y: Number(mount.y) + (Number(gridSize) * MOUNTED_COMBAT_CONFIG.riderOffset.y),
    elevation: Number(mount.elevation) || 0
  };
}

export function mountDestinationForRiderMove({ destination, riderCurrent, mountCurrent }) {
  const movedXY = Number(destination.x) !== Number(riderCurrent.x)
    || Number(destination.y) !== Number(riderCurrent.y);
  return {
    x: movedXY ? Number(destination.x) : Number(mountCurrent.x),
    y: movedXY ? Number(destination.y) : Number(mountCurrent.y),
    elevation: Number(destination.elevation ?? mountCurrent.elevation) || 0
  };
}

export function rectanglesOverlap(a, b) {
  return a.x < (b.x + b.width)
    && (a.x + a.width) > b.x
    && a.y < (b.y + b.height)
    && (a.y + a.height) > b.y;
}

function hasMovementChange(changes) {
  if (!changes || typeof changes !== "object") return false;
  return ["x", "y", "elevation"].some(key => Object.prototype.hasOwnProperty.call(changes, key));
}

function tokenAtSameElevation(a, bElevation) {
  return Math.abs((Number(a?.elevation) || 0) - (Number(bElevation) || 0)) < 0.001;
}

function candidateIsOccupied(pair, point) {
  const gridSize = canvas.grid?.size ?? canvas.dimensions?.size ?? 100;
  const candidate = { x: point.x, y: point.y, width: gridSize, height: gridSize };
  for (const token of canvas.scene?.tokens ?? []) {
    if (token.uuid === pair.state.riderTokenUuid || token.uuid === pair.state.mountTokenUuid) continue;
    if (!tokenAtSameElevation(token, point.elevation)) continue;
    const other = {
      x: Number(token.x),
      y: Number(token.y),
      width: Number(token.width) * gridSize,
      height: Number(token.height) * gridSize
    };
    if (rectanglesOverlap(candidate, other)) return true;
  }
  return false;
}

function candidateCrossesWall(pair, point) {
  const rider = pair.riderToken;
  if (!rider) return true;
  const gridSize = canvas.grid?.size ?? canvas.dimensions?.size ?? 100;
  const origin = {
    x: Number(rider.x) + (gridSize / 2),
    y: Number(rider.y) + (gridSize / 2),
    elevation: Number(rider.elevation) || 0
  };
  const destination = {
    x: Number(point.x) + (gridSize / 2),
    y: Number(point.y) + (gridSize / 2),
    elevation: Number(point.elevation) || 0
  };

  try {
    if (rider.object?.checkCollision) {
      return Boolean(rider.object.checkCollision(destination, { origin, type: "move", mode: "any" }));
    }
    const backend = globalThis.CONFIG?.Canvas?.polygonBackends?.move;
    if (backend?.testCollision) {
      return Boolean(backend.testCollision(origin, destination, { type: "move", mode: "any" }));
    }
  } catch (err) {
    console.warn(`[${MODULE_ID}] Ошибка проверки стены при спешивании`, err);
    return true;
  }
  return false;
}

export function findDismountPosition(pair) {
  const mount = pair?.mountToken;
  if (!mount || !globalThis.canvas?.ready) return null;
  const gridSize = canvas.grid?.size ?? canvas.dimensions?.size ?? 100;
  const sceneRect = canvas.dimensions?.sceneRect;

  for (const offset of candidateDismountOffsets()) {
    const point = {
      x: Number(mount.x) + (offset.x * gridSize),
      y: Number(mount.y) + (offset.y * gridSize),
      elevation: Number(mount.elevation) || 0
    };
    const centerX = point.x + (gridSize / 2);
    const centerY = point.y + (gridSize / 2);
    if (sceneRect && !sceneRect.contains(centerX, centerY)) continue;
    if (candidateIsOccupied(pair, point)) continue;
    if (candidateCrossesWall(pair, point)) continue;
    return point;
  }
  return null;
}

const movementSyncPending = new Map();

async function syncRiderToMount(pair, mountPosition = null) {
  const fresh = getLivePairForMutation(pair);
  if (!fresh) return;
  const mount = fresh.mountToken;
  const rider = fresh.riderToken;
  if (!mount || !rider) return;
  const gridSize = canvas.grid?.size ?? canvas.dimensions?.size ?? 100;
  const sourcePosition = mountPosition ? {
    x: Number(mountPosition.x ?? mount.x),
    y: Number(mountPosition.y ?? mount.y),
    elevation: Number(mountPosition.elevation ?? mount.elevation) || 0
  } : mount;
  const desired = riderPositionForMountCoordinates(sourcePosition, gridSize);
  const changed = Number(rider.x) !== desired.x
    || Number(rider.y) !== desired.y
    || Number(rider.elevation || 0) !== desired.elevation;
  if (!changed) return;
  await rider.update({ x: desired.x, y: desired.y, elevation: desired.elevation }, internalOptions({ animate: true }));
}

function scheduleRiderSync(pair, mountPosition = null) {
  const pairId = pair?.state?.pairId;
  if (!pairId || pairIsTearingDown(pair.state)) return;

  const pending = movementSyncPending.get(pairId);
  if (pending) {
    if (mountPosition) pending.mountPosition = mountPosition;
    return;
  }

  const request = { mountPosition };
  movementSyncPending.set(pairId, request);
  queueMicrotask(async () => {
    try {
      const fresh = getLivePairForMutation(pair);
      if (!fresh) return;
      const latest = movementSyncPending.get(pairId) ?? request;
      await syncRiderToMount(fresh, latest.mountPosition);
    } catch (err) {
      error("Не удалось синхронизировать положение всадника", err);
    } finally {
      movementSyncPending.delete(pairId);
    }
  });
}

export function handlePreMoveToken(document, movement, operation) {
  if (isInternal(operation)) return;
  const pair = getPairFromToken(document);
  if (!pair || pairIsTearingDown(pair.state)) return;
  if (document.uuid !== pair.state.riderTokenUuid) return;

  const destination = mountDestinationForRiderMove({
    destination: movement.destination,
    riderCurrent: document,
    mountCurrent: pair.mountToken
  });
  queueMicrotask(() => {
    const live = getLivePairForMutation(pair);
    if (!live) return;
    live.mountToken?.move?.(destination, {
      showRuler: false,
      [MODULE_ID]: { reroutedFromRider: true }
    }).catch(err => error("Не удалось переместить скакуна за всадником", err));
  });
  return false;
}

export function handleMoveToken(document, movement, operation, user) {
  if (isInternal(operation)) return;
  if (user?.id && globalThis.game?.user?.id && user.id !== game.user.id) return;
  const pair = getPairFromToken(document);
  if (!pair || pairIsTearingDown(pair.state) || document.uuid !== pair.state.mountTokenUuid) return;
  scheduleRiderSync(pair, movement?.destination ?? null);
}

function handleUpdateToken(document, changes, options, userId) {
  if (isInternal(options) || !hasMovementChange(changes)) return;
  if (userId && globalThis.game?.user?.id && userId !== game.user.id) return;
  const pair = getPairFromToken(document);
  if (!pair || pairIsTearingDown(pair.state)) return;

  if (document.uuid === pair.state.mountTokenUuid) {
    scheduleRiderSync(pair);
    return;
  }

  if (document.uuid === pair.state.riderTokenUuid) {
    const movedXY = Object.prototype.hasOwnProperty.call(changes, "x")
      || Object.prototype.hasOwnProperty.call(changes, "y");
    const destination = {
      x: movedXY ? Number(document.x) : Number(pair.mountToken.x),
      y: movedXY ? Number(document.y) : Number(pair.mountToken.y),
      elevation: Number(document.elevation) || 0
    };
    queueMicrotask(() => {
      const live = getLivePairForMutation(pair);
      if (!live) return;
      live.mountToken?.move?.(destination, {
        showRuler: false,
        [MODULE_ID]: { reroutedFromRider: true }
      }).catch(err => error("Не удалось восстановить связанную позицию скакуна", err));
    });
  }
}

function registerMovementHooks() {
  Hooks.on("preMoveToken", handlePreMoveToken);
  Hooks.on("moveToken", handleMoveToken);
  Hooks.on("updateToken", handleUpdateToken);
}

if (typeof globalThis.Hooks !== "undefined") registerMovementHooks();

export function combineSharedPool({ riderHp, mountHp, riderTemp, mountTemp, riderMax, mountMax }) {
  return {
    sharedHp: Math.max(0, Number(riderHp) || 0) + Math.max(0, Number(mountHp) || 0),
    sharedTemp: Math.max(0, Number(riderTemp) || 0) + Math.max(0, Number(mountTemp) || 0),
    sharedMax: Math.max(0, Number(riderMax) || 0) + Math.max(0, Number(mountMax) || 0)
  };
}

export function independentMaxFromHp({ max, tempmax, moduleBonus = 0 }) {
  return Math.max(0, (Number(max) || 0) + (Number(tempmax) || 0) - (Number(moduleBonus) || 0));
}

const MAX_EFFECT_FLAG = "sharedMaxEffect";
const MAX_EFFECT_NAME = "Верховой боец — общий максимум хитов";
const REACH_EFFECT_FLAG = "mountedReachEffect";
const REACH_EFFECT_NAME = "Верховой боец — досягаемость от скакуна";

export function buildMountedReachEffectData({
  pairId,
  riderActorId,
  origin = null,
  customMode = globalThis.CONST?.ACTIVE_EFFECT_MODES?.CUSTOM ?? 0
}) {
  const safeRiderActorId = JSON.stringify(String(riderActorId ?? ""));
  const value = `activity.actor && activity.actor.id === ${safeRiderActorId}`;
  return {
    name: REACH_EFFECT_NAME,
    disabled: false,
    transfer: false,
    origin,
    changes: ["mwak", "msak"].map(actionType => ({
      key: `flags.midi-qol.rangeOverride.attack.${actionType}`,
      mode: customMode,
      value,
      priority: 20
    })),
    flags: {
      [MODULE_ID]: {
        [REACH_EFFECT_FLAG]: pairId
      }
    }
  };
}

function findMountedReachEffect(actor, pairId) {
  return actor?.effects?.find?.(effect => effect.getFlag?.(MODULE_ID, REACH_EFFECT_FLAG) === pairId) ?? null;
}

async function ensureMountedReachEffect(actor, pairId, riderActorId, origin = null) {
  if (!actor?.createEmbeddedDocuments || !riderActorId) return;
  const existing = findMountedReachEffect(actor, pairId);
  const data = buildMountedReachEffectData({ pairId, riderActorId, origin });
  if (existing?.update) await existing.update(data, internalOptions());
  else await actor.createEmbeddedDocuments("ActiveEffect", [data], internalOptions());
}

async function removeMountedReachEffect(actor, pairId) {
  if (!actor?.deleteEmbeddedDocuments) return;
  const ids = [...(actor.effects ?? [])]
    .filter(effect => effect.getFlag?.(MODULE_ID, REACH_EFFECT_FLAG) === pairId)
    .map(effect => effect.id)
    .filter(Boolean);
  if (ids.length) await actor.deleteEmbeddedDocuments("ActiveEffect", ids, internalOptions());
}

async function ensureMountedReachEffects(pair) {
  if (!pair?.state?.pairId) return;
  const { rider, mount } = pairActors(pair);
  const riderActorId = pair.riderToken?.actor?.id ?? rider?.id;
  if (!riderActorId) return;
  await Promise.all([
    ensureMountedReachEffect(rider, pair.state.pairId, riderActorId, pair.state.itemUuid),
    ensureMountedReachEffect(mount, pair.state.pairId, riderActorId, pair.state.itemUuid)
  ]);
}

async function removeMountedReachEffects(pair) {
  if (!pair?.state?.pairId) return;
  const { rider, mount } = pairActors(pair);
  await Promise.all([
    removeMountedReachEffect(rider, pair.state.pairId),
    removeMountedReachEffect(mount, pair.state.pairId)
  ]);
}

function actorHpData(actor) {
  const hp = actor?.system?.attributes?.hp ?? {};
  return {
    value: Math.max(0, Number(hp.value) || 0),
    temp: Math.max(0, Number(hp.temp) || 0),
    max: Math.max(0, Number(hp.max) || 0),
    tempmax: Number(hp.tempmax) || 0
  };
}

function actorStatusIds(actor) {
  const statuses = actor?.statuses;
  if (typeof statuses?.[Symbol.iterator] === "function") return [...statuses].map(String);
  const result = new Set();
  for (const effect of actor?.effects ?? []) {
    for (const status of effect.statuses ?? []) result.add(String(status));
  }
  return [...result];
}

export function runtimeRiderIncapacitated(pair) {
  const actor = pair?.riderToken?.actor;
  if (!actor) return true;
  return isRiderIncapacitated({
    hp: actorHpData(actor).value,
    statuses: actorStatusIds(actor)
  });
}

function pairActors(pair) {
  return {
    rider: pair?.riderToken?.actor ?? null,
    mount: pair?.mountToken?.actor ?? null
  };
}

function currentIndependentMaxes(pair) {
  const { rider, mount } = pairActors(pair);
  const riderHp = actorHpData(rider);
  const mountHp = actorHpData(mount);
  return {
    riderMax: independentMaxFromHp({
      max: riderHp.max,
      tempmax: riderHp.tempmax,
      moduleBonus: pair.state.riderMaxBonus
    }),
    mountMax: independentMaxFromHp({
      max: mountHp.max,
      tempmax: mountHp.tempmax,
      moduleBonus: pair.state.mountMaxBonus
    })
  };
}

function findSharedMaxEffect(actor, pairId) {
  return actor?.effects?.find?.(effect => effect.getFlag?.(MODULE_ID, MAX_EFFECT_FLAG) === pairId) ?? null;
}

async function ensureSharedMaxEffect(actor, pairId, bonus, origin = null) {
  if (!actor) return;
  const existing = findSharedMaxEffect(actor, pairId);
  const data = {
    name: MAX_EFFECT_NAME,
    disabled: false,
    transfer: false,
    origin,
    changes: [{
      key: "system.attributes.hp.tempmax",
      mode: globalThis.CONST?.ACTIVE_EFFECT_MODES?.ADD ?? 2,
      value: String(Math.max(0, Number(bonus) || 0)),
      priority: 20
    }],
    flags: {
      [MODULE_ID]: {
        [MAX_EFFECT_FLAG]: pairId
      }
    }
  };
  if (existing) {
    await existing.update(data, internalOptions());
  } else {
    await actor.createEmbeddedDocuments("ActiveEffect", [data], internalOptions());
  }
}

async function removeSharedMaxEffect(actor, pairId) {
  if (!actor) return;
  const ids = [...(actor.effects ?? [])]
    .filter(effect => effect.getFlag?.(MODULE_ID, MAX_EFFECT_FLAG) === pairId)
    .map(effect => effect.id);
  if (ids.length) await actor.deleteEmbeddedDocuments("ActiveEffect", ids, internalOptions());
}

async function setActorHp(actor, { value, temp }) {
  if (!actor?.update) return;
  const update = {};
  if (value !== undefined) update["system.attributes.hp.value"] = Math.max(0, Number(value) || 0);
  if (temp !== undefined) update["system.attributes.hp.temp"] = Math.max(0, Number(temp) || 0);
  if (Object.keys(update).length) await actor.update(update, internalOptions());
}

async function setActorsSharedValues(pair, { value, temp }) {
  const { rider, mount } = pairActors(pair);
  await Promise.all([
    setActorHp(rider, { value, temp }),
    setActorHp(mount, { value, temp })
  ]);
}

export async function rebuildPoolEffects(pair) {
  let fresh = getLivePairForMutation(pair);
  if (!fresh?.state?.poolActive) return fresh;
  const { rider, mount } = pairActors(fresh);
  if (!rider || !mount) return fresh;

  const { riderMax, mountMax } = currentIndependentMaxes(fresh);
  const sharedMax = riderMax + mountMax;
  const sharedHp = Math.min(Math.max(0, Number(fresh.state.sharedHp) || 0), sharedMax);
  const nextState = {
    ...fresh.state,
    sharedMax,
    sharedHp,
    riderMaxBonus: mountMax,
    mountMaxBonus: riderMax
  };
  if (pairIsTearingDown(nextState)) return null;

  await ensureSharedMaxEffect(rider, nextState.pairId, mountMax, nextState.itemUuid);
  if (pairIsTearingDown(nextState)) return null;
  await ensureSharedMaxEffect(mount, nextState.pairId, riderMax, nextState.itemUuid);
  if (pairIsTearingDown(nextState)) return null;
  await writePairState(fresh.mountToken, nextState);
  fresh = getLivePairForMutation({ ...fresh, state: nextState });
  if (!fresh) return null;
  await setActorsSharedValues(fresh, { value: sharedHp, temp: nextState.sharedTemp });
  return getLivePairForMutation(fresh);
}

export async function activatePool(pair) {
  let fresh = getLivePairForMutation(pair);
  if (!fresh || fresh.state.poolActive || runtimeRiderIncapacitated(fresh)) return fresh;
  const { rider, mount } = pairActors(fresh);
  if (!rider || !mount) return fresh;

  const riderHp = actorHpData(rider);
  const mountHp = actorHpData(mount);
  const riderMax = independentMaxFromHp({ max: riderHp.max, tempmax: riderHp.tempmax, moduleBonus: 0 });
  const mountMax = independentMaxFromHp({ max: mountHp.max, tempmax: mountHp.tempmax, moduleBonus: 0 });
  const combined = combineSharedPool({
    riderHp: riderHp.value,
    mountHp: mountHp.value,
    riderTemp: riderHp.temp,
    mountTemp: mountHp.temp,
    riderMax,
    mountMax
  });

  const nextState = {
    ...fresh.state,
    poolActive: true,
    ...combined,
    mountHpBeforePool: mountHp.value,
    mountTempBeforePool: mountHp.temp,
    riderMaxBonus: mountMax,
    mountMaxBonus: riderMax
  };
  if (pairIsTearingDown(nextState)) return null;
  await writePairState(fresh.mountToken, nextState);
  fresh = getLivePairForMutation({ ...fresh, state: nextState });
  if (!fresh) return null;

  await ensureSharedMaxEffect(rider, nextState.pairId, mountMax, nextState.itemUuid);
  if (pairIsTearingDown(nextState)) return null;
  await ensureSharedMaxEffect(mount, nextState.pairId, riderMax, nextState.itemUuid);
  if (pairIsTearingDown(nextState)) return null;
  await setActorsSharedValues(fresh, { value: combined.sharedHp, temp: combined.sharedTemp });
  return getLivePairForMutation(fresh);
}

export async function deactivatePool(pair, { allowTeardown = false } = {}) {
  let fresh = allowTeardown ? (getPairFromToken(pair?.mountToken) ?? pair) : getLivePairForMutation(pair);
  if (!fresh?.state?.poolActive) return fresh;
  if (!allowTeardown && pairIsTearingDown(fresh.state)) return fresh;
  const { rider, mount } = pairActors(fresh);
  const { riderMax, mountMax } = currentIndependentMaxes(fresh);
  const hpSplit = splitSharedHp({
    sharedHp: fresh.state.sharedHp,
    mountHpBeforePool: fresh.state.mountHpBeforePool,
    riderMax,
    mountMax
  });
  const tempSplit = splitSharedTemp({
    sharedTemp: fresh.state.sharedTemp,
    mountTempBeforePool: fresh.state.mountTempBeforePool
  });

  await Promise.all([
    removeSharedMaxEffect(rider, fresh.state.pairId),
    removeSharedMaxEffect(mount, fresh.state.pairId)
  ]);
  await Promise.all([
    setActorHp(rider, { value: hpSplit.riderHp, temp: tempSplit.riderTemp }),
    setActorHp(mount, { value: hpSplit.mountHp, temp: tempSplit.mountTemp })
  ]);

  const nextState = {
    ...fresh.state,
    poolActive: false,
    sharedHp: null,
    sharedTemp: null,
    sharedMax: null,
    mountHpBeforePool: null,
    mountTempBeforePool: null,
    riderMaxBonus: 0,
    mountMaxBonus: 0
  };
  await writePairState(fresh.mountToken, nextState);
  if (allowTeardown) return getPairFromToken(fresh.mountToken) ?? { ...fresh, state: nextState };
  return getLivePairForMutation({ ...fresh, state: nextState });
}

export async function refreshCapability(pair) {
  const fresh = getLivePairForMutation(pair);
  if (!fresh) return null;
  const incapacitated = runtimeRiderIncapacitated(fresh);
  if (fresh.state.poolActive && incapacitated) return deactivatePool(fresh);
  if (!fresh.state.poolActive && !incapacitated) return activatePool(fresh);
  return fresh;
}

function actorPairKey(actor) {
  return actor?.id ? `Actor.${actor.id}` : null;
}

function physicalPairsForActor(actor) {
  const actorUuid = actorPairKey(actor);
  if (!actorUuid || !globalThis.canvas?.scene) return [];
  const pairs = [];
  for (const token of canvas.scene.tokens ?? []) {
    const state = token.getFlag?.(MODULE_ID, PAIR_FLAG);
    if (!state?.pairId || pairIsTearingDown(state)) continue;
    if (state.riderActorUuid !== actorUuid && state.mountActorUuid !== actorUuid) continue;
    const pair = getLivePairForMutation({ state, mountToken: token });
    if (pair) pairs.push(pair);
  }
  return pairs;
}

function changeContainsPath(changes, path) {
  if (!changes || typeof changes !== "object") return false;
  if (Object.prototype.hasOwnProperty.call(changes, path)) return true;
  const parts = path.split(".");
  let current = changes;
  for (const part of parts) {
    if (!current || typeof current !== "object" || !Object.prototype.hasOwnProperty.call(current, part)) return false;
    current = current[part];
  }
  return true;
}

function pairSuppressedByMidi(pairId) {
  return typeof isPairMidiSuppressed === "function" ? isPairMidiSuppressed(pairId) : false;
}

export async function syncPoolFromActorUpdate(actor, changes, options) {
  if (isInternal(options)) return;
  const valueChanged = changeContainsPath(changes, "system.attributes.hp.value");
  const tempChanged = changeContainsPath(changes, "system.attributes.hp.temp");
  const maxChanged = changeContainsPath(changes, "system.attributes.hp.max")
    || changeContainsPath(changes, "system.attributes.hp.tempmax");
  if (!valueChanged && !tempChanged && !maxChanged) return;

  for (let pair of physicalPairsForActor(actor)) {
    if (pairSuppressedByMidi(pair.state.pairId)) continue;
    if (!pair.state.poolActive) {
      await refreshCapability(pair);
      continue;
    }

    const hp = actorHpData(actor);
    const nextState = {
      ...pair.state,
      sharedHp: valueChanged ? hp.value : pair.state.sharedHp,
      sharedTemp: tempChanged ? hp.temp : pair.state.sharedTemp
    };
    if (pairIsTearingDown(nextState)) continue;
    await writePairState(pair.mountToken, nextState);
    pair = getLivePairForMutation({ ...pair, state: nextState });
    if (!pair) continue;

    const partner = actor === pair.riderToken?.actor ? pair.mountToken?.actor : pair.riderToken?.actor;
    await setActorHp(partner, {
      value: valueChanged ? nextState.sharedHp : undefined,
      temp: tempChanged ? nextState.sharedTemp : undefined
    });

    if (maxChanged) pair = await rebuildPoolEffects(pair);
    await refreshCapability(pair);
  }
}

function handleUpdateActor(actor, changes, options, userId) {
  if (isInternal(options)) return;
  if (userId && globalThis.game?.user?.id && userId !== game.user.id) return;
  Promise.resolve()
    .then(() => syncPoolFromActorUpdate(actor, changes, options))
    .catch(err => error("Ошибка синхронизации общего пула хитов", err));
}

function effectMutationActor(effect) {
  return effect?.parent?.documentName === "Actor" ? effect.parent : null;
}

function handleEffectMutation(effect, _changesOrOptions, maybeOptions, maybeUserId) {
  const isUpdate = arguments.length >= 4;
  const options = isUpdate ? maybeOptions : _changesOrOptions;
  const userId = isUpdate ? maybeUserId : maybeOptions;
  if (isInternal(options)) return;
  if (userId && globalThis.game?.user?.id && userId !== game.user.id) return;
  if (effect?.getFlag?.(MODULE_ID, MAX_EFFECT_FLAG)) return;
  const actor = effectMutationActor(effect);
  if (!actor) return;

  queueMicrotask(async () => {
    try {
      for (let pair of physicalPairsForActor(actor)) {
        if (pairSuppressedByMidi(pair.state.pairId)) continue;
        pair = await refreshCapability(pair);
        if (pair?.state?.poolActive) await rebuildPoolEffects(pair);
      }
    } catch (err) {
      error("Ошибка обновления состояния верховой пары", err);
    }
  });
}

function registerPoolHooks() {
  Hooks.on("updateActor", handleUpdateActor);
  Hooks.on("createActiveEffect", (effect, options, userId) => handleEffectMutation(effect, options, userId));
  Hooks.on("updateActiveEffect", (effect, changes, options, userId) => handleEffectMutation(effect, changes, options, userId));
  Hooks.on("deleteActiveEffect", (effect, options, userId) => handleEffectMutation(effect, options, userId));
}

if (typeof globalThis.Hooks !== "undefined") registerPoolHooks();

export function aggregatePoolWorkflowChanges({
  beforeHp,
  beforeTemp,
  afterMax,
  entries = [],
  isArea = false
}) {
  const startingHp = Math.max(0, Number(beforeHp) || 0);
  const startingTemp = Math.max(0, Number(beforeTemp) || 0);
  const maximumHp = Math.max(0, Number(afterMax) || 0);

  const normalized = entries.map(entry => {
    const oldHP = Math.max(0, Number(entry?.oldHP) || 0);
    const newHP = Math.max(0, Number(entry?.newHP) || 0);
    const oldTempHP = Math.max(0, Number(entry?.oldTempHP) || 0);
    const newTempHP = Math.max(0, Number(entry?.newTempHP) || 0);
    return {
      loss: Math.max(0, oldHP - newHP) + Math.max(0, oldTempHP - newTempHP),
      hpHealing: Math.max(0, newHP - oldHP),
      tempHealing: Math.max(0, newTempHP - oldTempHP)
    };
  });

  const losses = normalized.map(entry => entry.loss);
  const damageApplied = isArea
    ? Math.max(0, ...losses)
    : losses.reduce((sum, value) => sum + value, 0);
  const hpHealing = normalized.reduce((sum, entry) => sum + entry.hpHealing, 0);
  const tempHealing = normalized.reduce((sum, entry) => sum + entry.tempHealing, 0);

  const tempDamage = Math.min(startingTemp, damageApplied);
  const hpDamage = Math.max(0, damageApplied - tempDamage);
  const sharedTemp = Math.max(0, startingTemp - tempDamage) + tempHealing;
  const sharedHp = Math.min(maximumHp, Math.max(0, startingHp - hpDamage) + hpHealing);

  return { sharedHp, sharedTemp, damageApplied, hpHealing, tempHealing };
}

export function isAreaWorkflow(workflow) {
  if (workflow?.templateUuid) return true;
  const templateType = workflow?.activity?.target?.template?.type;
  return Boolean(templateType && templateType !== "none");
}

export function shouldGrantSmallThreat({
  poolActive,
  actionType,
  mountSize,
  targetSize,
  targetIsMounted
}) {
  if (!poolActive || String(actionType ?? "").toLowerCase() !== "mwak" || targetIsMounted) return false;
  const mountRank = sizeRank(mountSize);
  const targetRank = sizeRank(targetSize);
  return mountRank >= 0 && targetRank >= 0 && targetRank < mountRank;
}

export function damageEntryFromDamageItem(damageItem = {}) {
  return {
    oldHP: Math.max(0, Number(damageItem.oldHP) || 0),
    newHP: Math.max(0, Number(damageItem.newHP) || 0),
    oldTempHP: Math.max(0, Number(damageItem.oldTempHP) || 0),
    newTempHP: Math.max(0, Number(damageItem.newTempHP) || 0)
  };
}

export function mergeTargetDamageEntry(existing, incoming) {
  const next = damageEntryFromDamageItem(incoming);
  if (!existing) return next;
  const first = damageEntryFromDamageItem(existing);
  return {
    oldHP: first.oldHP,
    newHP: next.newHP,
    oldTempHP: first.oldTempHP,
    newTempHP: next.newTempHP
  };
}

function asTokenDocument(token) {
  return token?.document ?? token ?? null;
}

function isPhysicallyMountedRider(tokenDoc) {
  const pair = getPairFromToken(tokenDoc);
  return Boolean(pair && !pairIsTearingDown(pair.state) && tokenDoc?.uuid === pair.state.riderTokenUuid);
}

export function effectiveAuraFootprintToken(sourceToken, pairResolver = getPairFromToken) {
  if (!sourceToken) return sourceToken;
  const pair = pairResolver?.(sourceToken);
  if (!pair?.mountToken || pairIsTearingDown(pair.state) || sourceToken.uuid !== pair.state?.riderTokenUuid) return sourceToken;
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
  const fromAura = effect?.getFlag?.("auraeffects", "fromAura")
    ?? effect?.flags?.auraeffects?.fromAura
    ?? null;
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
      const matchingChildren = [...(actor.effects ?? [])]
        .filter(effect => auraChildSourceUuid(effect) === sourceEffect.uuid);
      const shouldHave = desiredActorUuids.has(actor.uuid);

      if (!shouldHave) {
        for (const child of matchingChildren) {
          if (child?.uuid) toRemove.set(child.uuid, child);
        }
        continue;
      }

      if (!matchingChildren.length) {
        (toApply[actor.uuid] ??= []).push(sourceEffect.uuid);
      }
    }
  }

  if (toRemove.size) {
    await helpers.removeAndReplaceAuras([...toRemove.values()], scene);
  }
  if (Object.keys(toApply).length) {
    await activeGM.query("auraeffects.applyAuraEffects", toApply);
  }
  return true;
}

/**
 * Reconciles the rider aura using either the mount footprint while physically
 * mounted, or the rider footprint while the pair is being dismantled.
 */
export async function reconcilePairAuraGeometry(pair, {
  physicallyMounted = true,
  helpers = null,
  activeGM = globalThis.game?.users?.activeGM ?? null
} = {}) {
  if (!pair?.riderToken) return false;
  try {
    return await reconcileMountedAuraPair(pair, {
      helpers,
      activeGM,
      footprintToken: physicallyMounted ? pair.mountToken : pair.riderToken
    });
  } catch (err) {
    console.error(`[${MODULE_ID}] Ошибка интеграции Aura Effects`, err);
    return false;
  }
}

let mountedAuraReconcileTimer = null;
let mountedAuraReconcileRunning = false;
let mountedAuraReconcileAgain = false;

export async function reconcileAllMountedAuras() {
  if (!auraEffectsIsActive() || !globalThis.canvas?.ready || !canvas.scene) return 0;
  if (!globalThis.game?.user?.isActiveGM) return 0;
  const helpers = await loadAuraEffectsHelpers();
  const activeGM = game.users?.activeGM;
  if (!helpers || !activeGM) return 0;

  let count = 0;
  for (const mountToken of canvas.scene.tokens ?? []) {
    const state = mountToken.getFlag?.(MODULE_ID, PAIR_FLAG);
    if (!state?.pairId || pairIsTearingDown(state)) continue;
    const pair = getLivePairForMutation({ state, mountToken });
    if (!pair?.riderToken) continue;
    await reconcileMountedAuraPair(pair, { helpers, activeGM });
    count += 1;
  }
  return count;
}

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
  if (animation?.then) {
    Promise.resolve(animation).finally(() => scheduleMountedAuraReconciliation());
  } else {
    scheduleMountedAuraReconciliation();
  }
}

export function registerAuraEffectsHooks(hooks = globalThis.Hooks) {
  if (!hooks?.on) return;
  hooks.on("moveToken", token => scheduleMountedAuraAfterMovement(token));
  hooks.on("updateToken", () => scheduleMountedAuraReconciliation());
  hooks.on("createToken", () => scheduleMountedAuraReconciliation());
  hooks.on("deleteToken", () => scheduleMountedAuraReconciliation());
  hooks.on("createActiveEffect", () => scheduleMountedAuraReconciliation());
  hooks.on("updateActiveEffect", () => scheduleMountedAuraReconciliation());
  hooks.on("deleteActiveEffect", () => scheduleMountedAuraReconciliation());
  hooks.on("updateActor", () => scheduleMountedAuraReconciliation());
  hooks.on("updateCombat", () => scheduleMountedAuraReconciliation());
  hooks.on("createCombatant", () => scheduleMountedAuraReconciliation());
  hooks.on("deleteCombatant", () => scheduleMountedAuraReconciliation());
}

if (typeof globalThis.Hooks !== "undefined") registerAuraEffectsHooks();

export function handleSmallThreatPreAttackConfig(workflow) {
  const riderToken = asTokenDocument(workflow?.token);
  if (!riderToken) return false;
  const pair = getPairFromToken(riderToken);
  if (!pair || pairIsTearingDown(pair.state) || riderToken.uuid !== pair.state.riderTokenUuid) return false;

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
  tracker.advantage.add(
    `${MODULE_ID}.mounted-combat.small-threat`,
    "Верховой боец: Угроза малым"
  );
  return true;
}

const midiWorkflowContexts = new Map();
const midiSuppressionByPair = new Map();
const midiMixedHealingContexts = new WeakMap();
let midiWorkflowSequence = 0;
const midiWorkflowObjectKeys = new WeakMap();

function replaceSetOrder(set, orderedValues) {
  if (!set?.clear || !set?.add) return false;
  set.clear();
  for (const value of orderedValues) set.add(value);
  return true;
}

function midiHealingActionType(workflow) {
  return workflow?.activity?.actionType ?? workflow?.item?.system?.actionType ?? workflow?.item?.system?.activation?.actionType;
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
    actionType: midiHealingActionType(workflow),
    targets: originalTargets,
    pairResolver
  });
  if (!plan.active) return false;

  midiMixedHealingContexts.set(workflow, {
    ...plan,
    originalTargets,
    originalHitTargets,
    rolledTotal: null,
    maxTotal: null
  });
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

export async function captureMixedTargetMaxHealingRoll(workflow) {
  const context = midiMixedHealingContexts.get(workflow);
  if (!context) return false;

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

function restoreMixedTargetOrder(workflow) {
  const context = midiMixedHealingContexts.get(workflow);
  if (!context) return;
  replaceSetOrder(workflow?.targets, context.originalTargets);
  if (workflow?.hitTargets && context.originalHitTargets) {
    replaceSetOrder(workflow.hitTargets, context.originalHitTargets);
  }
}

function clearMixedTargetMaxHealing(workflow) {
  restoreMixedTargetOrder(workflow);
  midiMixedHealingContexts.delete(workflow);
}

function midiWorkflowKey(workflow) {
  if (workflow && typeof workflow === "object") {
    const stable = workflow.id ?? workflow.uuid ?? workflow.itemCardUuid ?? workflow.workflowId;
    if (stable) return `id:${stable}`;
    let key = midiWorkflowObjectKeys.get(workflow);
    if (!key) {
      key = `object:${++midiWorkflowSequence}`;
      midiWorkflowObjectKeys.set(workflow, key);
    }
    return key;
  }
  return `value:${String(workflow ?? "unknown")}`;
}

function suppressPairForWorkflow(pairId, workflowKey) {
  let workflows = midiSuppressionByPair.get(pairId);
  if (!workflows) {
    workflows = new Set();
    midiSuppressionByPair.set(pairId, workflows);
  }
  workflows.add(workflowKey);
}

export function isPairMidiSuppressed(pairId) {
  return Boolean(midiSuppressionByPair.get(pairId)?.size);
}

function getOrCreateMidiContext(workflow) {
  const key = midiWorkflowKey(workflow);
  let context = midiWorkflowContexts.get(key);
  if (!context) {
    context = {
      key,
      workflow,
      isArea: isAreaWorkflow(workflow),
      pairs: new Map()
    };
    midiWorkflowContexts.set(key, context);
  }
  return context;
}

export function captureMidiTargetDamage(token, { workflow, damageItem } = {}) {
  const tokenDoc = asTokenDocument(token);
  const pair = getPairFromToken(tokenDoc);
  if (!pair?.state?.poolActive || pairIsTearingDown(pair.state) || !workflow || !damageItem) return false;

  const context = getOrCreateMidiContext(workflow);
  let pairContext = context.pairs.get(pair.state.pairId);
  if (!pairContext) {
    pairContext = {
      pairId: pair.state.pairId,
      mountTokenUuid: pair.state.mountTokenUuid,
      beforeHp: Math.max(0, Number(pair.state.sharedHp) || 0),
      beforeTemp: Math.max(0, Number(pair.state.sharedTemp) || 0),
      beforeMax: Math.max(0, Number(pair.state.sharedMax) || 0),
      targets: new Map()
    };
    context.pairs.set(pair.state.pairId, pairContext);
  }

  const targetKey = tokenDoc?.uuid ?? damageItem.targetUuid ?? damageItem.actorUuid;
  if (!targetKey) return false;

  const mixedHealing = midiMixedHealingContexts.get(workflow);
  const incoming = mixedHealing?.maxTargetUuids?.includes(targetKey)
    ? adjustHealingEntryForTargetMax(damageItem, {
        rolledTotal: mixedHealing.rolledTotal,
        maxTotal: mixedHealing.maxTotal
      })
    : damageItem;
  const existing = pairContext.targets.get(targetKey);
  pairContext.targets.set(targetKey, mergeTargetDamageEntry(existing, incoming));
  suppressPairForWorkflow(pair.state.pairId, context.key);
  return true;
}

export function releaseMidiWorkflowSuppression(workflow) {
  const key = midiWorkflowKey(workflow);
  const context = midiWorkflowContexts.get(key);
  if (context) {
    for (const pairId of context.pairs.keys()) {
      const workflows = midiSuppressionByPair.get(pairId);
      workflows?.delete(key);
      if (!workflows?.size) midiSuppressionByPair.delete(pairId);
    }
    midiWorkflowContexts.delete(key);
    clearMixedTargetMaxHealing(workflow);
    return;
  }
  for (const [pairId, workflows] of midiSuppressionByPair) {
    workflows.delete(key);
    if (!workflows.size) midiSuppressionByPair.delete(pairId);
  }
  clearMixedTargetMaxHealing(workflow);
}

export async function reconcileMidiWorkflow(workflow) {
  const key = midiWorkflowKey(workflow);
  const context = midiWorkflowContexts.get(key);
  if (!context) return false;

  const processed = [];
  try {
    for (const pairContext of context.pairs.values()) {
      const mountToken = resolveUuidSync(pairContext.mountTokenUuid) ?? await resolveUuid(pairContext.mountTokenUuid);
      const candidate = mountToken ? { state: mountToken.getFlag?.(MODULE_ID, PAIR_FLAG), mountToken } : null;
      let pair = getLivePairForMutation(candidate);
      if (!pair?.state?.poolActive || pair.state.pairId !== pairContext.pairId) continue;

      const { riderMax, mountMax } = currentIndependentMaxes(pair);
      const afterMax = riderMax + mountMax;
      const result = aggregatePoolWorkflowChanges({
        beforeHp: pairContext.beforeHp,
        beforeTemp: pairContext.beforeTemp,
        afterMax,
        isArea: context.isArea,
        entries: [...pairContext.targets.values()]
      });

      const nextState = {
        ...pair.state,
        sharedHp: result.sharedHp,
        sharedTemp: result.sharedTemp,
        sharedMax: afterMax
      };
      if (pairIsTearingDown(nextState)) continue;
      await writePairState(pair.mountToken, nextState);
      pair = getLivePairForMutation({ ...pair, state: nextState });
      if (!pair) continue;
      pair = await rebuildPoolEffects(pair);
      if (!pair) continue;
      processed.push({ pairId: pairContext.pairId, mountTokenUuid: pairContext.mountTokenUuid });
    }
  } finally {
    releaseMidiWorkflowSuppression(workflow);
  }

  for (const entry of processed) {
    if (isPairMidiSuppressed(entry.pairId)) continue;
    const mountToken = resolveUuidSync(entry.mountTokenUuid) ?? await resolveUuid(entry.mountTokenUuid);
    const state = mountToken?.getFlag?.(MODULE_ID, PAIR_FLAG);
    const pair = getLivePairForMutation({ state, mountToken });
    if (pair) await refreshCapability(pair);
  }
  return true;
}

function queueMidiReconciliation(workflow) {
  Promise.resolve()
    .then(() => reconcileMidiWorkflow(workflow))
    .catch(err => {
      releaseMidiWorkflowSuppression(workflow);
      error("Ошибка сведения общего пула после Midi-QOL", err);
    });
}

export function registerMidiHooks(hooks = globalThis.Hooks) {
  if (!hooks?.on) return;
  // These are observer/modifier hooks, not veto hooks. Never propagate helper booleans:
  // Midi-QOL interprets an explicit false from preDamageRoll as "block the roll".
  hooks.on("midi-qol.preDamageRoll", workflow => {
    prepareMixedTargetMaxHealing(workflow);
  });
  // Current Midi-QOL v13 finalizes and stores workflow.damageRolls before this hook.
  // Keep the older postDamageRoll listener as a compatibility fallback for older builds.
  hooks.on("midi-qol.DamageRollComplete", async workflow => {
    await captureMixedTargetMaxHealingRoll(workflow);
  });
  hooks.on("midi-qol.postDamageRoll", async workflow => {
    await captureMixedTargetMaxHealingRoll(workflow);
  });
  hooks.on("midi-qol.preTargetDamageApplication", (token, data) => {
    captureMidiTargetDamage(token, data);
  });
  hooks.on("midi-qol.damaged", (token, data) => {
    captureMidiTargetDamage(token, data);
  });
  hooks.on("midi-qol.healed", (token, data) => {
    captureMidiTargetDamage(token, data);
  });
  hooks.on("midi-qol.RollComplete", workflow => {
    queueMidiReconciliation(workflow);
  });
  hooks.on("midi-qol.postCleanup", workflow => {
    queueMidiReconciliation(workflow);
  });
  hooks.on("midi-qol.preAttackConfig", workflow => {
    handleSmallThreatPreAttackConfig(workflow);
  });
}

if (typeof globalThis.Hooks !== "undefined") registerMidiHooks();

async function emergencySplitPool(pair) {
  if (!pair?.state?.poolActive) return;
  const { rider, mount } = pairActors(pair);
  const riderHp = actorHpData(rider);
  const mountHp = actorHpData(mount);
  const riderMax = rider
    ? independentMaxFromHp({ max: riderHp.max, tempmax: riderHp.tempmax, moduleBonus: pair.state.riderMaxBonus })
    : Math.max(0, Number(pair.state.mountMaxBonus) || 0);
  const mountMax = mount
    ? independentMaxFromHp({ max: mountHp.max, tempmax: mountHp.tempmax, moduleBonus: pair.state.mountMaxBonus })
    : Math.max(0, Number(pair.state.riderMaxBonus) || 0);
  const hpSplit = splitSharedHp({
    sharedHp: pair.state.sharedHp,
    mountHpBeforePool: pair.state.mountHpBeforePool,
    riderMax,
    mountMax
  });
  const tempSplit = splitSharedTemp({
    sharedTemp: pair.state.sharedTemp,
    mountTempBeforePool: pair.state.mountTempBeforePool
  });

  await Promise.all([
    removeSharedMaxEffect(rider, pair.state.pairId),
    removeSharedMaxEffect(mount, pair.state.pairId)
  ]);
  await Promise.all([
    setActorHp(rider, { value: hpSplit.riderHp, temp: tempSplit.riderTemp }),
    setActorHp(mount, { value: hpSplit.mountHp, temp: tempSplit.mountTemp })
  ]);
}

export async function cleanupPairAfterTokenDeletion(deletedToken) {
  const pair = getPairFromToken(deletedToken);
  if (!pair?.state?.pairId) return false;
  const { state } = pair;
  const pairId = state.pairId;
  tearingDownPairs.add(pairId);
  cancelPairRuntimeWork(pairId);

  const deletedUuid = deletedToken?.uuid;
  const riderSurvives = pair.riderToken && pair.riderToken.uuid !== deletedUuid;
  const mountSurvives = pair.mountToken && pair.mountToken.uuid !== deletedUuid;
  const teardownPair = { ...pair, state: { ...state, tearingDown: true } };

  try {
    if (mountSurvives) await writePairState(pair.mountToken, teardownPair.state);
    if (state.poolActive) await emergencySplitPool(teardownPair);
    await removeMountedReachEffects(teardownPair);
    const toggleItem = await findPairItem(state, pair.riderToken, null);

    if (mountSurvives) {
      await pair.mountToken.update({
        "texture.src": state.visual?.mountTexture ?? pair.mountToken.texture?.src,
        sort: state.visual?.mountSort ?? pair.mountToken.sort,
        [`flags.${MODULE_ID}.-=${PAIR_FLAG}`]: null
      }, internalOptions());
    }

    if (riderSurvives) {
      await pair.riderToken.update({
        "texture.src": state.visual?.riderTexture ?? pair.riderToken.texture?.src,
        sort: state.visual?.riderSort ?? pair.riderToken.sort,
        [`flags.${MODULE_ID}.-=${RIDER_LINK_FLAG}`]: null
      }, internalOptions());
      if (auraEffectsIsActive()) {
        await reconcilePairAuraGeometry(teardownPair, { physicallyMounted: false });
      }
    }

    await renameToggleItem(toggleItem, false);
    return true;
  } finally {
    cancelPairRuntimeWork(pairId);
    tearingDownPairs.delete(pairId);
  }
}

function handleDeleteToken(document, _options, userId) {
  if (userId && globalThis.game?.user?.id && userId !== game.user.id) return;
  Promise.resolve()
    .then(() => cleanupPairAfterTokenDeletion(document))
    .catch(err => error("Ошибка аварийного разъединения верховой пары", err));
}


// ---------------------------------------------------------------------------
// Mounted weapon properties: "Верховой бой" and "Наскок"
// ---------------------------------------------------------------------------

export const MOUNTED_WEAPON_CONFIG = Object.freeze([
  Object.freeze({ prefix: "Молот всадника", mountedBonus: 2, charge: "2d2" }),
  Object.freeze({ prefix: "Кавалерийская пика", mountedBonus: 2, charge: "3d2" })
]);

const mountedWeaponMovementByActor = new Map();
const mountedWeaponChargeUsedByActor = new Map();
const mountedWeaponProcessedWorkflows = new WeakSet();

export function mountedWeaponProfile(itemName) {
  const name = String(itemName ?? "");
  const profile = MOUNTED_WEAPON_CONFIG.find(entry => name.startsWith(entry.prefix));
  return profile ? { ...profile } : null;
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

export function planMountedWeaponDamage({
  itemName,
  actionType,
  physicallyMounted,
  mountSize,
  targetSize,
  inCombat,
  chargeUsed,
  chargeDistance,
  movedTowardTarget
}) {
  const profile = mountedWeaponProfile(itemName);
  if (!profile || String(actionType ?? "").toLowerCase() !== "mwak") {
    return { formula: null, mountedBonus: 0, chargeFormula: null, consumeCharge: false };
  }

  const mountedBonus = shouldGrantMountedWeaponBonus({ physicallyMounted, mountSize, targetSize })
    ? profile.mountedBonus
    : 0;
  const chargeFormula = inCombat
    && !chargeUsed
    && Number(chargeDistance) >= 10
    && movedTowardTarget
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
  return {
    x: xy.x + ((width * gridSize) / 2),
    y: xy.y + ((height * gridSize) / 2)
  };
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
  if (!pair || pairIsTearingDown(pair.state)) return { actor: document?.actor ?? null, pair: null };
  if (document.uuid === pair.state.mountTokenUuid) return { actor: pair.riderToken?.actor ?? null, pair };
  // Physical rider movement is either cancelled and rerouted to the mount, or is our internal follow-up sync.
  if (document.uuid === pair.state.riderTokenUuid) return { actor: null, pair };
  return { actor: document?.actor ?? null, pair: null };
}

export function recordMountedWeaponMovement(document, movement, operation, user) {
  if (isInternal(operation)) return false;
  if (user?.id && globalThis.game?.user?.id && user.id !== game.user.id) return false;
  const turnKey = combatTurnKey(globalThis.game?.combat);
  if (!turnKey) return false;

  const { actor } = logicalMovementActor(document);
  if (!actor?.uuid) return false;
  const segment = movementStraightSegment(document, movement);
  if (!segment) return false;

  const previous = mountedWeaponMovementByActor.get(actor.uuid);
  const merged = previous?.turnKey === turnKey
    ? mergeStraightSegments(previous.segment, segment)
    : segment;
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
  if (!riderToken) return null;
  const pair = getPairFromToken(riderToken);
  if (!pair || pairIsTearingDown(pair.state) || riderToken.uuid !== pair.state.riderTokenUuid) return null;
  return pair;
}

function chargeStateForWorkflow(workflow, target) {
  const actorUuid = workflow?.actor?.uuid;
  const turnKey = combatTurnKey(globalThis.game?.combat);
  if (!actorUuid || !turnKey) return {
    inCombat: false,
    chargeUsed: false,
    chargeDistance: 0,
    movedTowardTarget: false,
    turnKey: null
  };
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
  const profile = mountedWeaponProfile(workflow?.item?.name);
  if (!profile || String(actionTypeForWorkflow(workflow) ?? "").toLowerCase() !== "mwak") return false;
  const target = hitTargetForWeaponWorkflow(workflow);
  if (!target) return false;

  const pair = physicalRiderPairForWorkflow(workflow);
  const charge = chargeStateForWorkflow(workflow, target);
  const plan = planMountedWeaponDamage({
    itemName: workflow.item.name,
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

function registerMountedWeaponHooks(hooks = globalThis.Hooks) {
  if (!hooks?.on) return;
  hooks.on("moveToken", (document, movement, operation, user) => {
    recordMountedWeaponMovement(document, movement, operation, user);
  });
  hooks.on("midi-qol.DamageRollComplete", async workflow => {
    try {
      await applyMountedWeaponDamage(workflow);
    } catch (err) {
      error("Ошибка автоматизации свойств верхового оружия", err);
    }
  });
}

if (typeof globalThis.Hooks !== "undefined") registerMountedWeaponHooks();

if (typeof globalThis.Hooks !== "undefined") Hooks.on("deleteToken", handleDeleteToken);

async function cleanupBrokenPairState(state, mountToken, riderToken = null) {
  if (!state?.pairId || !mountToken) return false;
  const pairId = state.pairId;
  tearingDownPairs.add(pairId);
  cancelPairRuntimeWork(pairId);
  const pair = { state: { ...state, tearingDown: true }, mountToken, riderToken };
  try {
    if (state.poolActive && riderToken) await emergencySplitPool(pair);
    await removeMountedReachEffects(pair);
    const toggleItem = riderToken ? await findPairItem(state, riderToken, null) : null;

    if (riderToken) {
      await riderToken.update({
        "texture.src": state.visual?.riderTexture ?? riderToken.texture?.src,
        sort: state.visual?.riderSort ?? riderToken.sort,
        [`flags.${MODULE_ID}.-=${RIDER_LINK_FLAG}`]: null
      }, internalOptions());
    }
    await mountToken.update({
      "texture.src": state.visual?.mountTexture ?? mountToken.texture?.src,
      sort: state.visual?.mountSort ?? mountToken.sort,
      [`flags.${MODULE_ID}.-=${PAIR_FLAG}`]: null
    }, internalOptions());

    if (riderToken && auraEffectsIsActive()) {
      await reconcilePairAuraGeometry(pair, { physicallyMounted: false });
    }
    await renameToggleItem(toggleItem, false);
    return true;
  } finally {
    cancelPairRuntimeWork(pairId);
    tearingDownPairs.delete(pairId);
  }
}

export async function repairMountedPairsOnCanvas() {
  if (!globalThis.canvas?.ready || !canvas.scene) return 0;

  let repaired = 0;
  for (const mountToken of canvas.scene.tokens ?? []) {
    const state = mountToken.getFlag?.(MODULE_ID, PAIR_FLAG);
    if (!state?.pairId || !state.riderTokenUuid) continue;

    const riderToken = resolveUuidSync(state.riderTokenUuid);
    const link = riderToken?.getFlag?.(MODULE_ID, RIDER_LINK_FLAG);
    const toggleItem = riderToken ? await findPairItem(state, riderToken, null) : null;
    const validLink = Boolean(
      riderToken
      && link?.pairId === state.pairId
      && link?.mountTokenUuid === mountToken.uuid
      && !state.tearingDown
    );
    const itemAlreadyDismounted = toggleItem?.name === MOUNTED_COMBAT_CONFIG.mountItemName;

    // A missing/mismatched half, a persisted teardown marker, or an item which
    // already says "mount" means teardown residue. Never resurrect it.
    if (!validLink || itemAlreadyDismounted) {
      await cleanupBrokenPairState(state, mountToken, riderToken);
      repaired += 1;
      continue;
    }

    let pair = getLivePairForMutation({ state, mountToken, riderToken });
    if (!pair) {
      await cleanupBrokenPairState(state, mountToken, riderToken);
      repaired += 1;
      continue;
    }

    await renameToggleItem(toggleItem, true);
    await syncRiderToMount(pair);
    pair = getLivePairForMutation(pair);
    if (!pair) continue;
    await ensureMountedReachEffects(pair);
    await refreshCapability(pair);
    if (auraEffectsIsActive() && globalThis.game?.user?.isActiveGM) {
      await reconcilePairAuraGeometry(pair, { physicallyMounted: true });
    }
    repaired += 1;
  }

  // Also clear rider-side links whose mount-side state disappeared completely.
  // New pairs keep rider texture/sort in this link so the visual can be restored.
  for (const riderToken of canvas.scene.tokens ?? []) {
    const link = riderToken.getFlag?.(MODULE_ID, RIDER_LINK_FLAG);
    if (!link?.pairId || !link.mountTokenUuid) continue;
    const mountToken = resolveUuidSync(link.mountTokenUuid);
    const state = mountToken?.getFlag?.(MODULE_ID, PAIR_FLAG);
    if (state?.pairId === link.pairId && !state.tearingDown) continue;

    await removeMountedReachEffect(riderToken.actor, link.pairId);
    await riderToken.update({
      ...(link.riderTexture ? { "texture.src": link.riderTexture } : {}),
      ...(Number.isFinite(Number(link.riderSort)) ? { sort: Number(link.riderSort) } : {}),
      [`flags.${MODULE_ID}.-=${RIDER_LINK_FLAG}`]: null
    }, internalOptions());
    const toggleItem = link.itemUuid
      ? await resolveUuid(link.itemUuid)
      : riderToken.actor?.items?.find?.(i => isMountToggleItemName(i.name));
    await renameToggleItem(toggleItem, false);
    repaired += 1;
  }
  return repaired;
}
