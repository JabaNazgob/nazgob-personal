// Тесты «Одного целого»: чистые функции и вся механика на имитации Foundry.
// Это не запуск самого Foundry: имитация повторяет только то поведение
// документов, на которое опирается механика (ХП dnd5e, эффекты, движение V13).
import test from "node:test";
import assert from "node:assert/strict";
import {
  splitSharedHp,
  resolvePoolBatch,
  mountTextureUpdate,
  installOneWhole
} from "../scripts/one-whole-v0.2.0.js";

const ID = "nazgob-personal";
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const settle = () => wait(320); // окно сбора событий 200 мс + очередь

// ---------------------------------------------------------------------------
// Чистые функции
// ---------------------------------------------------------------------------

test("split: скакун получает прежние хиты, остаток — наезднику, излишек — скакуну", () => {
  assert.deepEqual(splitSharedHp({ sharedHp: 50, mountHpBeforePool: 20, riderMax: 40, mountMax: 30 }), { riderHp: 30, mountHp: 20 });
  assert.deepEqual(splitSharedHp({ sharedHp: 15, mountHpBeforePool: 20, riderMax: 40, mountMax: 30 }), { riderHp: 0, mountHp: 15 });
  assert.deepEqual(splitSharedHp({ sharedHp: 65, mountHpBeforePool: 20, riderMax: 40, mountMax: 30 }), { riderHp: 40, mountHp: 25 });
  assert.deepEqual(splitSharedHp({ sharedHp: 0, mountHpBeforePool: 20, riderMax: 40, mountMax: 30 }), { riderHp: 0, mountHp: 0 });
});

test("batch: урон по одному — больший из своего и урона партнёра", () => {
  const events = [{ role: "rider", dValue: -10, dTemp: 0, beforeTemp: 0, cross: 20 }];
  assert.equal(resolvePoolBatch({ base: { value: 60, temp: 0 }, events }).value, 40);
});

test("batch: урон по обоим в одном источнике — больший один раз", () => {
  const events = [
    { role: "rider", dValue: -5, dTemp: 0, beforeTemp: 0, group: "w1", bothHit: true, cross: null },
    { role: "mount", dValue: -12, dTemp: 0, beforeTemp: 0, group: "w1", bothHit: true, cross: null }
  ];
  assert.equal(resolvePoolBatch({ base: { value: 60, temp: 0 }, events }).value, 48);
});

test("batch: оба задеты, но один получил 0 — партнёрский cross не применяется", () => {
  const events = [{ role: "mount", dValue: -10, dTemp: 0, beforeTemp: 0, group: "w1", bothHit: true, cross: null }];
  assert.equal(resolvePoolBatch({ base: { value: 60, temp: 0 }, events }).value, 50);
});

test("batch: разные источники суммируются, лечение суммируется и ограничено максимумом", () => {
  const events = [
    { role: "rider", dValue: -10, dTemp: 0, beforeTemp: 0, group: "a" },
    { role: "mount", dValue: -7, dTemp: 0, beforeTemp: 0, group: "b" },
    { role: "rider", dValue: 4, dTemp: 0, beforeTemp: 0 },
    { role: "mount", dValue: 2, dTemp: 0, beforeTemp: 0 }
  ];
  assert.equal(resolvePoolBatch({ base: { value: 60, temp: 0 }, events, maxPool: 100 }).value, 49);
  assert.equal(resolvePoolBatch({ base: { value: 98, temp: 0 }, events: events.slice(2), maxPool: 100 }).value, 100);
});

test("batch: общие временные хиты снимаются первыми и не складываются", () => {
  const damage = [{ role: "rider", dValue: -2, dTemp: -5, beforeTemp: 5 }];
  assert.deepEqual(
    (({ value, temp }) => ({ value, temp }))(resolvePoolBatch({ base: { value: 60, temp: 5 }, events: damage })),
    { value: 58, temp: 0 }
  );
  const gain = [{ role: "mount", dValue: 0, dTemp: 3, beforeTemp: 5 }];
  assert.equal(resolvePoolBatch({ base: { value: 60, temp: 5 }, events: gain }).temp, 8);
});

test("batch: max-heal множитель увеличивает лечение цели", () => {
  const events = [
    { role: "rider", dValue: 2, dTemp: 0, beforeTemp: 0, healScale: 2 },
    { role: "mount", dValue: 2, dTemp: 0, beforeTemp: 0 }
  ];
  assert.equal(resolvePoolBatch({ base: { value: 10, temp: 0 }, events, maxPool: 100 }).value, 16);
});

test("texture: исходное изображение сохраняется во флаге и возвращается", () => {
  const token = { texture: { src: "horse.webp", scaleX: -1, scaleY: 1 }, flags: {} };
  const on = mountTextureUpdate(token, { active: true, mountedImage: "pair.webp", mountedScale: 1.2 });
  assert.equal(on["texture.src"], "pair.webp");
  assert.equal(on["texture.scaleX"], -1.2);
  assert.deepEqual(on[`flags.${ID}.oneWholeOriginalTexture`], { src: "horse.webp", scaleX: -1, scaleY: 1 });
  const paired = { texture: { src: "pair.webp", scaleX: -1.2, scaleY: 1.2 }, flags: { [ID]: { oneWholeOriginalTexture: { src: "horse.webp", scaleX: -1, scaleY: 1 } } } };
  assert.equal(mountTextureUpdate(paired, { active: true, mountedImage: "pair.webp", mountedScale: 1.2 }), null);
  const off = mountTextureUpdate(paired, { active: false, mountedImage: "pair.webp" });
  assert.equal(off["texture.src"], "horse.webp");
  assert.equal(off[`flags.${ID}.-=oneWholeOriginalTexture`], null);
});

// ---------------------------------------------------------------------------
// Имитация Foundry
// ---------------------------------------------------------------------------

function expand(flat) {
  const out = {};
  for (const [path, value] of Object.entries(flat)) {
    const keys = path.split(".");
    let target = out;
    for (const key of keys.slice(0, -1)) target = target[key] ??= {};
    target[keys.at(-1)] = value;
  }
  return out;
}

function applyFlat(target, flat) {
  for (const [path, value] of Object.entries(flat)) {
    const keys = path.split(".");
    let node = target;
    for (const key of keys.slice(0, -1)) node = node[key] ??= {};
    const last = keys.at(-1);
    if (last.startsWith("-=")) delete node[last.slice(2)];
    else node[last] = structuredClone(value);
  }
}

function collection(items = []) {
  const list = [...items];
  return Object.assign(list, {
    get: id => list.find(item => item.id === id),
    delete(id) { const index = list.findIndex(item => item.id === id); if (index >= 0) list.splice(index, 1); }
  });
}

function world() {
  const hooks = new Map();
  let hookId = 0;
  globalThis.Hooks = {
    on(name, fn) { const id = ++hookId; (hooks.get(name) ?? hooks.set(name, new Map()).get(name)).set(id, fn); return id; },
    off(name, id) { hooks.get(name)?.delete(id); },
    callAll(name, ...args) { for (const fn of [...(hooks.get(name)?.values() ?? [])]) fn(...args); return true; },
    call(name, ...args) {
      for (const fn of [...(hooks.get(name)?.values() ?? [])]) if (fn(...args) === false) return false;
      return true;
    }
  };
  let ids = 0;
  const randomID = () => `id${String(++ids).padStart(14, "0")}`;
  globalThis.foundry = {
    utils: {
      deepClone: value => structuredClone(value),
      randomID,
      hasProperty: (object, path) => path.split(".").reduce((node, key) => (node && key in node ? node[key] : undefined), object) !== undefined
    },
    applications: { api: { DialogV2: { confirm: async () => world.answer } } }
  };
  globalThis.CONST = { ACTIVE_EFFECT_MODES: { CUSTOM: 0, ADD: 2 } };
  globalThis.ui = { notifications: { info() {}, warn() {}, error(message) { world.errors.push(message); } } };
  globalThis.canvas = { ready: false };
  Number.isNumeric ??= value => Number.isFinite(Number(value));
  const tick = () => new Promise(resolve => setImmediate(resolve));

  class Actor {
    constructor(id, { value, max, temp = 0, traits = {} }) {
      Object.assign(this, { id, uuid: `Actor.${id}`, isToken: false, isOwner: true, documentName: "Actor", flags: {}, traits });
      this._source = { hp: { value, max, temp, tempmax: 0 } };
      this.effects = collection();
      this.prototypeToken = { texture: { src: `${id}.webp`, scaleX: 1, scaleY: 1 } };
      this.prepare();
    }
    prepare() {
      const bonus = this.effects.filter(effect => !effect.disabled)
        .flatMap(effect => effect.changes)
        .filter(change => change.key === "system.attributes.hp.tempmax" && Number(change.mode) === 2)
        .reduce((sum, change) => sum + Number(change.value), 0);
      const hp = { ...this._source.hp };
      hp.effectiveMax = hp.max + hp.tempmax + bonus;
      hp.value = Math.min(hp.value, hp.effectiveMax);
      this.system = { attributes: { hp } };
    }
    testUserPermission() { return true; }
    async update(data, options = {}) {
      // Как в Foundry: «до» берётся при запросе, данные меняются вместе с хуком.
      options.dnd5e = { ...(options.dnd5e ?? {}), hp: { ...this.system.attributes.hp } };
      await tick();
      const source = { system: { attributes: { hp: this._source.hp } }, flags: this.flags };
      applyFlat(source, data);
      this.flags = source.flags;
      this.prepare();
      Hooks.callAll("updateActor", this, expand(data), options, world.userId);
      return this;
    }
    async createEmbeddedDocuments(_type, entries, options = {}) {
      await tick();
      const created = [];
      for (const data of entries) {
        const id = options.keepId && data._id ? data._id : randomID();
        if (this.effects.get(id)) throw new Error(`ActiveEffect ${id} already exists`);
        const actor = this;
        const effect = {
          ...structuredClone(data), id, parent: actor,
          async update(changes, opts = {}) { Object.assign(this, structuredClone(changes)); actor.prepare(); await tick(); Hooks.callAll("updateActiveEffect", this, changes, opts, world.userId); }
        };
        this.effects.push(effect);
        created.push(effect);
      }
      this.prepare();
      for (const effect of created) Hooks.callAll("createActiveEffect", effect, options, world.userId);
      return created;
    }
    async deleteEmbeddedDocuments(_type, idsToDelete, options = {}) {
      await tick();
      for (const id of idsToDelete) {
        const effect = this.effects.get(id);
        this.effects.delete(id);
        this.prepare();
        Hooks.callAll("deleteActiveEffect", effect, options, world.userId);
      }
    }
    calculateDamage(damages, options = {}) {
      const result = structuredClone(damages);
      result.amount = 0;
      for (const damage of result) {
        let multiplier = options.multiplier ?? 1;
        if (this.traits.dv?.includes(damage.type)) multiplier *= 2;
        if (this.traits.dr?.includes(damage.type)) multiplier /= 2;
        result.amount += damage.value * multiplier;
      }
      result.amount = Math.floor(result.amount);
      result.temp = 0;
      return result;
    }
    // Как dnd5e Actor5e#applyDamage
    async applyDamage(damages, options = {}) {
      const hp = this.system.attributes.hp;
      const { amount } = this.calculateDamage(damages, options);
      const deltaTemp = amount > 0 ? Math.min(hp.temp, amount) : 0;
      const deltaHP = Math.max(Math.min(amount - deltaTemp, hp.value), -(hp.effectiveMax - hp.value));
      const updates = { "system.attributes.hp.temp": hp.temp - deltaTemp, "system.attributes.hp.value": hp.value - deltaHP };
      if (Hooks.call("dnd5e.preApplyDamage", this, amount, updates, options) === false) return this;
      await this.update(updates);
      return this;
    }
  }
  globalThis.CONFIG = { Actor: { documentClass: Actor }, queries: {} };

  class Token {
    constructor(scene, actor, { x, y, width, height }) {
      Object.assign(this, { id: randomID(), parent: scene, actorId: actor.id, actorLink: true, x, y, elevation: 0, width, height, sort: 0, flags: {} });
      this.uuid = `Scene.${scene.id}.Token.${this.id}`;
      this.texture = { ...actor.prototypeToken.texture };
    }
    get actor() { return world.actors.get(this.actorId); }
    async update(data, options = {}) {
      await tick();
      applyFlat(this, data);
      Hooks.callAll("updateToken", this, expand(data), options, world.userId);
    }
    async move(waypoints, options = {}) {
      const passed = waypoints.map(waypoint => ({ ...waypoint }));
      const destination = passed.at(-1);
      const movement = { passed: { waypoints: passed }, pending: { waypoints: [] }, destination, method: options.method ?? "api", constrainOptions: options.constrainOptions ?? {} };
      const operation = { ...options, movement: { [this.id]: {} } };
      if (Hooks.call("preMoveToken", this, movement, operation) === false) return false;
      await tick();
      Object.assign(this, { x: destination.x, y: destination.y, elevation: destination.elevation ?? this.elevation });
      world.moves.push({ token: this, options });
      Hooks.callAll("moveToken", this, movement, operation, { id: world.userId });
      return true;
    }
  }

  class Scene {
    constructor(id) { Object.assign(this, { id, tokens: collection(), grid: { size: 100 } }); }
    async updateEmbeddedDocuments(_type, updates, options) {
      for (const { _id, ...data } of updates) await this.tokens.get(_id).update(data, options);
    }
    async createToken(actor, position) {
      const token = new Token(this, actor, position);
      this.tokens.push(token);
      await tick();
      Hooks.callAll("createToken", token, {}, world.userId);
      return token;
    }
    async deleteToken(token) {
      this.tokens.delete(token.id);
      await tick();
      Hooks.callAll("deleteToken", token, {}, world.userId);
    }
  }

  const rider = new Actor("rider", { value: 30, max: 40, traits: { dr: ["fire"] } });
  const mount = new Actor("mount", { value: 20, max: 30, traits: { dv: ["fire"] } });
  world.actors = new Map([[rider.id, rider], [mount.id, mount]]);
  world.errors = [];
  world.moves = [];
  world.answer = true;
  world.userId = "gm";
  const sceneA = new Scene("A");
  const sceneB = new Scene("B");
  globalThis.game = {
    ready: true,
    user: { id: "gm", isGM: true, isActiveGM: true },
    users: { activeGM: null, get: () => game.user },
    scenes: [sceneA, sceneB],
    messages: { contents: [] },
    modules: new Map()
  };
  globalThis.fromUuidSync = uuid => world.actors.get(uuid.replace("Actor.", "")) ?? null;
  return { rider, mount, sceneA, sceneB, Actor };
}

async function setup({ authority, player = false } = {}) {
  const env = world();
  if (authority === "self") game.user.isActiveGM = false; // активен другой ГМ без механики
  if (player) Object.assign(game.user, { isGM: false, isActiveGM: false });
  env.mountToken = await env.sceneA.createToken(env.mount, { x: 500, y: 500, width: 2, height: 2 });
  env.riderToken = await env.sceneA.createToken(env.rider, { x: 100, y: 100, width: 1, height: 1 });
  env.api = installOneWhole({ riderUuid: "Actor.rider", mountUuid: "Actor.mount", mountedImage: "pair.webp", authority });
  await settle();
  return env;
}

const hp = actor => ({ value: actor.system.attributes.hp.value, temp: actor.system.attributes.hp.temp, max: actor.system.attributes.hp.effectiveMax });

// Урон в стиле Midi: аннотация уже лежит в calcDamageOptions цели.
async function midiDamage(actor, amount, annotation) {
  const before = actor.system.attributes.hp;
  const deltaTemp = Math.min(before.temp, amount);
  const updates = {
    "system.attributes.hp.temp": before.temp - deltaTemp,
    "system.attributes.hp.value": Math.max(0, before.value - (amount - deltaTemp))
  };
  const options = { [ID]: { oneWhole: annotation } };
  Hooks.call("dnd5e.preApplyDamage", actor, amount, updates, options);
  await actor.update(updates, { ...options });
}

// ---------------------------------------------------------------------------
// Сценарии
// ---------------------------------------------------------------------------

test("перенос наездника на скакуна объединяет пару", async t => {
  const { rider, mount, riderToken, mountToken, api } = await setup();
  t.after(() => api.uninstall());

  await riderToken.move([{ x: 600, y: 600, elevation: 0 }], { method: "dragging" });
  await settle();

  assert.equal(api.isPaired(), true);
  assert.deepEqual(hp(rider), { value: 50, temp: 0, max: 70 });
  assert.deepEqual(hp(mount), { value: 50, temp: 0, max: 70 });
  assert.equal(mountToken.texture.src, "pair.webp");
  assert.equal(mountToken.flags[ID].oneWholeOriginalTexture.src, "mount.webp");
  assert.deepEqual([riderToken.x, riderToken.y], [mountToken.x, mountToken.y]);
  assert.ok(riderToken.sort > mountToken.sort);
});

test("урон по одному существу получают оба, с учётом уязвимости партнёра", async t => {
  const { rider, mount, api } = await setup();
  t.after(() => api.uninstall());
  await api.pair();

  // Огонь 10 по наезднику (сопротивление → 5); у скакуна уязвимость → 20.
  await rider.applyDamage([{ value: 10, type: "fire" }]);
  await settle();
  assert.equal(hp(rider).value, 30);
  assert.equal(hp(mount).value, 30);

  // Колющий урон 7 по скакуну — без модификаторов.
  await mount.applyDamage([{ value: 7, type: "piercing" }]);
  await settle();
  assert.equal(hp(rider).value, 23);
  assert.equal(hp(mount).value, 23);
});

test("урон по области по обоим: независимые результаты, вычитается больший один раз", async t => {
  const { rider, mount, api } = await setup();
  t.after(() => api.uninstall());
  await api.pair();

  // Наездник спасся (6), скакун провалил (12) — одна workflow Midi.
  await Promise.all([
    midiDamage(rider, 6, { group: "fireball", bothHit: true, cross: null }),
    midiDamage(mount, 12, { group: "fireball", bothHit: true, cross: null })
  ]);
  await settle();
  assert.equal(hp(rider).value, 38);
  assert.equal(hp(mount).value, 38);
});

test("лечение обоих суммируется и не превышает общий максимум", async t => {
  const { rider, mount, api } = await setup();
  t.after(() => api.uninstall());
  await api.pair();
  await midiDamage(rider, 20, { group: "hit", bothHit: false, cross: 0 });
  await settle();
  assert.equal(hp(rider).value, 30);

  await Promise.all([
    rider.update({ "system.attributes.hp.value": 34 }),
    mount.update({ "system.attributes.hp.value": 34 })
  ]);
  await settle();
  assert.equal(hp(rider).value, 38);
  assert.equal(hp(mount).value, 38);

  await rider.update({ "system.attributes.hp.value": 70 });
  await mount.update({ "system.attributes.hp.value": 70 });
  await settle();
  assert.equal(hp(rider).value, 70);
  assert.equal(hp(mount).value, 70);
});

test("общие временные хиты синхронизируются", async t => {
  const { rider, mount, api } = await setup();
  t.after(() => api.uninstall());
  await api.pair();
  await rider.update({ "system.attributes.hp.temp": 8 });
  await settle();
  assert.equal(hp(mount).temp, 8);
  await midiDamage(mount, 5, { group: "x", bothHit: false, cross: 5 });
  await settle();
  assert.deepEqual([hp(rider).temp, hp(rider).value], [3, 50]);
  assert.deepEqual([hp(mount).temp, hp(mount).value], [3, 50]);
});

test("пул на 0 — оба на 0", async t => {
  const { rider, mount, api } = await setup();
  t.after(() => api.uninstall());
  await api.pair();
  await midiDamage(rider, 80, { group: "big", bothHit: false, cross: 0 });
  await settle();
  assert.equal(hp(rider).value, 0);
  assert.equal(hp(mount).value, 0);
});

test("перемещение скакуна ведёт наездника, перемещение наездника спрашивает о разъединении", async t => {
  const env = await setup();
  const { riderToken, mountToken, api } = env;
  t.after(() => api.uninstall());
  await api.pair();
  await settle();

  await mountToken.move([{ x: 800, y: 500, elevation: 0, action: "walk" }], { method: "dragging" });
  await settle();
  assert.deepEqual([riderToken.x, riderToken.y], [800, 500]);

  // «Нет» — перемещение отменено, пара сохраняется.
  world.answer = false;
  assert.equal(await riderToken.move([{ x: 1200, y: 200, elevation: 0 }], { method: "dragging" }), false);
  await settle();
  assert.equal(api.isPaired(), true);
  assert.deepEqual([riderToken.x, riderToken.y], [800, 500]);

  // «Да» — разъединение, затем наездник переносится, куда его тащили.
  world.answer = true;
  await riderToken.move([{ x: 1200, y: 200, elevation: 0 }], { method: "dragging" });
  await settle();
  assert.equal(api.isPaired(), false);
  assert.deepEqual([riderToken.x, riderToken.y], [1200, 200]);
  assert.equal(mountToken.texture.src, "mount.webp");
  assert.equal(mountToken.flags[ID]?.oneWholeOriginalTexture, undefined);
});

test("спешивание делит пул по правилу черты и снимает эффекты", async t => {
  const { rider, mount, api } = await setup();
  t.after(() => api.uninstall());
  await api.pair();
  await midiDamage(rider, 15, { group: "hit", bothHit: false, cross: 0 });
  await settle();
  assert.equal(hp(rider).value, 35);

  await api.unpair();
  assert.deepEqual(hp(mount), { value: 20, temp: 0, max: 30 });
  assert.deepEqual(hp(rider), { value: 15, temp: 0, max: 40 });
  assert.equal(rider.effects.length, 0);
  assert.equal(mount.effects.length, 0);
});

test("связь переживает удаление токенов и перенос на другую сцену", async t => {
  const env = await setup();
  const { rider, mount, sceneA, sceneB, api } = env;
  t.after(() => api.uninstall());
  await api.pair();
  await settle();

  await sceneA.deleteToken(env.riderToken);
  await sceneA.deleteToken(env.mountToken);
  await settle();
  assert.equal(api.isPaired(), true);

  const mountB = await sceneB.createToken(mount, { x: 300, y: 300, width: 2, height: 2 });
  const riderB = await sceneB.createToken(rider, { x: 0, y: 0, width: 1, height: 1 });
  await settle();
  assert.equal(mountB.texture.src, "pair.webp");
  assert.deepEqual([riderB.x, riderB.y], [300, 300]);

  await midiDamage(mount, 10, { group: "g", bothHit: false, cross: 0 });
  await settle();
  assert.equal(hp(rider).value, 40);
  assert.equal(rider.effects.length, 1);
  assert.equal(mount.effects.length, 1);
});

test("быстрые повторные посадки и спешивания не создают дублей и не теряют хиты", async t => {
  const { rider, mount, api } = await setup();
  t.after(() => api.uninstall());
  const calls = [];
  for (let i = 0; i < 10; i++) calls.push(api.pair(), api.unpair());
  calls.push(api.pair());
  await Promise.all(calls);
  await settle();
  assert.equal(api.isPaired(), true);
  assert.equal(rider.effects.length, 1);
  assert.equal(mount.effects.length, 1);
  assert.deepEqual(hp(rider), { value: 50, temp: 0, max: 70 });
  await api.unpair();
  assert.deepEqual([hp(rider).value, hp(mount).value], [30, 20]);
  assert.deepEqual(world.errors, []);
});

test("изменение максимума партнёра пересчитывает бонус", async t => {
  const { rider, mount, api } = await setup();
  t.after(() => api.uninstall());
  await api.pair();
  await mount.update({ "system.attributes.hp.max": 36 });
  await settle();
  assert.equal(hp(rider).max, 76);
  assert.equal(hp(mount).max, 76);
  assert.equal(rider.effects.length, 1);
});

test("урон, пришедший во время посадки, не теряется", async t => {
  const { rider, mount, api } = await setup();
  t.after(() => api.uninstall());
  const pairing = api.pair();
  await midiDamage(rider, 4, { group: "early", bothHit: false, cross: 0 });
  await pairing;
  await settle();
  assert.equal(hp(rider).value, 46);
  assert.equal(hp(mount).value, 46);
});

test("макрос: пишет клиент с макросом, даже если активный ГМ — другой", async t => {
  const { rider, mount, riderToken, mountToken, api } = await setup({ authority: "self" });
  t.after(() => api.uninstall());
  await riderToken.move([{ x: 600, y: 600, elevation: 0 }], { method: "dragging" });
  await settle();
  assert.equal(api.isPaired(), true);
  assert.equal(mountToken.texture.src, "pair.webp");
  await midiDamage(rider, 10, { group: "g", bothHit: false, cross: 0 });
  await settle();
  assert.equal(hp(mount).value, 40);
});

test("аннотация Midi из опций обновления (урон применил клиент без механики)", async t => {
  const { rider, mount, api } = await setup();
  t.after(() => api.uninstall());
  await api.pair();
  await rider.update({ "system.attributes.hp.value": 45 }, { [ID]: { oneWhole: { group: "w", bothHit: false, cross: 12 } } });
  await settle();
  assert.equal(hp(mount).value, 38);
});

test("игрок-владелец без ГМа: посадка, синхронизация и урон врага по чат-сообщению", async t => {
  const { rider, mount, riderToken, mountToken, api } = await setup({ authority: "self", player: true });
  t.after(() => api.uninstall());
  await riderToken.move([{ x: 600, y: 600, elevation: 0 }], { method: "dragging" });
  await settle();
  assert.equal(api.isPaired(), true);
  assert.equal(mountToken.texture.src, "pair.webp");

  // ГМ (без механики) применил 10 огня по наезднику: сопротивление → 5.
  // У скакуна уязвимость к огню → 20 по броску из чат-сообщения атакующего.
  const goblin = { id: "goblin" };
  world.actors.set("goblin", goblin);
  game.messages.contents.push({ id: "msg1", speaker: { actor: "goblin" }, rolls: [{ total: 10, options: { type: "fire" } }] });
  await rider.update({ "system.attributes.hp.value": 45 }, { midi: { sourceActorUuid: "Actor.goblin", saveMultiplier: 1 }, multiplier: 1 });
  await settle();
  assert.equal(hp(rider).value, 30);
  assert.equal(hp(mount).value, 30);
});

test("перезагрузка страницы: изменения, пропущенные без механики, восстанавливаются", async t => {
  const { rider, mount, api } = await setup();
  await api.pair();
  await settle();
  api.uninstall(); // страница перезагружена, хуков нет

  await rider.update({ "system.attributes.hp.value": 40 }); // урон 10 только наезднику
  await mount.update({ "system.attributes.hp.value": 53 }); // лечение 3 только скакуну
  await settle();
  assert.notEqual(hp(rider).value, hp(mount).value);

  const again = installOneWhole({ riderUuid: "Actor.rider", mountUuid: "Actor.mount", mountedImage: "pair.webp" });
  t.after(() => again.uninstall());
  await settle();
  assert.equal(hp(rider).value, 43);
  assert.equal(hp(mount).value, 43);
});

test("повреждённый флаг пары без статуса удаляется и не блокирует посадку", async t => {
  const env = world();
  const mountToken = await env.sceneA.createToken(env.mount, { x: 500, y: 500, width: 2, height: 2 });
  const riderToken = await env.sceneA.createToken(env.rider, { x: 100, y: 100, width: 1, height: 1 });
  env.rider.flags[ID] = { oneWhole: { lastPool: { value: 10, temp: 0 } } };
  const api = installOneWhole({ riderUuid: "Actor.rider", mountUuid: "Actor.mount", mountedImage: "pair.webp" });
  t.after(() => api.uninstall());
  await settle();
  assert.equal(env.rider.flags[ID]?.oneWhole, undefined);
  await riderToken.move([{ x: 600, y: 600, elevation: 0 }], { method: "dragging" });
  await settle();
  assert.equal(api.isPaired(), true);
  assert.equal(api.diagnose().paired, true);
  assert.equal(mountToken.texture.src, "pair.webp");
});

test("лечение не режется, если у одного из пары есть свой tempmax", async t => {
  const { rider, mount, api } = await setup();
  t.after(() => api.uninstall());
  mount._source.hp.tempmax = -5; // например, остаток старой версии или эффект на максимум
  mount.prepare();
  await api.pair();
  await settle();
  assert.equal(hp(rider).max, 65);
  assert.equal(hp(mount).max, 65);

  await midiDamage(rider, 20, { group: "hit", bothHit: false, cross: 0 });
  await settle();
  await rider.update({ "system.attributes.hp.value": 65 }); // лечение через лист персонажа
  await settle();
  assert.equal(hp(rider).value, 65);
  assert.equal(hp(mount).value, 65);
});

test("выключение в настройках: хуки молчат, при включении пропущенное пересчитывается", async t => {
  const env = world();
  const mountToken = await env.sceneA.createToken(env.mount, { x: 500, y: 500, width: 2, height: 2 });
  const riderToken = await env.sceneA.createToken(env.rider, { x: 100, y: 100, width: 1, height: 1 });
  const config = { riderUuid: "Actor.rider", mountUuid: "Actor.mount", mountedImage: "pair.webp", enabled: true };
  const api = installOneWhole(() => config);
  t.after(() => api.uninstall());
  await settle();
  await api.pair();
  await settle();
  assert.equal(api.isPaired(), true);

  config.enabled = false;
  api.enabledChanged();
  assert.equal(api.isPaired(), false);
  assert.equal(api.getPairFromToken(riderToken), null);
  await env.rider.update({ "system.attributes.hp.value": 40 }); // урон 10 только наезднику
  await settle();
  assert.equal(hp(env.mount).value, 50); // не синхронизировано
  // Перемещение наездника не спрашивает о спешивании.
  await riderToken.move([{ x: 100, y: 100, elevation: 0 }], { method: "dragging" });
  await settle();
  assert.deepEqual([riderToken.x, riderToken.y], [100, 100]);
  assert.equal(await api.unpair(), false);

  config.enabled = true;
  api.enabledChanged();
  await settle();
  assert.equal(api.isPaired(), true);
  assert.equal(hp(env.rider).value, 40);
  assert.equal(hp(env.mount).value, 40);
  assert.deepEqual([riderToken.x, riderToken.y], [mountToken.x, mountToken.y]);
});
