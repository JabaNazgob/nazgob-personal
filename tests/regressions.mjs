import test from 'node:test';
import assert from 'node:assert/strict';
import * as mod from '../scripts/mounted-combat-v0.1.17.js';
function fixture({ duplicate = false, stale = false } = {}) {
  const docs = new Map();
  globalThis.fromUuidSync = uuid => docs.get(uuid);
  function actor(max, bonuses) {
    const a = { effects: [], statuses: new Set(), system: { attributes: { hp: { max, value: 70, temp: 0 } } } };
    Object.defineProperty(a.system.attributes.hp, 'tempmax', { get: () => a.effects.filter(e => !e.disabled && !e.isSuppressed).reduce((n, e) => n + Number(e.changes[0].value), 0) });
    function effect(bonus) {
      const e = { id: String(Math.random()), changes: [{ key: 'system.attributes.hp.tempmax', mode: 2, value: String(bonus) }], getFlag: () => 'pair', async update(data) { await Promise.resolve(); Object.assign(this, data); } };
      a.effects.push(e);
    }
    bonuses.forEach(effect);
    a.update = async data => { for (const [key, value] of Object.entries(data)) a.system.attributes.hp[key.split('.').at(-1)] = value; };
    a.createEmbeddedDocuments = async (_, entries) => { await Promise.resolve(); entries.forEach(e => effect(Number(e.changes[0].value))); };
    a.deleteEmbeddedDocuments = async (_, ids) => { a.effects = a.effects.filter(e => !ids.includes(e.id)); };
    return a;
  }
  const rider = { uuid: 'Scene.s.Token.r', actor: actor(40, duplicate ? [30, 30] : [30]), getFlag: (_, key) => key === 'mountedRiderLink' && !stale ? { pairId: 'pair', mountTokenUuid: 'Scene.s.Token.m' } : null };
  const state = { pairId: 'pair', poolActive: true, riderTokenUuid: rider.uuid, mountTokenUuid: 'Scene.s.Token.m', sharedHp: 70, sharedTemp: 0, sharedMax: 70, riderMaxBonus: 30, mountMaxBonus: 40 };
  const mount = { uuid: state.mountTokenUuid, actor: actor(30, [40]), getFlag: (_, key) => key === 'mountedPair' ? mount.state : null, state, async update(data) { await Promise.resolve(); this.state = data[`flags.${mod.MODULE_ID}.mountedPair`]; } };
  docs.set(rider.uuid, rider); docs.set(mount.uuid, mount);
  return { rider, mount, pair: { state, riderToken: rider, mountToken: mount } };
}
const damage = { oldHP: 70, newHP: 60, oldTempHP: 0, newTempHP: 0 };
test('miss cannot reduce shared HP', async () => {
  const { rider, mount } = fixture(); const workflow = {};
  mod.captureMidiTargetDamage(rider, { workflow, damageItem: { ...damage, wasHit: false } });
  await mod.reconcileMidiWorkflow(workflow);
  assert.equal(mount.state.sharedHp, 70);
});
test('stale one-sided pair must not capture damage', () => {
  const { mount } = fixture({ stale: true }); const workflow = {};
  try { assert.equal(mod.captureMidiTargetDamage(mount, { workflow, damageItem: damage }), false); }
  finally { mod.releaseMidiWorkflowSuppression(workflow); }
});
test('unmounted target is untouched', () => {
  assert.equal(mod.captureMidiTargetDamage({ getFlag: () => null }, { workflow: {}, damageItem: damage }), false);
});
test('hit applies once with concurrent completion hooks', async () => {
  const { rider, mount } = fixture(); const workflow = {};
  mod.captureMidiTargetDamage(rider, { workflow, damageItem: { ...damage, wasHit: true } });
  await Promise.all([mod.reconcileMidiWorkflow(workflow), mod.reconcileMidiWorkflow(workflow)]);
  assert.equal(mount.state.sharedHp, 60);
  assert.equal(mount.state.sharedMax, 70);
});
test('duplicate effects cannot feed back into maximum', async () => {
  const { pair, mount, rider } = fixture({ duplicate: true });
  for (let i = 0; i < 5; i++) await mod.rebuildPoolEffects(pair);
  assert.equal(mount.state.sharedMax, 70);
  assert.equal(rider.actor.effects.length, 1);
  assert.equal(rider.actor.system.attributes.hp.tempmax, 30);
});
test('actual effect amount wins over stale saved bonus', async () => {
  const { pair, mount, rider } = fixture();
  rider.actor.effects[0].changes[0].value = '50';
  await Promise.all([mod.rebuildPoolEffects(pair), mod.rebuildPoolEffects(pair)]);
  assert.equal(mount.state.sharedMax, 70);
});
test('disabled shared effect is not subtracted from independent HP', async () => {
  const { pair, mount, rider } = fixture();
  rider.actor.effects[0].disabled = true;
  await mod.rebuildPoolEffects(pair);
  assert.equal(mount.state.sharedMax, 70);
  assert.equal(rider.actor.system.attributes.hp.tempmax, 30);
});
test('healing without an attack still increases the shared pool', async () => {
  const { rider, mount } = fixture(); const workflow = {};
  mount.state.sharedHp = 50;
  mod.captureMidiTargetDamage(rider, { workflow, damageItem: { ...damage, oldHP: 50, newHP: 60 } });
  await mod.reconcileMidiWorkflow(workflow);
  assert.equal(mount.state.sharedHp, 60);
});
test('area damage to both partners is counted once', async () => {
  const { rider, mount } = fixture(); const workflow = { templateUuid: 'template' };
  mod.captureMidiTargetDamage(rider, { workflow, damageItem: damage });
  mod.captureMidiTargetDamage(mount, { workflow, damageItem: damage });
  await mod.reconcileMidiWorkflow(workflow);
  assert.equal(mount.state.sharedHp, 60);
});

