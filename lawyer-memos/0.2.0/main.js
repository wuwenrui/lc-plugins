// src/logic.ts
var MAX_MEMOS = 1e4;
var MAX_TEXT_LENGTH = 2e3;
var MemoError = class extends Error {
  kind;
  constructor(message, kind = "args") {
    super(message);
    this.name = "MemoError";
    this.kind = kind;
  }
};
function emptyState() {
  return { nextId: 1, items: [] };
}
function cloneItem(item) {
  return { ...item };
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isIsoString(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
function isItemId(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
var ITEM_FIELDS = ["id", "text", "done", "createdAt", "doneAt"];
function validateState(value) {
  if (!isRecord(value)) throw new MemoError("\u5907\u5FD8\u5F55\u6570\u636E\u4E0D\u662F\u5BF9\u8C61", "store");
  const { nextId, items } = value;
  if (!isItemId(nextId)) throw new MemoError("\u5907\u5FD8\u5F55\u6570\u636E nextId \u4E0D\u5408\u6CD5", "store");
  if (!Array.isArray(items) || items.length > MAX_MEMOS) throw new MemoError("\u5907\u5FD8\u5F55\u6570\u636E items \u4E0D\u5408\u6CD5\u6216\u8D85\u8FC7\u4E0A\u9650", "store");
  const seen = /* @__PURE__ */ new Set();
  for (const entry of items) {
    if (!isRecord(entry)) throw new MemoError("\u5907\u5FD8\u5F55\u6761\u76EE\u4E0D\u662F\u5BF9\u8C61", "store");
    const keys = Object.keys(entry);
    if (keys.some((key) => !ITEM_FIELDS.includes(key))) {
      throw new MemoError(`\u5907\u5FD8\u5F55\u6761\u76EE\u5305\u542B\u4E0D\u652F\u6301\u7684\u5B57\u6BB5\uFF1A${keys.join(", ")}`, "store");
    }
    if (!isItemId(entry.id) || seen.has(entry.id)) throw new MemoError("\u5907\u5FD8\u5F55\u6761\u76EE id \u4E0D\u5408\u6CD5\u6216\u91CD\u590D", "store");
    seen.add(entry.id);
    if (entry.id >= nextId) throw new MemoError("\u5907\u5FD8\u5F55\u6761\u76EE id \u4E0D\u5C0F\u4E8E nextId", "store");
    if (typeof entry.text !== "string" || !entry.text.trim() || entry.text.length > MAX_TEXT_LENGTH) {
      throw new MemoError(`\u5907\u5FD8 #${entry.id} \u7684\u5185\u5BB9\u4E3A\u7A7A\u6216\u8D85\u8FC7 ${MAX_TEXT_LENGTH} \u5B57`, "store");
    }
    if (typeof entry.done !== "boolean") throw new MemoError(`\u5907\u5FD8 #${entry.id} \u7684 done \u4E0D\u662F\u5E03\u5C14\u503C`, "store");
    if (!isIsoString(entry.createdAt)) throw new MemoError(`\u5907\u5FD8 #${entry.id} \u7684 createdAt \u4E0D\u662F\u6709\u6548\u65F6\u95F4`, "store");
    if (entry.doneAt === void 0) {
      if (entry.done) throw new MemoError(`\u5907\u5FD8 #${entry.id} \u5DF2\u5B8C\u6210\u4F46\u7F3A\u5C11 doneAt`, "store");
    } else if (!isIsoString(entry.doneAt) || !entry.done) {
      throw new MemoError(`\u5907\u5FD8 #${entry.id} \u7684 doneAt \u4E0E done \u77DB\u76FE`, "store");
    }
  }
  return { nextId, items: items.map(cloneItem) };
}
function parseState(value) {
  if (value === void 0 || value === null) return emptyState();
  try {
    return validateState(value);
  } catch {
    return emptyState();
  }
}
function normalizeStatus(value) {
  if (value === void 0 || value === null || value === "") return "open";
  if (value === "open" || value === "done" || value === "all") return value;
  throw new MemoError("status \u53EA\u652F\u6301 open\u3001done \u6216 all");
}
function normalizeText(value) {
  if (typeof value !== "string") throw new MemoError("text \u5FC5\u987B\u662F\u5B57\u7B26\u4E32");
  const text = value.trim();
  if (!text) throw new MemoError("\u5907\u5FD8\u5185\u5BB9\u4E0D\u80FD\u4E3A\u7A7A");
  if (text.length > MAX_TEXT_LENGTH) throw new MemoError(`\u5907\u5FD8\u5185\u5BB9\u4E0D\u80FD\u8D85\u8FC7 ${MAX_TEXT_LENGTH} \u5B57`);
  return text;
}
function normalizeId(value) {
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) value = Number(value.trim());
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  throw new MemoError("id \u5FC5\u987B\u662F\u6B63\u6574\u6570\uFF08memos_list \u8FD4\u56DE\u7684\u7F16\u53F7\uFF09");
}
function findItem(state, rawId) {
  const id = normalizeId(rawId);
  const existing = state.items.find((item) => item.id === id);
  if (!existing) throw new MemoError(`\u5907\u5FD8 #${id} \u4E0D\u5B58\u5728\uFF0C\u53EF\u7528 memos_list \u67E5\u770B\u5F53\u524D\u7F16\u53F7`);
  return existing;
}
function listItems(state, status = "open") {
  const filtered = state.items.filter((item) => status === "all" ? true : status === "done" ? item.done : !item.done);
  return [...filtered].sort((a, b) => b.id - a.id).map(cloneItem);
}
function createItem(state, input, now = /* @__PURE__ */ new Date()) {
  const text = normalizeText(input?.text);
  if (state.items.length >= MAX_MEMOS) throw new MemoError(`\u5907\u5FD8\u6700\u591A ${MAX_MEMOS} \u6761`);
  const item = { id: state.nextId, text, done: false, createdAt: now.toISOString() };
  const next = { nextId: state.nextId + 1, items: [...state.items, item] };
  return { state: next, item: cloneItem(item) };
}
function completeItem(state, id, now = /* @__PURE__ */ new Date()) {
  const existing = findItem(state, id);
  if (existing.done) return { state, item: cloneItem(existing), alreadyDone: true };
  const item = { ...cloneItem(existing), done: true, doneAt: now.toISOString() };
  const items = state.items.map((entry) => entry.id === item.id ? item : entry);
  return { state: { nextId: state.nextId, items }, item: cloneItem(item), alreadyDone: false };
}
function reopenItem(state, id) {
  const existing = findItem(state, id);
  if (!existing.done) return { state, item: cloneItem(existing) };
  const item = { id: existing.id, text: existing.text, done: false, createdAt: existing.createdAt };
  const items = state.items.map((entry) => entry.id === item.id ? item : entry);
  return { state: { nextId: state.nextId, items }, item: cloneItem(item) };
}
function toggleItem(state, id) {
  const existing = findItem(state, id);
  if (!existing.done) {
    const outcome2 = completeItem(state, id);
    return { state: outcome2.state, item: outcome2.item, reopened: false };
  }
  const outcome = reopenItem(state, id);
  return { state: outcome.state, item: outcome.item, reopened: true };
}
function renderItem(item) {
  const stamp = item.doneAt ? `\uFF08\u5B8C\u6210\u4E8E ${item.doneAt.slice(0, 10)}\uFF09` : "";
  return `- ${item.done ? "[x]" : "[ ]"} #${item.id} ${item.text}${stamp}`;
}
function renderList(status, items) {
  if (status === "all") {
    if (!items.length) return "\u5F53\u524D\u6CA1\u6709\u4EFB\u4F55\u5907\u5FD8\u3002";
    const open = items.filter((item) => !item.done).length;
    const done = items.length - open;
    return [`\u5171 ${items.length} \u6761\u5907\u5FD8\uFF08\u672A\u5B8C\u6210 ${open} \u6761\uFF0C\u5DF2\u5B8C\u6210 ${done} \u6761\uFF09\uFF1A`, ...items.map(renderItem)].join("\n");
  }
  const label = status === "open" ? "\u672A\u5B8C\u6210" : "\u5DF2\u5B8C\u6210";
  if (!items.length) return `\u5F53\u524D\u6CA1\u6709${label}\u7684\u5907\u5FD8\u3002`;
  return [`\u5171 ${items.length} \u6761${label}\u5907\u5FD8\uFF1A`, ...items.map(renderItem)].join("\n");
}

// src/apple.ts
var APPLE_LIST_NAME = "\u5F8B\u5E08\u5907\u5FD8\u5F55";
var MEMO_TAG_PREFIX = "#lc-";
var OSA_TIMEOUT_MS = 2e4;
var RECONCILE_SOFT_TIMEOUT_MS = 9e3;
var RECONCILE_MIN_INTERVAL_MS = 15e3;
var AppleSyncError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "AppleSyncError";
  }
};
function lit(value) {
  return JSON.stringify(value);
}
function tagFor(memoId) {
  return `${MEMO_TAG_PREFIX}${memoId}`;
}
function buildEnsureListScript(listName = APPLE_LIST_NAME) {
  return `const app = Application("Reminders");
const LIST = ${lit(listName)};
let found = app.lists.whose({name: LIST});
if (found.length === 0) { app.lists.push(app.List({name: LIST})); found = app.lists.whose({name: LIST}); }
JSON.stringify({ok: found.length > 0})`;
}
function buildListRemindersScript(listName = APPLE_LIST_NAME) {
  return `const app = Application("Reminders");
const found = app.lists.whose({name: ${lit(listName)}});
if (found.length === 0) { JSON.stringify({ok: false, error: "list-missing"}) }
else {
  const rs = found[0].reminders();
  JSON.stringify({ok: true, items: rs.map(function (r) {
    return {name: r.name(), body: String(r.body() || ""), completed: r.completed(), id: r.id()};
  })});
}`;
}
function buildCreateReminderScript(name, memoId, listName = APPLE_LIST_NAME) {
  const tag = lit(tagFor(memoId));
  return `const app = Application("Reminders");
const found = app.lists.whose({name: ${lit(listName)}});
if (found.length === 0) { JSON.stringify({ok: false, error: "list-missing"}) }
else {
  const list = found[0];
  const NAME = ${lit(name)};
  const TAG = ${tag};
  list.reminders.push(app.Reminder({name: NAME, body: "LawyerCopilot \u5F8B\u5E08\u5907\u5FD8\u5F55 " + TAG}));
  const all = list.reminders();
  let hit = null;
  for (const x of all) { if (x.name() === NAME && x.body() != null && String(x.body()).indexOf(TAG) >= 0) { hit = x; break } }
  if (!hit) { for (const x of all) { if (x.name() === NAME) { hit = x; break } } }
  JSON.stringify({ok: !!hit, id: hit ? hit.id() : null, name: hit ? hit.name() : null});
}`;
}
function buildSetCompletedScript(reminderId, completed, listName = APPLE_LIST_NAME) {
  return `const app = Application("Reminders");
const found = app.lists.whose({name: ${lit(listName)}});
if (found.length === 0) { JSON.stringify({ok: false, error: "list-missing"}) }
else {
  const rs = found[0].reminders.whose({id: ${lit(reminderId)}});
  if (rs.length === 0) { JSON.stringify({ok: false, error: "not-found"}) }
  else { rs[0].completed = ${completed ? "true" : "false"}; JSON.stringify({ok: true}) }
}`;
}
function parseAppleOut(stdout, code, stderr) {
  if (code !== 0) {
    const detail = (stderr || "").trim() || `exit ${code}`;
    throw new AppleSyncError(`osascript \u5931\u8D25\uFF1A${detail}`);
  }
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start < 0 || end <= start) throw new AppleSyncError(`osascript \u8F93\u51FA\u65E0\u6CD5\u89E3\u6790\uFF1A${stdout.slice(0, 200)}`);
  try {
    return JSON.parse(stdout.slice(start, end + 1));
  } catch {
    throw new AppleSyncError(`osascript \u8F93\u51FA\u4E0D\u662F JSON\uFF1A${stdout.slice(0, 200)}`);
  }
}
function toView(raw) {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw;
  const name = typeof record.name === "string" ? record.name : "";
  const id = typeof record.id === "string" ? record.id : "";
  if (!name || !id) return null;
  return {
    name,
    body: typeof record.body === "string" ? record.body : "",
    completed: record.completed === true,
    id
  };
}
function parseReminderList(result) {
  if (typeof result !== "object" || result === null) throw new AppleSyncError("listReminders \u7ED3\u679C\u4E0D\u662F\u5BF9\u8C61");
  const record = result;
  if (record.ok !== true) throw new AppleSyncError(`listReminders \u5931\u8D25\uFF1A${String(record.error ?? "unknown")}`);
  if (!Array.isArray(record.items)) throw new AppleSyncError("listReminders \u7ED3\u679C\u7F3A\u5C11 items");
  const views = [];
  for (const entry of record.items) {
    const view = toView(entry);
    if (view) views.push(view);
  }
  return views;
}
function parseCreatedId(result) {
  if (typeof result !== "object" || result === null) throw new AppleSyncError("createReminder \u7ED3\u679C\u4E0D\u662F\u5BF9\u8C61");
  const record = result;
  if (record.ok !== true || typeof record.id !== "string" || !record.id) {
    throw new AppleSyncError(`createReminder \u5931\u8D25\uFF1A${String(record.error ?? record.id ?? "unknown")}`);
  }
  return record.id;
}
function validateAppleMap(value) {
  if (value === void 0 || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new AppleSyncError("apple-map \u4E0D\u662F\u5BF9\u8C61");
  const map = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!/^\d+$/.test(key)) throw new AppleSyncError(`apple-map \u952E\u4E0D\u662F memo id\uFF1A${key}`);
    if (typeof entry !== "object" || entry === null) throw new AppleSyncError(`apple-map \u6761\u76EE\u4E0D\u662F\u5BF9\u8C61\uFF1A${key}`);
    const record = entry;
    if (typeof record.id !== "string" || !record.id) throw new AppleSyncError(`apple-map \u6761\u76EE\u7F3A\u5C11 id\uFF1A${key}`);
    if (typeof record.name !== "string") throw new AppleSyncError(`apple-map \u6761\u76EE name \u4E0D\u662F\u5B57\u7B26\u4E32\uFF1A${key}`);
    if (typeof record.lastCompleted !== "boolean") {
      throw new AppleSyncError(`apple-map \u6761\u76EE lastCompleted \u4E0D\u662F\u5E03\u5C14\u503C\uFF1A${key}`);
    }
    map[key] = { id: record.id, name: record.name, lastCompleted: record.lastCompleted };
  }
  return map;
}
function parseAppleMap(value) {
  try {
    return validateAppleMap(value);
  } catch {
    return {};
  }
}
function extractMemoTag(body) {
  const match = body.match(/#lc-(\d+)/);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}
function entryFor(memo, map, byId) {
  const entry = map[String(memo.id)];
  if (entry) {
    const hit = byId.get(entry.id);
    if (hit) return hit;
    for (const view of byId.values()) {
      if (extractMemoTag(view.body) === memo.id) return view;
    }
    for (const view of byId.values()) {
      if (view.name === entry.name && view.name === memo.text) return view;
    }
    return null;
  }
  for (const view of byId.values()) {
    if (extractMemoTag(view.body) === memo.id) return view;
  }
  for (const view of byId.values()) {
    if (view.name === memo.text && extractMemoTag(view.body) === null) return view;
  }
  return null;
}
function planSync(localItems, map, apple) {
  const byId = /* @__PURE__ */ new Map();
  for (const view of apple) byId.set(view.id, view);
  const plan = { localPatches: [], appleCreates: [], applePatches: [], mapUpdates: {}, mapDrops: [] };
  const seenMemoIds = /* @__PURE__ */ new Set();
  for (const memo of localItems) {
    seenMemoIds.add(memo.id);
    const entry = map[String(memo.id)];
    const view = entryFor(memo, map, byId);
    if (!view) {
      plan.appleCreates.push({ memoId: memo.id, name: memo.text, completeAfter: memo.done });
      if (entry) plan.mapDrops.push(String(memo.id));
      continue;
    }
    if (!entry) {
      plan.mapUpdates[String(memo.id)] = { id: view.id, name: view.name, lastCompleted: view.completed };
      if (view.completed !== memo.done) {
        plan.localPatches.push({ memoId: memo.id, done: view.completed });
      }
      continue;
    }
    if (view.completed === memo.done) {
      if (entry.lastCompleted !== view.completed) {
        plan.mapUpdates[String(memo.id)] = { id: view.id, name: view.name, lastCompleted: view.completed };
      }
      continue;
    }
    const appleChanged = entry.lastCompleted !== view.completed;
    const localChanged = entry.lastCompleted !== memo.done;
    const localWins = localChanged || !appleChanged && !localChanged;
    if (localWins) {
      plan.applePatches.push({ reminderId: view.id, memoId: memo.id, completed: memo.done });
      plan.mapUpdates[String(memo.id)] = { id: view.id, name: view.name, lastCompleted: memo.done };
    } else {
      plan.localPatches.push({ memoId: memo.id, done: view.completed });
      plan.mapUpdates[String(memo.id)] = { id: view.id, name: view.name, lastCompleted: view.completed };
    }
  }
  for (const key of Object.keys(map)) {
    if (!seenMemoIds.has(Number(key))) plan.mapDrops.push(key);
  }
  return plan;
}
function applyPlanToMap(map, plan) {
  const next = { ...map };
  for (const key of plan.mapDrops) delete next[key];
  for (const [key, entry] of Object.entries(plan.mapUpdates)) next[key] = { ...entry };
  return next;
}

// src/index.ts
var STORAGE_KEY = "records";
var MAP_KEY = "apple-map";
function activate(ctx) {
  const disposers = [];
  let state = emptyState();
  let stateLoaded = null;
  let serial = Promise.resolve();
  function enqueue(task) {
    const run = serial.then(task, task);
    serial = run.then(
      () => void 0,
      () => void 0
    );
    return run;
  }
  function ensureLoaded() {
    stateLoaded ??= ctx.storage.get(STORAGE_KEY).then((raw) => parseState(raw)).then((loaded) => {
      state = loaded;
    }).catch((error) => {
      stateLoaded = null;
      throw error;
    });
    return stateLoaded;
  }
  async function read(fn) {
    return enqueue(async () => {
      await ensureLoaded();
      return fn(state);
    });
  }
  async function mutate(fn) {
    return enqueue(async () => {
      await ensureLoaded();
      const outcome = fn(state);
      await ctx.storage.set(STORAGE_KEY, outcome.state);
      state = outcome.state;
      return outcome.result;
    });
  }
  let syncStatus = ctx.host.isWeb ? "local-only" : "connecting";
  let syncLastError = "";
  let lastSyncAt = null;
  let syncSerial = Promise.resolve();
  function enqueueSync(task) {
    const run = syncSerial.then(task, task);
    syncSerial = run.then(
      () => void 0,
      () => void 0
    );
    return run;
  }
  async function osa(script) {
    const raw = await ctx.bridge.invoke("plugin_exec_run", {
      bin: "osascript",
      args: ["-l", "JavaScript", "-e", script],
      timeoutMs: OSA_TIMEOUT_MS
    });
    if (typeof raw !== "object" || raw === null) throw new Error("plugin_exec_run \u8FD4\u56DE\u5F02\u5E38");
    const record = raw;
    return parseAppleOut(
      typeof record.stdout === "string" ? record.stdout : "",
      typeof record.code === "number" ? record.code : -1,
      typeof record.stderr === "string" ? record.stderr : ""
    );
  }
  async function loadMap() {
    return parseAppleMap(await ctx.storage.get(MAP_KEY));
  }
  async function saveMap(map) {
    await ctx.storage.set(MAP_KEY, map);
  }
  function updateMap(fn) {
    return enqueueSync(async () => {
      const map = await loadMap();
      const next = await fn(map);
      if (next) await saveMap(next);
    });
  }
  function reconcile() {
    return enqueueSync(async () => {
      try {
        const items = await read(
          (current) => current.items.map((item) => ({ id: item.id, text: item.text, done: item.done }))
        );
        const map = await loadMap();
        const ensured = await osa(buildEnsureListScript());
        if (ensured?.ok !== true) throw new Error(`\u5217\u8868\u300C${APPLE_LIST_NAME}\u300D\u4E0D\u53EF\u7528`);
        const views = parseReminderList(await osa(buildListRemindersScript()));
        const plan = planSync(items, map, views);
        for (const patch of plan.localPatches) {
          await mutate((current) => {
            const outcome = patch.done ? completeItem(current, patch.memoId) : reopenItem(current, patch.memoId);
            return { state: outcome.state, result: outcome.item.done };
          });
        }
        const mapUpdates = { ...plan.mapUpdates };
        for (const create of plan.appleCreates) {
          const id = parseCreatedId(await osa(buildCreateReminderScript(create.name, create.memoId)));
          if (create.completeAfter) await osa(buildSetCompletedScript(id, true));
          mapUpdates[String(create.memoId)] = { id, name: create.name, lastCompleted: create.completeAfter };
        }
        for (const patch of plan.applePatches) {
          await osa(buildSetCompletedScript(patch.reminderId, patch.completed));
        }
        await saveMap(applyPlanToMap(map, { ...plan, mapUpdates }));
        syncStatus = "connected";
        syncLastError = "";
        lastSyncAt = Date.now();
      } catch (cause) {
        syncStatus = "local-only";
        syncLastError = cause instanceof Error ? cause.message : String(cause);
      }
      return syncInfo();
    });
  }
  function syncInfo() {
    return { status: syncStatus, lastError: syncLastError, lastSyncAt };
  }
  async function withSoftTimeout(task, fallback) {
    let settled = false;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve(fallback);
        }
      }, RECONCILE_SOFT_TIMEOUT_MS);
      task().then((value) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(value);
        }
      }).catch(() => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(fallback);
        }
      });
    });
  }
  async function syncBeforeTool() {
    if (ctx.host.isWeb) return;
    if (syncStatus === "connected" && lastSyncAt !== null && Date.now() - lastSyncAt < RECONCILE_MIN_INTERVAL_MS) return;
    await withSoftTimeout(reconcile, void 0);
  }
  function pushCreate(item) {
    if (syncStatus !== "connected") return;
    void updateMap(async (map) => {
      const key = String(item.id);
      if (map[key]) return void 0;
      const id = parseCreatedId(await osa(buildCreateReminderScript(item.text, item.id)));
      return { ...map, [key]: { id, name: item.text, lastCompleted: false } };
    }).catch(() => void 0);
  }
  function pushComplete(item) {
    if (syncStatus !== "connected") return;
    void (async () => {
      try {
        const entry = await enqueueSync(async () => (await loadMap())[String(item.id)]);
        if (entry) {
          await updateMap(async (map) => {
            const current = map[String(item.id)];
            if (!current) return void 0;
            await osa(buildSetCompletedScript(current.id, true));
            return { ...map, [String(item.id)]: { ...current, lastCompleted: true } };
          });
          return;
        }
        await reconcile();
      } catch {
      }
    })();
  }
  function syncSuffix() {
    return syncStatus === "connected" ? "\uFF08\u5DF2\u540C\u6B65\u5230\u7CFB\u7EDF\u63D0\u9192\u4E8B\u9879\uFF09" : "\uFF08\u672C\u673A\u8BB0\u5F55\uFF0C\u7CFB\u7EDF\u63D0\u9192\u4E8B\u9879\u672A\u8FDE\u63A5\uFF09";
  }
  if (!ctx.host.isWeb) {
    void reconcile().catch(() => void 0);
  }
  const api = {
    list: (status) => read((current) => listItems(current, normalizeStatus(status))),
    all: () => read((current) => [...current.items]),
    create: (text) => mutate((current) => {
      const outcome = createItem(current, { text });
      return { state: outcome.state, result: outcome.item };
    }),
    complete: (id) => mutate((current) => {
      const outcome = completeItem(current, id);
      return { state: outcome.state, result: outcome };
    }),
    toggle: (id) => mutate((current) => {
      const outcome = toggleItem(current, id);
      return { state: outcome.state, result: outcome };
    }),
    syncInfo: () => syncInfo(),
    retrySync: () => {
      if (ctx.host.isWeb) return Promise.resolve(syncInfo());
      syncStatus = "connecting";
      void reconcile().catch(() => void 0);
      return Promise.resolve(syncInfo());
    },
    /** 设置页操作后触发后台对账（覆盖新建、完成、重新打开全部方向）。 */
    scheduleSync: () => {
      if (!ctx.host.isWeb) void reconcile().catch(() => void 0);
    }
  };
  function textResult(text) {
    return { content: [{ type: "text", text }] };
  }
  disposers.push(
    ctx.tools.register({
      name: "memos_list",
      description: "\u5217\u51FA\u5F8B\u5E08\u5907\u5FD8\u5F55\u3002\u9ED8\u8BA4\u53EA\u770B\u672A\u5B8C\u6210\uFF08open\uFF09\uFF0C\u53EF\u9009 done\uFF08\u5DF2\u5B8C\u6210\uFF09\u3001all\uFF08\u5168\u90E8\uFF09\uFF1B\u53EA\u8BFB\uFF0C\u4E0D\u4FEE\u6539\u6570\u636E\u3002",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          status: {
            type: "string",
            enum: ["open", "done", "all"],
            description: "\u7B5B\u9009\u8303\u56F4\uFF1Aopen=\u672A\u5B8C\u6210\uFF08\u9ED8\u8BA4\uFF09\u3001done=\u5DF2\u5B8C\u6210\u3001all=\u5168\u90E8"
          }
        },
        required: []
      },
      async execute(args = {}) {
        const input = args ?? {};
        const status = normalizeStatus(input.status);
        await syncBeforeTool();
        const items = await api.list(status);
        return textResult(renderList(status, items));
      }
    })
  );
  disposers.push(
    ctx.tools.register({
      name: "memos_create",
      description: "\u65B0\u5EFA\u4E00\u6761\u5907\u5FD8\uFF08\u5F85\u529E\uFF09\uFF0C\u5E76\u81EA\u52A8\u540C\u6B65\u5230 macOS\u300C\u63D0\u9192\u4E8B\u9879\u300DApp \u7684\u300C\u5F8B\u5E08\u5907\u5FD8\u5F55\u300D\u5217\u8868\u3002\u9002\u5408\u5728\u5BF9\u8BDD\u4E2D\u8BB0\u5F55\u5F85\u529E\u4E8B\u9879\u3001\u671F\u9650\u6216\u540E\u7EED\u52A8\u4F5C\uFF1B\u7EAF\u8FFD\u52A0\uFF0C\u4E0D\u5F71\u54CD\u5DF2\u6709\u5907\u5FD8\u3002",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["text"],
        properties: {
          text: {
            type: "string",
            description: "\u5907\u5FD8\u5185\u5BB9\uFF0C\u4E00\u53E5\u8BDD\u5199\u6E05\u8981\u505A\u4EC0\u4E48\uFF08\u5FC5\u586B\uFF0C\u53BB\u9996\u5C3E\u7A7A\u767D\u540E\u4E0D\u80FD\u4E3A\u7A7A\uFF0C\u6700\u591A 2000 \u5B57\uFF09"
          }
        }
      },
      async execute(args = {}) {
        const input = args ?? {};
        await syncBeforeTool();
        const item = await api.create(input.text);
        pushCreate(item);
        return textResult(`\u5DF2\u521B\u5EFA\u5907\u5FD8 #${item.id}\uFF1A${item.text}${syncSuffix()}`);
      }
    })
  );
  disposers.push(
    ctx.tools.register({
      name: "memos_complete",
      description: "\u628A\u4E00\u6761\u5907\u5FD8\u6807\u8BB0\u4E3A\u5DF2\u5B8C\u6210\uFF08\u540C\u65F6\u81EA\u52A8\u52FE\u9009 macOS\u300C\u63D0\u9192\u4E8B\u9879\u300D\u91CC\u7684\u5BF9\u5E94\u63D0\u9192\uFF09\u3002id \u6765\u81EA memos_list \u8FD4\u56DE\u7684\u7F16\u53F7\uFF1B\u91CD\u590D\u5B8C\u6210\u662F\u5B89\u5168\u7684\uFF0C\u4E0D\u4F1A\u5220\u9664\u4EFB\u4F55\u6570\u636E\u3002",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["id"],
        properties: {
          id: {
            type: "integer",
            minimum: 1,
            description: "\u8981\u5B8C\u6210\u7684\u5907\u5FD8\u7F16\u53F7\uFF08memos_list \u7ED3\u679C\u4E2D\u7684 #id\uFF09"
          }
        }
      },
      async execute(args = {}) {
        const input = args ?? {};
        await syncBeforeTool();
        const outcome = await api.complete(input.id);
        if (!outcome.alreadyDone) pushComplete(outcome.item);
        return textResult(
          outcome.alreadyDone ? `\u5907\u5FD8 #${outcome.item.id} \u6B64\u524D\u5DF2\u5B8C\u6210\uFF0C\u4FDD\u6301\u4E0D\u53D8\uFF1A${outcome.item.text}` : `\u5DF2\u5B8C\u6210\u5907\u5FD8 #${outcome.item.id}\uFF1A${outcome.item.text}${syncSuffix()}`
        );
      }
    })
  );
  disposers.push(
    ctx.ui.registerSettingsSection({
      key: "lawyer-memos",
      label: () => "\u5F8B\u5E08\u5907\u5FD8\u5F55",
      component: createSettingsPanel(ctx, api)
    })
  );
  return () => {
    for (const dispose of disposers.splice(0)) dispose();
  };
}
var STATUS_REFRESH_MS = 4e3;
function createSettingsPanel(ctx, api) {
  const { createElement, useState, useEffect } = ctx.react;
  return function MemosSettingsPanel() {
    const [items, setItems] = useState([]);
    const [draft, setDraft] = useState("");
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);
    const [sync, setSync] = useState(() => api.syncInfo());
    const [retrying, setRetrying] = useState(false);
    useEffect(() => {
      void api.all().then((loaded) => setItems(loaded)).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
      setSync(api.syncInfo());
      const timer = setInterval(() => setSync(api.syncInfo()), STATUS_REFRESH_MS);
      return () => clearInterval(timer);
    }, []);
    async function run(action) {
      setBusy(true);
      setError("");
      try {
        await action();
        setItems(await api.all());
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    }
    function add() {
      const text = draft;
      if (busy || !text.trim()) return;
      void run(async () => {
        await api.create(text);
        setDraft("");
        api.scheduleSync();
      });
    }
    async function retry() {
      setRetrying(true);
      try {
        setSync(api.syncInfo());
        await api.retrySync();
        const capUntil = Date.now() + RECONCILE_SOFT_TIMEOUT_MS + 1e3;
        while (api.syncInfo().status === "connecting" && Date.now() < capUntil) {
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
        setSync(api.syncInfo());
      } finally {
        setRetrying(false);
      }
    }
    const open = items.filter((item) => !item.done).sort((a, b) => b.id - a.id);
    const done = items.filter((item) => item.done).sort((a, b) => b.id - a.id);
    const ordered = [...open, ...done];
    const connected = sync.status === "connected";
    const banner = sync.status === "connecting" ? { dot: "bg-gray-300", text: "\u6B63\u5728\u8FDE\u63A5\u7CFB\u7EDF\u63D0\u9192\u4E8B\u9879\u2026" } : connected ? { dot: "bg-green-500", text: `\u5DF2\u8FDE\u63A5\u7CFB\u7EDF\u63D0\u9192\u4E8B\u9879 \xB7 \u300C${APPLE_LIST_NAME}\u300D\u5217\u8868` } : { dot: "bg-amber-500", text: "\u4EC5\u672C\u673A\uFF08\u672A\u8FDE\u63A5\u7CFB\u7EDF\u63D0\u9192\u4E8B\u9879\uFF09" };
    return createElement(
      "div",
      { className: "flex flex-col gap-3 p-4" },
      createElement(
        "div",
        { className: "flex items-center gap-2 rounded-md bg-gray-50 px-3 py-2" },
        createElement("span", { className: `h-2 w-2 shrink-0 rounded-full ${banner.dot}` }),
        createElement("span", { className: "flex-1 text-xs text-gray-600" }, banner.text),
        connected ? null : createElement(
          "button",
          {
            type: "button",
            className: "shrink-0 rounded-md border border-gray-300 px-2 py-1 text-xs text-gray-600 disabled:cursor-not-allowed disabled:opacity-50",
            disabled: retrying || sync.status === "connecting",
            onClick: () => {
              void retry();
            }
          },
          retrying ? "\u8FDE\u63A5\u4E2D\u2026" : "\u91CD\u8BD5"
        )
      ),
      connected ? createElement(
        "p",
        { className: "text-xs text-gray-400" },
        "\u5907\u5FD8\u4F1A\u81EA\u52A8\u53CC\u5411\u540C\u6B65\uFF1A\u8FD9\u91CC\u65B0\u5EFA\u3001\u5B8C\u6210\uFF0C\u6216\u76F4\u63A5\u5728\u7CFB\u7EDF\u63D0\u9192\u4E8B\u9879\u91CC\u52FE\u9009\uFF0C\u4E24\u8FB9\u4FDD\u6301\u4E00\u81F4\u3002"
      ) : createElement(
        "p",
        { className: "text-xs text-gray-400" },
        "\u5907\u5FD8\u4ECD\u5728\u672C\u673A\u8BB0\u5F55\u548C\u4F7F\u7528\u3002\u82E5\u672A\u5F39\u51FA\u300C\u81EA\u52A8\u5316\u300D\u6388\u6743\uFF0C\u8BF7\u5728 \u7CFB\u7EDF\u8BBE\u7F6E \u2192 \u9690\u79C1\u4E0E\u5B89\u5168\u6027 \u2192 \u81EA\u52A8\u5316 \u4E2D\u5141\u8BB8 LawyerCopilot \u63A7\u5236\u63D0\u9192\u4E8B\u9879\uFF0C\u7136\u540E\u70B9\u300C\u91CD\u8BD5\u300D\u3002"
      ),
      error ? createElement("div", { className: "rounded-md bg-red-50 px-3 py-2 text-sm text-red-600" }, `\u64CD\u4F5C\u5931\u8D25\uFF1A${error}`) : null,
      createElement(
        "div",
        { className: "flex gap-2" },
        createElement("input", {
          className: "flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500 disabled:opacity-50",
          placeholder: "\u8F93\u5165\u5907\u5FD8\u5185\u5BB9\uFF0C\u56DE\u8F66\u6216\u70B9\u51FB\u300C\u6DFB\u52A0\u300D",
          value: draft,
          disabled: busy,
          onChange: (event) => setDraft(event.target.value),
          onKeyDown: (event) => {
            if (event.key === "Enter") add();
          }
        }),
        createElement(
          "button",
          {
            type: "button",
            className: "rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50",
            disabled: busy || !draft.trim(),
            onClick: () => add()
          },
          "\u6DFB\u52A0"
        )
      ),
      items.length === 0 ? createElement(
        "p",
        { className: "py-10 text-center text-sm text-gray-400" },
        "\u6682\u65E0\u5907\u5FD8\u3002\u5728\u4E0A\u65B9\u8F93\u5165\u5185\u5BB9\uFF0C\u6216\u5728\u5BF9\u8BDD\u91CC\u8BA9 AI \u5E2E\u4F60\u8BB0\u5F55\u3002"
      ) : createElement(
        "ul",
        { className: "flex flex-col divide-y divide-gray-100" },
        ordered.map(
          (item) => createElement(
            "li",
            { key: item.id, className: "flex items-start gap-3 py-2" },
            createElement("input", {
              type: "checkbox",
              className: "mt-1 h-4 w-4 accent-blue-600",
              checked: item.done,
              disabled: busy,
              onChange: () => {
                void run(async () => {
                  await api.toggle(item.id);
                  api.scheduleSync();
                });
              }
            }),
            createElement(
              "span",
              { className: item.done ? "flex-1 text-sm text-gray-400 line-through" : "flex-1 text-sm text-gray-800" },
              item.text
            ),
            createElement("span", { className: "shrink-0 text-xs text-gray-400" }, `#${item.id}`)
          )
        )
      ),
      items.length === 0 ? null : createElement(
        "p",
        { className: "text-xs text-gray-400" },
        `\u5171 ${items.length} \u6761 \xB7 \u672A\u5B8C\u6210 ${open.length} \u6761 \xB7 \u5DF2\u5B8C\u6210 ${done.length} \u6761`
      )
    );
  };
}
export {
  activate as default
};
