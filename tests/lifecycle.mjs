import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as mod from '../scripts/mounted-combat-v0.1.18.js';

const ID = mod.MODULE_ID;
const tick = () => new Promise(resolve => setImmediate(resolve));

// Document updates are asynchronous in Foundry. The gate can hold any one
// server write while another click or hook enters the real module code.
function world() {
  let gate;
  const writes = [];
  const docs = new Map();
  let sequence = 0;
  async function checkpoint(document, kind, data) {
    writes.push({ document, kind, data: structuredClone(data) });
    const pending = gate;
    if (pending && pending.matches(document, kind, data)) {
      gate = null;
      pending.enter();
      await pending.promise;
    }
    await tick();
  }
  function pause(matches) {
    let enter, release;
    const entered = new Promise(resolve => { enter = resolve; });
    const promise = new Promise(resolve => { release = resolve; });
    gate = { matches, enter, promise };
    return { entered, release };
  }
  function apply(document, changes) {
    for (const [path, value] of Object.entries(changes)) {
      const keys = path.split('.');
      let target = document;
      for (const key of keys.slice(0, -1)) target = target[key] ??= {};
      const last = keys.at(-1);
      if (last.startsWith('-=')) delete target[last.slice(2)];
      else target[last] = structuredClone(value);
    }
  }
  function actor(id, max, value) {
    const hp = { max, value, temp: 0 };
    const a = { id, uuid: `Actor.${id}`, documentName: 'Actor', isOwner: true, effects: [], items: [], statuses: new Set(), system: { attributes: { hp } } };
    a.prototypeToken = { texture: { src: `${id}.webp`, scaleX: 1, scaleY: 1 } };
    Object.defineProperty(hp, 'tempmax', { get: () => a.effects.filter(e => !e.disabled && !e.isSuppressed)
      .flatMap(e => e.changes).filter(c => c.key === 'system.attributes.hp.tempmax')
      .reduce((sum, c) => sum + Number(c.value), 0) });
    a.update = async data => { await checkpoint(id, 'actor', data); apply(a, data); };
    a.createEmbeddedDocuments = async (_, entries) => {
      await checkpoint(id, 'createEffects', entries);
      const effects = entries.map(data => {
        const e = { ...structuredClone(data), id: `effect${++sequence}`, parent: a };
        e.getFlag = (scope, key) => e.flags?.[scope]?.[key];
        e.toObject = () => structuredClone({ ...data, _id: e.id });
        e.update = async next => { await checkpoint(id, 'effect', next); Object.assign(e, structuredClone(next)); };
        return e;
      });
      a.effects.push(...effects);
      return effects;
    };
    a.deleteEmbeddedDocuments = async (_, ids) => {
      await checkpoint(id, 'deleteEffects', ids);
      a.effects = a.effects.filter(e => !ids.includes(e.id));
    };
    return a;
  }
  function token(id, max, hp, width) {
    const t = { id, uuid: `Scene.s.Token.${id}`, documentName: 'Token', actorId: id, actor: actor(id, max, hp),
      isOwner: true, parent: { id: 's' }, flags: {}, texture: { src: `${id}.webp`, scaleX: 1, scaleY: 1 },
      width, height: width, sort: 0, x: 400, y: 400, elevation: 0 };
    t.object = { document: t, actor: t.actor };
    t.getFlag = (scope, key) => t.flags?.[scope]?.[key];
    t.update = async data => { await checkpoint(id, 'token', data); apply(t, data); };
    docs.set(t.uuid, t);
    return t;
  }
  const rider = token('r', 40, 35, 1);
  const mount = token('m', 30, 25, 2);
  const item = { id: 'toggle', uuid: 'Actor.r.Item.toggle', documentName: 'Item', actor: rider.actor,
    name: mod.MOUNTED_COMBAT_CONFIG.mountItemName,
    system: { description: { value: '@UUID[Actor.m]\nmountedTexture: pair.webp' } },
    async update(data) { await checkpoint('item', 'item', data); Object.assign(this, data); } };
  rider.actor.items.push(item);
  rider.actor.items.get = id => rider.actor.items.find(i => i.id === id);
  docs.set(item.uuid, item);
  globalThis.fromUuidSync = uuid => docs.get(uuid);
  globalThis.fromUuid = async uuid => docs.get(uuid);
  globalThis.canvas = { ready: true, scene: { id: 's', tokens: [rider, mount] }, grid: { size: 100 },
    tokens: { controlled: [rider.object], placeables: [rider.object, mount.object] } };
  globalThis.game = { user: { id: 'gm', isActiveGM: true, targets: new Set([mount.object]) }, modules: new Map() };
  globalThis.MidiQOL = { computeDistance: () => 5 };
  return { rider, mount, item, activity: { item }, pause, writes };
}

function assertDismounted(w) {
  assert.equal(w.rider.texture.src, 'r.webp');
  assert.equal(w.mount.texture.src, 'm.webp');
  assert.equal(w.rider.getFlag(ID, 'mountedRiderLink'), undefined);
  assert.equal(w.mount.getFlag(ID, 'mountedPair'), undefined);
  assert.equal(w.rider.actor.effects.length, 0);
  assert.equal(w.mount.actor.effects.length, 0);
  assert.equal(w.rider.actor.system.attributes.hp.value, 35);
  assert.equal(w.mount.actor.system.attributes.hp.value, 25);
  assert.equal(w.item.name, mod.MOUNTED_COMBAT_CONFIG.mountItemName);
}

test('repeated clicks during initial mount do not mount twice', async () => {
  const w = world();
  const pause = w.pause((id, kind) => id === 'm' && kind === 'token');
  const first = mod.toggleFromActivity(w.activity);
  await pause.entered;
  const repeats = Array.from({ length: 5 }, () => mod.toggleFromActivity(w.activity));
  await tick();
  pause.release();
  await Promise.all([first, ...repeats]);
  const pool = w.mount.getFlag(ID, 'mountedPair');
  assert.equal(pool.sharedHp, 60);
  assert.equal(pool.sharedMax, 70);
  assert.equal(pool.visual.riderTexture, 'r.webp');
  assert.equal(w.rider.actor.effects.length, 2); // reach + shared maximum
  await mod.toggleFromActivity(w.activity);
  assertDismounted(w);
});

test('click during visual restoration cannot save transparency as original', async () => {
  const w = world();
  await mod.toggleFromActivity(w.activity);
  const pause = w.pause((id, kind, data) => id === 'r' && kind === 'token' && data['texture.src'] === 'r.webp');
  const first = mod.toggleFromActivity(w.activity);
  await pause.entered;
  const repeats = [mod.toggleFromActivity(w.activity)];
  for (let i = 0; i < 3; i++) await tick();
  repeats.push(mod.toggleFromActivity(w.activity));
  for (let i = 0; i < 8; i++) await tick();
  pause.release();
  await Promise.all([first, ...repeats]);
  assertDismounted(w);
});

test('dismount drains a pending maximum rebuild before removing effects', async () => {
  const w = world();
  await mod.toggleFromActivity(w.activity);
  const pause = w.pause((id, kind) => id === 'r' && kind === 'effect');
  const rebuild = mod.rebuildPoolEffects(mod.getPairFromToken(w.rider));
  await pause.entered;
  const dismount = mod.toggleFromActivity(w.activity);
  for (let i = 0; i < 8; i++) await tick();
  pause.release();
  await Promise.all([rebuild, dismount]);
  assertDismounted(w);
});

test('rapid completed mount/dismount cycles preserve both HP and original artwork', async () => {
  const w = world();
  for (let i = 0; i < 10; i++) {
    await Promise.all(Array.from({ length: 5 }, () => mod.toggleFromActivity(w.activity)));
    await Promise.all(Array.from({ length: 5 }, () => mod.toggleFromActivity(w.activity)));
    assertDismounted(w);
  }
});

test('dismount waits for an in-flight Actor HP synchronization', async () => {
  const w = world();
  await mod.toggleFromActivity(w.activity);
  const pause = w.pause((id, kind) => id === 'm' && kind === 'token');
  const sync = mod.syncPoolFromActorUpdate(w.rider.actor, { 'system.attributes.hp.value': 60 }, {});
  await pause.entered;
  const dismount = mod.toggleFromActivity(w.activity);
  for (let i = 0; i < 10; i++) await tick();
  pause.release();
  await Promise.all([sync, dismount]);
  assertDismounted(w);
});

test('completed damage reconciliation cannot resurrect a dismantled pair', async () => {
  const w = world();
  await mod.toggleFromActivity(w.activity);
  const workflow = {};
  mod.captureMidiTargetDamage(w.rider, { workflow, damageItem: { wasHit: true, oldHP: 60, newHP: 60, oldTempHP: 0, newTempHP: 0 } });
  const pause = w.pause((id, kind) => id === 'm' && kind === 'token');
  const reconcile = mod.reconcileMidiWorkflow(workflow);
  await pause.entered;
  const dismount = mod.toggleFromActivity(w.activity);
  for (let i = 0; i < 10; i++) await tick();
  pause.release();
  await Promise.all([reconcile, dismount]);
  assertDismounted(w);
});

test('extra clicks at every document-write boundary preserve the completed transition', async () => {
  const baseline = world();
  await mod.toggleFromActivity(baseline.activity);
  const mountWrites = baseline.writes.length;
  await mod.toggleFromActivity(baseline.activity);
  const dismountWrites = baseline.writes.length - mountWrites;
  for (const [phase, count] of [['mount', mountWrites], ['dismount', dismountWrites]]) {
    for (let step = 1; step <= count; step++) {
      const w = world();
      if (phase === 'dismount') await mod.toggleFromActivity(w.activity);
      let seen = 0;
      const pause = w.pause(() => ++seen === step);
      const transition = mod.toggleFromActivity(w.activity);
      await pause.entered;
      const repeat = mod.toggleFromActivity(w.activity);
      for (let i = 0; i < 2; i++) await tick();
      pause.release();
      await Promise.all([transition, repeat]);
      if (phase === 'mount') {
        assert.equal(w.mount.getFlag(ID, 'mountedPair').sharedHp, 60, `${phase} write ${step}`);
        assert.equal(w.mount.getFlag(ID, 'mountedPair').sharedMax, 70);
        await mod.toggleFromActivity(w.activity);
      }
      assertDismounted(w);
    }
  }
});

test('HP changed during a rebuild wins on both Actors and survives dismount', async () => {
  const w = world();
  await mod.toggleFromActivity(w.activity);
  const pause = w.pause((id, kind) => id === 'r' && kind === 'effect');
  const rebuild = mod.rebuildPoolEffects(mod.getPairFromToken(w.rider));
  await pause.entered;
  await w.rider.actor.update({ 'system.attributes.hp.value': 50 });
  const sync = mod.syncPoolFromActorUpdate(w.rider.actor, { 'system.attributes.hp.value': 50 }, {});
  pause.release();
  await Promise.all([rebuild, sync]);
  assert.equal(w.rider.actor.system.attributes.hp.value, 50);
  assert.equal(w.mount.actor.system.attributes.hp.value, 50);
  assert.equal(w.mount.getFlag(ID, 'mountedPair').sharedHp, 50);
  await mod.toggleFromActivity(w.activity);
  assert.equal(w.rider.actor.system.attributes.hp.value, 25);
  assert.equal(w.mount.actor.system.attributes.hp.value, 25);
});

test('recovery macro removes broken pair effects and restores artwork without guessing HP', async () => {
  const w = world();
  await mod.toggleFromActivity(w.activity);
  delete w.rider.flags[ID].mountedRiderLink;
  w.mount.flags[ID].mountedPair.visual.riderTexture = mod.MOUNTED_COMBAT_CONFIG.transparentTexture;
  canvas.tokens.controlled = [w.rider.object, w.mount.object];
  globalThis.ui = { notifications: { info() {}, warn() {} } };
  const source = await readFile(new URL('../macros/recover-mounted-tokens.js', import.meta.url), 'utf8');
  const run = new (Object.getPrototypeOf(async function() {}).constructor)(source);
  game.modules.set(ID, { active: true });
  const before = w.writes.length;
  await run();
  assert.equal(w.writes.length, before, 'must not race the enabled module');
  game.modules.set(ID, { active: false });
  await run();
  assert.equal(w.rider.texture.src, 'r.webp');
  assert.equal(w.mount.texture.src, 'm.webp');
  assert.equal(w.rider.actor.effects.length, 0);
  assert.equal(w.mount.actor.effects.length, 0);
  assert.equal(w.mount.getFlag(ID, 'mountedPair'), undefined);
  assert.equal(w.rider.actor.system.attributes.hp.value, 60);
  assert.equal(w.mount.actor.system.attributes.hp.value, 60);
  assert.equal(w.rider.getFlag(ID, 'recoveryBackup').hp.value, 60);
  assert.equal(w.rider.getFlag(ID, 'recoveryBackup').effects.length, 2);
  assert.equal(w.item.name, mod.MOUNTED_COMBAT_CONFIG.mountItemName);
});
