// Select BOTH damaged tokens. Disable Nazgob Personal and reload the world
// before running this Script macro. HP must be checked manually afterwards.
const moduleId = "nazgob-personal";
if (game.modules.get(moduleId)?.active) {
  ui.notifications.warn("Сначала выключите Nazgob Personal и перезагрузите мир, чтобы остановить его обработчики.");
  return;
}
const tokens = canvas.tokens.controlled.map(token => token.document);
if (!tokens.length) {
  ui.notifications.warn("Выделите повреждённые токены всадника и скакуна.");
  return;
}
const transparent = `modules/${moduleId}/assets/transparent.png`;
for (const token of tokens) {
  const texture = token.actor?.prototypeToken?.texture;
  if (!token.isOwner || !token.actor?.isOwner || !texture?.src || texture.src === transparent) {
    ui.notifications.warn("Для каждого выбранного токена нужны права владельца и обычное изображение прототипа Actor.");
    return;
  }
}

// Save a small recovery record on each token before removing broken state.
// Existing HP are recorded, never guessed or restored from a stale shared pool.
for (const token of tokens) {
  const actor = token.actor;
  const effects = [...actor.effects].filter(effect =>
    effect.getFlag(moduleId, "sharedMaxEffect") || effect.getFlag(moduleId, "mountedReachEffect"));
  if (!token.getFlag(moduleId, "recoveryBackup")) {
    await token.update({
      [`flags.${moduleId}.recoveryBackup`]: {
        date: new Date().toISOString(),
        texture: { src: token.texture.src, scaleX: token.texture.scaleX, scaleY: token.texture.scaleY },
        sort: token.sort,
        pair: token.getFlag(moduleId, "mountedPair") ?? null,
        riderLink: token.getFlag(moduleId, "mountedRiderLink") ?? null,
        hp: {
          value: actor.system.attributes.hp.value,
          max: actor.system.attributes.hp.max,
          temp: actor.system.attributes.hp.temp,
          tempmax: actor.system.attributes.hp.tempmax
        },
        effects: effects.map(effect => effect.toObject())
      }
    });
  }
}
for (const token of tokens) {
  const actor = token.actor;
  const ids = [...actor.effects].filter(effect =>
    effect.getFlag(moduleId, "sharedMaxEffect") || effect.getFlag(moduleId, "mountedReachEffect"))
    .map(effect => effect.id);
  if (ids.length) await actor.deleteEmbeddedDocuments("ActiveEffect", ids);
  const texture = actor.prototypeToken.texture;
  await token.update({
    "texture.src": texture.src,
    "texture.scaleX": texture.scaleX ?? 1,
    "texture.scaleY": texture.scaleY ?? 1,
    [`flags.${moduleId}.-=mountedPair`]: null,
    [`flags.${moduleId}.-=mountedRiderLink`]: null
  });
  const item = actor.items.find(item => item.name === "Спешиться со скакуна");
  if (item) await item.update({ name: "Сесть на скакуна" });
}
ui.notifications.info("Связи и эффекты пары сняты, изображения восстановлены из прототипов Actor. Проверьте реальные ХП и состояние смерти вручную, затем включите обновлённый модуль.");
