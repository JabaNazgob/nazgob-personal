// Остальные верховые механики модуля после перехода на «Одно целое».
import test from "node:test";
import assert from "node:assert/strict";
import * as mod from "../scripts/mounted-combat-v0.2.0.js";

test("угроза малым: только mwak верхом против цели меньше скакуна", () => {
  assert.equal(mod.shouldGrantSmallThreat({ poolActive: true, actionType: "mwak", mountSize: "lg", targetSize: "med" }), true);
  assert.equal(mod.shouldGrantSmallThreat({ poolActive: true, actionType: "rwak", mountSize: "lg", targetSize: "med" }), false);
  assert.equal(mod.shouldGrantSmallThreat({ poolActive: false, actionType: "mwak", mountSize: "lg", targetSize: "med" }), false);
});

test("верховой бой и наскок", () => {
  const item = { system: { properties: new Set(["lchMounted", "lchDash"]) }, flags: { "rebreya-main": { lichWeaponPropertyValues: { dashDice: "2d2" } } } };
  const plan = mod.planMountedWeaponDamage({
    item, actionType: "mwak", physicallyMounted: true, mountSize: "lg", targetSize: "med",
    inCombat: true, chargeUsed: false, chargeDistance: 10, movedTowardTarget: true
  });
  assert.equal(plan.formula, "2 + 2d2");
});

test("эффект досягаемости строится для наездника", () => {
  const data = mod.buildMountedReachEffectData({ riderActorId: "abc", customMode: 0 });
  assert.deepEqual(data.changes.map(change => change.key), [
    "flags.midi-qol.rangeOverride.attack.mwak",
    "flags.midi-qol.rangeOverride.attack.msak"
  ]);
  assert.equal(data.flags["nazgob-personal"].oneWholeReach, true);
});

test("max-heal смешанной пары даёт множитель лечения для цели с грантом", () => {
  const maxActor = { flags: { "midi-qol": { grants: { max: { damage: { heal: true } } } } } };
  const rider = { uuid: "r", actor: maxActor };
  const mount = { uuid: "m", actor: {} };
  const pair = { state: { pairId: "p", poolActive: true, riderTokenUuid: "r", mountTokenUuid: "m" } };
  const workflow = { activity: { actionType: "heal" }, targets: new Set([rider, mount]), hitTargets: new Set([rider, mount]) };
  assert.equal(mod.prepareMixedTargetMaxHealing(workflow, () => pair), true);
  assert.deepEqual([...workflow.targets].map(token => token.uuid), ["m", "r"]);
});

test("макросы собраны из актуальных ядер", async () => {
  const { buildMacros } = await import("../tools/build-macro.mjs");
  const { readFile } = await import("node:fs/promises");
  for (const [path, macro] of await buildMacros()) {
    assert.equal(await readFile(new URL(`../${path}`, import.meta.url), "utf8"), macro, path);
  }
});

test("верховое оружие: свойства ребреи, любые атаки оружием", () => {
  const base = { physicallyMounted: true, mountSize: "lg", targetSize: "med", inCombat: true, chargeUsed: false, chargeDistance: 10, movedTowardTarget: true };
  const weapon = (properties, dashDice) => ({
    system: { properties: new Set(properties) },
    flags: dashDice ? { "rebreya-main": { lichWeaponPropertyValues: { dashDice } } } : {}
  });
  // Лук всадника и Драгун: «Верховой бой» у дальнобойного оружия.
  assert.equal(mod.planMountedWeaponDamage({ ...base, item: weapon(["lchMounted"]), actionType: "rwak" }).formula, "2");
  assert.equal(mod.planMountedWeaponDamage({ ...base, item: weapon(["lchMounted"]), actionType: "fwak" }).formula, "2");
  // Кости наскока без свойства «Наскок» не считаются.
  assert.equal(mod.planMountedWeaponDamage({ ...base, item: weapon([], "2d2"), actionType: "mwak" }).formula, null);
  // Русская запись костей из листа ребреи.
  assert.equal(mod.planMountedWeaponDamage({ ...base, item: weapon(["lchDash"], "1к2"), actionType: "mwak" }).formula, "1d2");
  // Не атака оружием.
  assert.equal(mod.planMountedWeaponDamage({ ...base, item: weapon(["lchMounted"]), actionType: "msak" }).formula, null);
});

test("огнестрел: огнестрел и тип — из данных ребреи, не из названия", async () => {
  const { firearmTypeOf, isFirearmJammed } = await import("../scripts/firearm-animations-v0.2.0.js");
  const firearm = (gearId, extra = {}) => ({
    name: "что угодно",
    type: "weapon",
    system: { type: { value: "firearmPrimitive" } },
    flags: { "rebreya-main": { gearId, ...extra } }
  });
  assert.equal(firearmTypeOf(firearm("vintovka")), "vintovka");
  assert.equal(firearmTypeOf(firearm("tyazhelaya-vintovka")), "tyazhelaya-vintovka");
  assert.equal(firearmTypeOf(firearm("arkebuza")), "arkebuza");
  assert.equal(firearmTypeOf(firearm("mushket")), "mushket");
  assert.equal(firearmTypeOf(firearm("mushketon")), null); // огнестрел без профиля
  // Название не важно: «Мушкет» без данных ребреи — не огнестрел.
  assert.equal(firearmTypeOf({ name: "Мушкет", type: "weapon", system: { type: { value: "martialR" } } }), null);
  // Огнестрел по флагу firearmClass, как в ребрее.
  assert.equal(firearmTypeOf({ type: "weapon", system: { type: { value: "" } }, flags: { "rebreya-main": { gearId: "mushket", firearmClass: "primitive" } } }), "mushket");
  assert.equal(firearmTypeOf({ type: "consumable", flags: { "rebreya-main": { gearId: "mushket", firearmClass: "primitive" } } }), null);
  assert.equal(isFirearmJammed(firearm("mushket", { firearmJammed: { value: true } })), true);
  assert.equal(isFirearmJammed(firearm("mushket")), false);
});

test("огнестрел: профили по оружию, вид перезарядки и геометрия", async () => {
  const { firearmProfile, mergeProfile, reloadKindOf, aimDirection, muzzlePoint, casingPath } = await import("../scripts/firearm-animations-v0.2.0.js");
  const revolverSound = "psfx.ranged-weapons.guns.single-fire.revolver";
  // Продвинутое: нынешний звук, смена магазина — свой звук, без облака.
  for (const id of ["revol-ver", "karabin", "vintovka", "tyazhelaya-vintovka"]) {
    const profile = firearmProfile(id);
    if (id === "tyazhelaya-vintovka") assert.equal(profile.shot.sound.file, "assets/audio/sound/item sound/shot-heavy-SR.wav");
    else assert.equal(profile.shot.sound.file, revolverSound, id);
    assert.equal(profile.shot.cloud, null, id);
    assert.match(profile.reload.magazine.sound.file, /reload-rifle\.mp3$/, id);
    assert.equal(profile.reload.magazine.casing, undefined, id);
  }
  // Затвор после выстрела — только у винтовок.
  assert.equal(firearmProfile("revol-ver").afterShot, null);
  assert.equal(firearmProfile("karabin").afterShot, null);
  assert.equal(firearmProfile("vintovka").afterShot.sound.file, "assets/audio/sound/item sound/bolt.ogg");
  assert.ok(firearmProfile("tyazhelaya-vintovka").afterShot.delayMax > firearmProfile("tyazhelaya-vintovka").afterShot.delayMin);
  // Примитивное: другой звук, облако на стрелке, без перезарядки.
  for (const id of ["arkebuza", "mushket"]) {
    const profile = firearmProfile(id);
    assert.notEqual(profile.shot.sound.file, revolverSound, id);
    assert.equal(profile.shot.cloud.file, "jb2a.smoke.plumes_loop.01.grey", id);
    assert.equal(profile.reload, null, id);
    assert.equal(profile.afterShot, null, id);
  }
  // Очистки затвора в профилях нет.
  assert.equal(firearmProfile("vintovka").clearJam, undefined);

  // Правки из макроса не портят профили.
  const tuned = firearmProfile("arkebuza", { arkebuza: { shot: { sound: { volume: 0.5 }, smoke: null } } });
  assert.equal(tuned.shot.sound.volume, 0.5);
  assert.equal(tuned.shot.smoke, null);
  assert.equal(firearmProfile("arkebuza").shot.sound.volume, 0.9);
  assert.deepEqual(mergeProfile({ a: [1, 2], b: { c: 1 } }, { a: [3], b: { d: 2 } }), { a: [3], b: { c: 1, d: 2 } });

  // Вид перезарядки — из значения свойства ребреи.
  const reload = text => reloadKindOf({ flags: { "rebreya-main": { lichWeaponPropertyValues: { reload: text } } } });
  assert.equal(reload("Смена магазина 6"), "magazine");
  assert.equal(reload("Долгая смена магазина 4"), "magazine");
  assert.equal(reload("Перезарядка 1"), "single");
  assert.equal(reload("Долгая перезарядка 1"), "single");
  assert.equal(reload("Безмагазинное 2"), "breechless");
  assert.equal(reload(""), null);

  const source = { center: { x: 100, y: 100 }, w: 100, h: 100, document: { rotation: 90 } };
  const target = { center: { x: 100, y: 400 } };
  assert.deepEqual(aimDirection(source, target), { x: 0, y: 1 });
  const right = aimDirection(source); // без цели — по повороту токена (90° — вправо)
  assert.ok(Math.abs(right.x - 1) < 1e-9 && Math.abs(right.y) < 1e-9);
  assert.deepEqual(muzzlePoint(source, { x: 0, y: 1 }, 100), { x: 100, y: 142 });
  const casing = casingPath(source, { x: 0, y: 1 }, 100, () => 0);
  // Ствол вниз → правая сторона — влево по x, гильза назад — вверх по y.
  assert.deepEqual(casing.origin, { x: 90, y: 104 });
  assert.deepEqual(casing.end, { x: 52, y: 99 });
  assert.equal(casing.spin, 900);
});

test("огнестрел: выстрелы, затвор, клин, перезарядка ребреи и снятие", async () => {
  const { installFirearmAnimations } = await import("../scripts/firearm-animations-v0.2.0.js");
  const hooks = new Map();
  let ids = 0;
  globalThis.Hooks = {
    on(name, fn) { const id = ++ids; (hooks.get(name) ?? hooks.set(name, new Map()).get(name)).set(id, fn); return id; },
    once(name, fn) { return this.on(name, fn); },
    off(name, id) { hooks.get(name)?.delete(id); },
    callAll(name, ...args) { for (const fn of [...(hooks.get(name)?.values() ?? [])]) fn(...args); }
  };
  const played = [];
  globalThis.Sequence = class {
    constructor() { this.calls = []; }
    effect() { return this.#chain("effect"); }
    sound() { return this.#chain("sound"); }
    #chain(kind) {
      const entry = [kind];
      this.calls.push(entry);
      const proxy = new Proxy({}, { get: (_, key) => (...args) => { entry.push([key, args[0]]); return proxy; } });
      return proxy;
    }
    async play() { played.push(this.calls); }
  };
  class ServiceBase {
    async reloadFirearm(weapon) { return { success: true, loaded: weapon.loaded, weaponId: weapon.id }; }
    async clearFirearmJam() { return { isJammed: false }; }
  }
  const service = new ServiceBase();
  const token = { center: { x: 0, y: 0 }, w: 100, h: 100, document: { uuid: "s", rotation: 0 } };
  const target = { center: { x: 0, y: 500 }, document: { uuid: "t" } };
  const weapon = (gearId, { reload = "", ...extra } = {}) => ({
    documentName: "Item", type: "weapon", name: gearId, id: gearId,
    system: { type: { value: "firearmAdvanced" } },
    flags: { "rebreya-main": { gearId, lichWeaponPropertyValues: { reload }, ...extra } },
    actor: { getActiveTokens: () => [token] }
  });
  globalThis.game = { modules: new Map([["sequencer", { active: true }]]), user: { targets: new Set() }, rebreyaMain: { combatAttackService: service } };
  globalThis.canvas = { dimensions: { size: 100 }, tokens: { controlled: [] } };
  const settle = () => new Promise(resolve => setTimeout(resolve, 5));
  const files = sequence => sequence.flatMap(([, ...calls]) => calls.filter(([key]) => key === "file").map(([, file]) => file));
  const shoot = async (item, hit = false) => {
    Hooks.callAll("midi-qol.AttackRollComplete", { item, token, targets: new Set([target]), hitTargets: new Set(hit ? [target] : []) });
    await settle();
    return played.pop();
  };
  const bolt = "assets/audio/sound/item sound/bolt.ogg";
  const jam = "assets/audio/sound/item sound/jam.ogg";

  const api = installFirearmAnimations();

  // Винтовка: выстрел, попадание, затвор с гильзой.
  const rifle = await shoot(weapon("vintovka"), true);
  assert.deepEqual(files(rifle).slice(0, 5), [
    "psfx.ranged-weapons.guns.single-fire.revolver", "jb2a.explosion_side.01.orange.0", "jb2a.smoke.puff.side.grey.0",
    "jb2a.bullet.01.orange", "jb2a.impact.012.orange"
  ]);
  assert.equal(files(rifle)[5], bolt);
  assert.ok(rifle.some(([, ...calls]) => calls.some(([key, value]) => key === "shape" && value === "roundedRect")));
  const boltDelay = rifle.find(([kind, ...calls]) => kind === "sound" && calls.some(([key, value]) => key === "file" && value === bolt))
    .find(entry => entry[0] === "delay")[1];
  assert.ok(boltDelay >= 250 && boltDelay <= 600, `пауза затвора ${boltDelay}`);

  // Винтовка с клином: клин вместо затвора.
  const jammedRifle = await shoot(weapon("vintovka", { firearmJammed: { value: true } }));
  assert.ok(files(jammedRifle).includes(jam));
  assert.ok(!files(jammedRifle).includes(bolt));

  // Карабин: без затвора.
  assert.ok(!files(await shoot(weapon("karabin"))).includes(bolt));

  // Аркебуза: глухой выстрел и облако на стрелке.
  const arquebus = await shoot({ ...weapon("arkebuza"), system: { type: { value: "firearmPrimitive" } } });
  assert.match(files(arquebus)[0], /musket-shot\.wav$/);
  const cloud = arquebus.find(([, ...calls]) => calls.some(([key, value]) => key === "file" && value === "jb2a.smoke.plumes_loop.01.grey"));
  assert.equal(cloud.find(([key]) => key === "atLocation")[1], token);
  assert.ok(cloud.some(([key]) => key === "fadeOut"));

  // Перезарядка: смена магазина — свой звук, без гильзы.
  await service.reloadFirearm({ ...weapon("vintovka", { reload: "Смена магазина 6" }), loaded: 6 });
  await settle();
  const magazine = played.pop();
  assert.deepEqual(files(magazine), ["assets/audio/sound/item sound/reload-rifle.mp3"]);
  assert.ok(!magazine.some(([, ...calls]) => calls.some(([key]) => key === "shape")));

  // Без анимации: примитивная перезарядка, ничего не заряжено, очистка затвора,
  // огнестрел без профиля, «Мушкет» без данных ребреи.
  await service.reloadFirearm({ ...weapon("arkebuza", { reload: "Перезарядка 1" }), loaded: 1 });
  await service.reloadFirearm({ ...weapon("vintovka", { reload: "Смена магазина 6" }), loaded: 0 });
  await service.clearFirearmJam(weapon("vintovka"));
  await shoot(weapon("mushketon"));
  await shoot({ name: "Мушкет", type: "weapon", system: { type: { value: "martialR" } } });
  await settle();
  assert.equal(played.length, 0);

  api.uninstall();
  assert.equal(Object.hasOwn(service, "reloadFirearm"), false);
  assert.equal(Object.hasOwn(service, "clearFirearmJam"), false);
  assert.equal(hooks.get("midi-qol.AttackRollComplete").size, 0);
});
