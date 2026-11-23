/**
 * Selective Walls — Foundry VTT v14 (проверено на исходниках 14.369)
 *
 * Семантика: для игроков (пользователей мира), указанных в списке стены, стена
 * локально полностью ОТСУТСТВУЕТ — она не рисуется, иконка/мешь двери скрыты, стена
 * недоступна для кликов, а геометрические полигоны (зрение, свет, звук,
 * перемещение) сквозь неё проходят. Обработка идёт только на клиенте указанного
 * пользователя; документы сцены не меняются. Legacy-списки персонажей и отдельных
 * токенов продолжают поддерживаться.
 *
 * Реализация:
 *  1. Геометрия — обёртка над Wall#_testEdgeInclusion (один класс полигонов для
 *     всех бэкендов в v14), которая отклоняет уже принятые ядром рёбра стен для
 *     источников, принадлежащих нашим токенам. Это делает стену прозрачной и для
 *     видимости, и для движения (move-бэкенд использует те же полигоны).
 *  2. Рендеринг — обёртки геттеров isVisible/isInteractable у placeable стены и
 *     DoorControl, плюс скрытие мешей дверей (они дети canvas.primary).
 *  3. UI — секция в конфигурации стены с выпадающим списком игроков (штатный
 *     элемент ядра <multi-select>); выбор сохраняется сразу флагом документа стены.
 *     Для указанного пользователя стена скрыта на любом уровне, даже если его токен
 *     сейчас не виден этому клиенту.
 */

const MODULE_ID = "selective-walls";
/* Foundry принимает в качестве scope флага только "core", "world", id системы и id
 * активных модулей (client/data/client-backend.mjs, getFlagScopes), поэтому scope
 * обязан совпадать с MODULE_ID, а не с произвольным camelCase-пространством имён. */
const NAMESPACE = MODULE_ID;
const FLAG_KEY = "hiddenFrom";

/** Маркер уже изменённых геттеров, чтобы не наматывать обёртки повторно. */
const PATCH_MARK = Symbol.for("selectiveWalls.patched");

/* ------------------------------------------------------------------ */
/*  Локальный кэш клиента                                              */
/* ------------------------------------------------------------------ */

/** id документа стены -> {users:Set<string>, actors:Set<string>, tokens:Set<string>} (только непустые) */
const wallEntries = new Map();

/** id токена, значимого для этого клиента -> Set(id стен), скрытых именно у него */
const wallsBySourceToken = new Map();

/** id стен, полностью отсутствующих на этом клиенте (для рендеринга и быстрой отбраковки) */
const hiddenWallIds = new Set();

/** Отпечаток значимого состояния: по нему определяем, нужен ли пересчёт полигонов. */
let lastFingerprint = "";

/* ------------------------------------------------------------------ */
/*  Утилиты                                                            */
/* ------------------------------------------------------------------ */

function debug(...args) {
  try {
    if (game.settings.get(MODULE_ID, "debug")) console.log("Selective Walls |", ...args);
  } catch { /* настройки ещё не зарегистрированы */ }
}

/**
 * Терпимая нормализация значения флага: {users, actors, tokens}. Массив трактуется
 * как legacy-список актёров (так хранились первые версии модуля).
 */
function normalizeEntries(value) {
  const out = {users: new Set(), actors: new Set(), tokens: new Set()};
  if (!value) return out;
  if (Array.isArray(value)) {
    for (const v of value) if (typeof v === "string") out.actors.add(v);
    return out;
  }
  const users = Array.isArray(value.users ?? value.userIds) ? (value.users ?? value.userIds) : [];
  const actors = Array.isArray(value.actors) ? value.actors : [];
  const tokens = Array.isArray(value.tokens ?? value.tokenIds) ? (value.tokens ?? value.tokenIds) : [];
  for (const u of users) if (typeof u === "string") out.users.add(u);
  for (const a of actors) if (typeof a === "string") out.actors.add(a);
  for (const t of tokens) if (typeof t === "string") out.tokens.add(t);
  return out;
}

/** Скрыта ли стена для этого пользователя целиком (независимо от его токенов). */
function entryMatchesUser(entry) {
  const id = game.user?.id;
  return Boolean(entry && id && entry.users.has(id));
}

/** Совпадает ли запись стены с конкретным документом токена. */
function entryMatchesToken(entry, tokenDoc) {
  if (!entry || !tokenDoc) return false;
  if (entry.tokens.has(tokenDoc.id)) return true;
  const actorId = tokenDoc.actor?.id ?? tokenDoc.actorId;
  return Boolean(actorId && entry.actors.has(actorId));
}

/** Токен значим для этого клиента: мы его владелец/наблюдатель или управляем им. */
function isLocalTokenDocument(tokenDoc) {
  const user = game.user;
  if (!tokenDoc || !user) return false;
  try {
    const levels = CONST.DOCUMENT_OWNERSHIP_LEVELS;
    for (const level of [levels.OWNER, levels.OBSERVER]) {
      if (tokenDoc.testUserPermission(user, level)) return true;
    }
  } catch { /* документ без тестирования прав */ }
  const controlled = canvas.tokens?.controlled ?? [];
  for (const t of controlled) {
    const doc = t?.document ?? t;
    if (doc && doc.id === tokenDoc.id) return true;
  }
  return false;
}

/** Стена скрыта на этом клиенте? GM не скрывает стены никогда. */
function isHiddenLocally(placeable) {
  if (!placeable || game.user?.isGM) return false;
  if (placeable.isPreview) return false; // предпросмотр в окне настройки стены видим всегда
  const id = placeable.document?.id ?? placeable.id;
  return Boolean(id && hiddenWallIds.has(id));
}

/* ------------------------------------------------------------------ */
/*  Пересчёт кэша и применение                                         */
/* ------------------------------------------------------------------ */

function recomputeState() {
  wallEntries.clear();
  wallsBySourceToken.clear();
  hiddenWallIds.clear();

  const scene = canvas.scene;
  if (!scene || game.user?.isGM) return; // у GM всё видно всегда

  // Токены текущего уровня, которые относятся к этому клиенту.
  const seen = new Set();
  const localTokens = [];
  for (const t of canvas.tokens?.placeables ?? []) {
    if (!t || t.isPreview) continue;
    const doc = t.document;
    if (!doc?.id || seen.has(doc.id)) continue;
    seen.add(doc.id);
    if (isLocalTokenDocument(doc)) localTokens.push(doc);
  }

  // Стены с непустым списком + совпадения по нашим токенам.
  const wallDocs = canvas.walls?.documents ?? scene.walls ?? [];
  for (const wall of wallDocs) {
    let entry;
    try {
      entry = normalizeEntries(wall.getFlag(NAMESPACE, FLAG_KEY));
    } catch { continue; }
    if (!entry.users.size && !entry.actors.size && !entry.tokens.size) continue;
    wallEntries.set(wall.id, entry);

    // Указанный пользователь: стена отсутствует на этом клиенте всегда — даже если
    // его токен сейчас на другом уровне или им управляет другой игрок.
    const hiddenForMe = entryMatchesUser(entry);
    if (hiddenForMe) hiddenWallIds.add(wall.id);

    for (const tokenDoc of localTokens) {
      if (!hiddenForMe && !entryMatchesToken(entry, tokenDoc)) continue;
      hiddenWallIds.add(wall.id);
      let set = wallsBySourceToken.get(tokenDoc.id);
      if (!set) {
        set = new Set();
        wallsBySourceToken.set(tokenDoc.id, set);
      }
      set.add(wall.id);
    }
  }

  debug(`скрытых стен: ${hiddenWallIds.size}, значимых токенов: ${localTokens.length}`);
}

/** Применяем скрытие/возврат к уже отрисованным объектам сцены. */
function applyRendering() {
  if (!canvas.ready) return;
  for (const wall of canvas.walls?.placeables ?? []) {
    try {
      const hidden = isHiddenLocally(wall);

      // Ядро пересчитает visible и eventMode через наши геттеры isVisible/isInteractable.
      if (!wall.isPreview) {
        wall.renderFlags.set({refreshState: true});
        wall.applyRenderFlags();
      }

      // Меши дверей — дети canvas.primary, видимость родителя на них не влияет.
      for (const mesh of wall.doorMeshes ?? []) {
        if (!mesh || typeof mesh.visible !== "boolean") continue;
        mesh.visible = !hidden;
      }
    } catch (err) {
      console.warn("Selective Walls: не удалось обновить стену", wall, err);
    }
  }

  // Иконки дверей: скрываем у скрытых стен и восстанавливаем корректное состояние ядра
  // для остальных, иначе иконка «висит» там, где невидимой стены больше нет (полигоны сквозные).
  for (const door of canvas.controls?.doors?.children ?? []) {
    try {
      if (!door || door.isPreview) continue;
      door.visible = isHiddenLocally(door) ? false : Boolean(door.isVisible);
    } catch (err) {
      debug("не удалось обновить иконку двери", err);
    }
  }
}

/** Пересчёт полигонов: зрение/свет/звук и блокировка перемещения. */
function refreshPerception() {
  if (!canvas.ready || !game.user || game.user.isGM) return;
  const flags = {initializeVision: true, initializeLighting: true};
  try {
    canvas.perception?.update(flags);
  } catch (err) {
    debug("perception.update не сработал", err);
    try {
      canvas.perception?.renderFlags.set(flags);
      canvas.walls?.applyRenderFlags?.();
    } catch { /* канал на перезагрузку уже запланирован */ }
  }
}

/** Отпечаток значимого для клиента состояния скрытых стен. */
function stateFingerprint() {
  const parts = [];
  for (const [tokenId, set] of wallsBySourceToken) parts.push(`${tokenId}:${[...set].sort().join(",")}`);
  return `${hiddenWallIds.size}|${parts.sort().join(";")}`;
}

function rebuild(performRefresh = true) {
  if (!canvas.ready) return;
  recomputeState();

  // Движение токенов и другие частые обновления не должны каждый раз заново строить
  // полигоны зрения/света: пересчёт нужен только если состав скрытых стен изменился.
  const fingerprint = stateFingerprint();
  if (fingerprint === lastFingerprint) return;
  lastFingerprint = fingerprint;

  applyRendering();
  // Обновляем полигоны всегда при изменении состава: список мог не только появиться,
  // но и опустеть — в обоих случаях нужно заново построить контуры зрения/света/звука
  // и блокировку перемещения.
  if (performRefresh) refreshPerception();
}

const scheduleRebuild = foundry.utils.debounce(() => rebuild(true), 250);

/* ------------------------------------------------------------------ */
/*  Геометрия: стена не участвует в полигонах наших источников         */
/* ------------------------------------------------------------------ */

function patchPolygonBackends() {
  const backends = CONFIG.Canvas?.polygonBackends ?? {};
  for (const Cls of Object.values(backends)) patchPolygonClass(Cls);
}

function patchPolygonClass(Cls) {
  let proto = Cls?.prototype;
  while (proto && !Object.prototype.hasOwnProperty.call(proto, "_testEdgeInclusion")) {
    proto = Object.getPrototypeOf(proto);
  }
  if (!proto || proto[PATCH_MARK]?.has("_testEdgeInclusion")) return;

  const descriptor = Object.getOwnPropertyDescriptor(proto, "_testEdgeInclusion");
  if (typeof descriptor?.value !== "function") return;
  (proto[PATCH_MARK] ??= new Set()).add("_testEdgeInclusion");

  const original = descriptor.value;
  Object.defineProperty(proto, "_testEdgeInclusion", {
    ...descriptor,
    configurable: true,
    value: function patchedTestEdgeInclusion(edge, edgeTypes) {
      // Сначала полностью выполняем логику ядра (её пороги и приоритеты нетронуты),
      // и только если ядро ребро приняло — отклоняем его для наших токенов.
      if (!original.call(this, edge, edgeTypes)) return false;
      return !isWallExcludedForSource(edge, this);
    }
  });
}

/** Отклонить ли уже принятое ядром ребро стены для текущего источника полигона. */
function isWallExcludedForSource(edge, polygon) {
  if (game.user?.isGM || wallsBySourceToken.size === 0) return false;
  if (!edge || edge.type !== "wall") return false;

  const wall = edge.object ?? edge.document; // у рёбер из quadtree object — клиентский WallDocument
  const wallId = wall?.id;
  if (!wallId || !hiddenWallIds.has(wallId)) return false;

  const source = polygon?.config?.source;
  if (!source) return false;

  // Источник полигона: для зрения/света/звука/движения .object — это Token placeable.
  let doc = null;
  if (source.object) doc = source.object.document ?? source.object;
  else if (source.document) doc = source.document;
  const tokenId = doc?.id;
  if (!tokenId) return false;

  // Если тип источника доступен — фильтруем только токены.
  const documentName = doc.documentName ?? source.object?.documentName;
  if (documentName && documentName !== "Token") return false;

  return Boolean(wallsBySourceToken.get(tokenId)?.has(wallId));
}

/* ------------------------------------------------------------------ */
/*  Рендеринг: геттеры видимости и доступности                         */
/* ------------------------------------------------------------------ */

/**
 * Оборачивает геттер, не трогая родительские классы: новый аксессор определяется на
 * самом классе и вызывает исходный геттер через захваченный дескриптор.
 */
function patchGetter(Cls, name, wrapper) {
  const proto = Cls?.prototype;
  if (!proto || proto[PATCH_MARK]?.has(name)) return false;

  let owner = proto;
  let descriptor;
  while (owner && !(descriptor = Object.getOwnPropertyDescriptor(owner, name))) {
    owner = Object.getPrototypeOf(owner);
  }
  const baseGet = descriptor?.get;
  if (typeof baseGet !== "function") return false;

  (proto[PATCH_MARK] ??= new Set()).add(name);
  Object.defineProperty(proto, name, {
    configurable: true,
    enumerable: descriptor.enumerable,
    get: function patchedGetter() {
      return wrapper.call(this, () => baseGet.call(this));
    }
  });
  return true;
}

function patchWallPlaceable() {
  const Cls = CONFIG.Wall?.objectClass ?? globalThis.Wall;
  if (!Cls) return console.warn("Selective Walls: не найден класс стены (CONFIG.Wall.objectClass).");

  patchGetter(Cls, "isVisible", function (base) {
    return isHiddenLocally(this) ? false : base();
  });

  // Стена недоступна для выделения и кликов, если она локально отсутствует.
  patchGetter(Cls, "isInteractable", function (base) {
    return isHiddenLocally(this) ? false : base();
  });

  wrapMethod(Cls, "createDoorMeshes", async function (original) {
    await original();
    if (!isHiddenLocally(this)) return;
    for (const mesh of this.doorMeshes ?? []) {
      if (mesh && typeof mesh.visible === "boolean") mesh.visible = false;
    }
  });
}

function patchDoorControl() {
  const Cls = CONFIG.Canvas?.doorControlClass ?? globalThis.DoorControl;
  if (!Cls) return console.warn("Selective Walls: не найден класс двери (CONFIG.Canvas.doorControlClass).");

  // Иконка двери скрыта вместе со стеной: ядро присваивает door.visible = door.isVisible.
  patchGetter(Cls, "isVisible", function (base) {
    return isHiddenLocally(this) ? false : base();
  });
}

/** Обёртка метода собственного класса с вызовом оригинала через `original(...)`. */
function wrapMethod(Cls, name, wrapper) {
  const proto = Cls?.prototype;
  if (!proto || proto[PATCH_MARK]?.has(name)) return false;
  const descriptor = Object.getOwnPropertyDescriptor(proto, name);
  if (typeof descriptor?.value !== "function") return false;

  (proto[PATCH_MARK] ??= new Set()).add(name);
  const original = descriptor.value;
  Object.defineProperty(proto, name, {
    ...descriptor,
    configurable: true,
    value: function patchedMethod(...args) {
      return wrapper.apply(this, [original.bind(this), ...args]);
    }
  });
  return true;
}

/* ------------------------------------------------------------------ */
/*  Настройки модуля                                                   */
/* ------------------------------------------------------------------ */

function registerSettings() {
  game.settings.register(MODULE_ID, "debug", {
    name: "SELECTIVEWALLS.SettingDebugName",
    hint: "SELECTIVEWALLS.SettingDebugHint",
    scope: "client",
    config: true,
    type: Boolean,
    default: false,
    onChange: () => scheduleRebuild()
  });
}

/* ------------------------------------------------------------------ */
/*  Секция в окне конфигурации стены                                   */
/* ------------------------------------------------------------------ */

Hooks.on("renderWallConfig", (app, html) => {
  try {
    renderFieldset(app, Array.isArray(html) ? html[0] : html);
  } catch (err) {
    console.warn("Selective Walls: не удалось построить секцию настроек стены", err);
  }
});

function isWallDocument(document) {
  if (!document?.id || !document.parent) return false;
  const name = document.constructor?.metadata?.name ?? document.documentName;
  if (name && name !== "Wall") return false;
  // Резервная проверка без реестра: у стены есть координаты c и признак двери.
  return Array.isArray(document.c) || typeof document.door === "string";
}

async function renderFieldset(app, root) {
  const wallDoc = app?.document ?? null;
  if (!isWallDocument(wallDoc)) return;

  const form = app.form ?? (root?.tagName === "FORM" ? root : root?.querySelector?.("form"));
  if (!form || form.querySelector(".selective-walls")) return;

  let current;
  try {
    current = normalizeEntries(wallDoc.getFlag(NAMESPACE, FLAG_KEY));
  } catch (err) {
    console.warn("Selective Walls: недоступно чтение флага скрытия", err);
    return;
  }
  const editable = app.isEditable !== false;

  const fieldset = document.createElement("fieldset");
  fieldset.className = "selective-walls";

  const legend = document.createElement("legend");
  legend.textContent = game.i18n.localize("SELECTIVEWALLS.FieldsetLabel");
  fieldset.appendChild(legend);

  const hint = document.createElement("p");
  hint.className = "hint sw-hint";
  hint.textContent = game.i18n.localize(editable ? "SELECTIVEWALLS.FieldsetHint" : "SELECTIVEWALLS.ReadOnlyHint");
  fieldset.appendChild(hint);

  // Пользователи мира: все игроки, кроме Мастера (GM прячет стены сам у себя).
  const users = [];
  for (const u of game.users ?? []) {
    if (!u?.id || u.isGM) continue;
    let name = "";
    try { name = String(u.name ?? ""); } catch { /* без имени */ }
    users.push({id: u.id, name});
  }

  const group = document.createElement("div");
  group.className = "sw-group";

  const header = document.createElement("h4");
  header.textContent = game.i18n.localize("SELECTIVEWALLS.GroupUsers");
  group.appendChild(header);

  let control = null;
  if (!users.length) {
    const empty = document.createElement("p");
    empty.className = "hint sw-empty";
    empty.textContent = game.i18n.localize("SELECTIVEWALLS.NoneAvailable");
    group.appendChild(empty);
  } else {
    users.sort((a, b) => a.name.localeCompare(b.name, undefined, {sensitivity: "base"}));
    control = createUserControl(users, current.users, editable);
    group.appendChild(control.element);

    // Старые списки персонажей и токенов продолжают работать, но в этом списке не показываются.
    if (current.actors.size || current.tokens.size) {
      const legacy = document.createElement("p");
      legacy.className = "hint sw-note";
      legacy.textContent = game.i18n.format("SELECTIVEWALLS.LegacySaved", {
        actors: current.actors.size,
        tokens: current.tokens.size
      });
      group.appendChild(legacy);
    }
  }

  fieldset.appendChild(group);

  const note = document.createElement("p");
  note.className = "hint sw-note";
  note.textContent = game.i18n.localize("SELECTIVEWALLS.GmNote");
  fieldset.appendChild(note);

  form.appendChild(fieldset);

  if (!control || !editable) return;

  // Выбор сохраняется сразу: флаги стены не входят в ключи пересоздания рёбер,
  // поэтому шторма перерисовки визжена это не вызывает.
  control.element.addEventListener("change", async event => {
    event.stopPropagation(); // значение не является полем формы конфигурации стены

    const known = new Set(users.map(u => u.id));
    const usersNext = [];
    for (const id of control.read()) if (known.has(id) && !usersNext.includes(id)) usersNext.push(id);

    try {
      // Legacy-значения актёров/токенов не теряются: они по-прежнему участвуют в скрытии.
      const value = (usersNext.length || current.actors.size || current.tokens.size)
        ? {users: usersNext, actors: [...current.actors], tokens: [...current.tokens]}
        : null;
      await wallDoc.setFlag(NAMESPACE, FLAG_KEY, value);
      debug(`флаг сохранён: стена ${wallDoc.id}, игроков=${usersNext.length}`);
    } catch (err) {
      console.warn("Selective Walls: не удалось сохранить список", err);
    }
  });
}

/**
 * Выпадающий выбор пользователей. Используется штатный элемент ядра v14
 * <multi-select>: выпадающий select плюс выбранные значения в виде тегов, которые
 * можно удалять. Если реестр элементов по какой-то причине недоступен, берётся
 * обычный множественный select. Атрибут name не задаётся нигде — значения не
 * попадают в FormData окна и не влияют на предпросмотр изменений стены.
 */
function createUserControl(rows, selected, editable) {
  const chosen = new Set(selected);

  if (window.customElements?.get?.("multi-select")) {
    const el = document.createElement("multi-select");
    for (const row of rows) {
      const option = document.createElement("option");
      option.value = row.id;
      option.textContent = row.name || game.i18n.localize("SELECTIVEWALLS.Unnamed");
      // Отмеченные опции элемент превратит в своё значение при подключении.
      if (chosen.has(row.id)) option.selected = true;
      el.appendChild(option);
    }
    if (!editable) {
      el.disabled = true;
      queueMicrotask(() => disableInnerControls(el));
    }
    return {element: el, read: () => Array.isArray(el.value) ? [...el.value] : []};
  }

  const fallback = document.createElement("select");
  fallback.multiple = true;
  fallback.size = Math.min(6, Math.max(2, rows.length));
  for (const row of rows) {
    const option = document.createElement("option");
    option.value = row.id;
    option.textContent = row.name || game.i18n.localize("SELECTIVEWALLS.Unnamed");
    if (chosen.has(row.id)) option.selected = true;
    fallback.appendChild(option);
  }
  fallback.disabled = !editable;
  return {element: fallback, read: () => [...fallback.selectedOptions].map(o => o.value)};
}

/** На всякий случай глушим вложенные контролы кастомного элемента (если ядро не сделало это само). */
function disableInnerControls(el) {
  try {
    el.setAttribute("disabled", "");
    for (const node of el.querySelectorAll?.("select,input,button") ?? []) node.disabled = true;
  } catch { /* элемент ещё не подключён */ }
}

/* ------------------------------------------------------------------ */
/*  Хуки ядра                                                          */
/* ------------------------------------------------------------------ */

Hooks.once("init", () => {
  registerSettings();
  patchPolygonBackends();
  patchWallPlaceable();
  patchDoorControl();
});

// Состояние должно быть готово до отрисовки сцены, чтобы геттеры сразу дали верный ответ.
Hooks.on("canvasInit", () => {
  // Новый уровень/сцена: объекты рисуются заново, поэтому применяем скрытие повторно,
  // даже если набор id стен совпадает с предыдущим уровнем.
  lastFingerprint = "";
  recomputeState();
});

Hooks.on("canvasReady", () => {
  rebuild(true);
  // Меши дверей и иконки создаются асинхронно во время отрисовки — повторим применение.
  setTimeout(() => applyRendering(), 250);
});

// Изменения стен (в том числе флагов из окна конфигурации) пересчитывают состояние.
Hooks.on("createWall", () => scheduleRebuild());
Hooks.on("updateWall", () => scheduleRebuild());
Hooks.on("deleteWall", () => scheduleRebuild());

// Права на токены и их состав влияют на то, чьи полигоны фильтруются.
Hooks.on("createToken", () => scheduleRebuild());
Hooks.on("updateToken", () => scheduleRebuild());
Hooks.on("deleteToken", () => scheduleRebuild());
Hooks.on("controlTokens", () => {
  // Взятие токена под управление делает его источники «нашими».
  if (!game.user?.isGM) scheduleRebuild();
});

// Смена прав на актёров/токены и вход пользователя тоже меняют набор значимых токенов.
Hooks.on("updateActor", () => scheduleRebuild());
Hooks.on("updateUser", () => scheduleRebuild());
