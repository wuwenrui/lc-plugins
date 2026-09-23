// src/logic.ts
var MAX_MEMOS = 1e4;
var MAX_TEXT_LENGTH = 2e3;
var MAX_NOTES_LENGTH = 2e3;
var MAX_LIST_NAME_LENGTH = 100;
var PRIORITY_LABELS = {
  none: "\u65E0",
  low: "\u4F4E",
  medium: "\u4E2D",
  high: "\u9AD8"
};
var MemoError = class extends Error {
  kind;
  constructor(message2, kind = "args") {
    super(message2);
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
function isPriorityKey(value) {
  return value === "none" || value === "low" || value === "medium" || value === "high";
}
var ITEM_FIELDS = ["id", "text", "done", "createdAt", "doneAt", "dueDate", "priority", "notes", "list"];
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
    if (entry.dueDate !== void 0 && !isIsoString(entry.dueDate)) {
      throw new MemoError(`\u5907\u5FD8 #${entry.id} \u7684 dueDate \u4E0D\u662F\u6709\u6548\u65F6\u95F4`, "store");
    }
    if (entry.priority !== void 0 && !isPriorityKey(entry.priority)) {
      throw new MemoError(`\u5907\u5FD8 #${entry.id} \u7684 priority \u4E0D\u5408\u6CD5`, "store");
    }
    if (entry.notes !== void 0 && (typeof entry.notes !== "string" || entry.notes.length > MAX_NOTES_LENGTH)) {
      throw new MemoError(`\u5907\u5FD8 #${entry.id} \u7684 notes \u4E0D\u5408\u6CD5\u6216\u8D85\u8FC7 ${MAX_NOTES_LENGTH} \u5B57`, "store");
    }
    if (entry.list !== void 0 && (typeof entry.list !== "string" || !entry.list.trim() || entry.list.length > MAX_LIST_NAME_LENGTH)) {
      throw new MemoError(`\u5907\u5FD8 #${entry.id} \u7684 list \u4E0D\u5408\u6CD5`, "store");
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
function normalizePriority(value) {
  if (value === void 0 || value === null || value === "") return "none";
  if (value === "\u65E0" || value === "none") return "none";
  if (value === "\u4F4E" || value === "low") return "low";
  if (value === "\u4E2D" || value === "medium") return "medium";
  if (value === "\u9AD8" || value === "high") return "high";
  throw new MemoError("priority \u53EA\u652F\u6301 \u65E0\u3001\u4F4E\u3001\u4E2D\u3001\u9AD8");
}
function normalizeDueDate(value) {
  if (value === void 0) return void 0;
  if (value === null || value === "") return null;
  if (typeof value !== "string") throw new MemoError("dueDate \u5FC5\u987B\u662F\u65F6\u95F4\u5B57\u7B26\u4E32\uFF08\u5982 2026-03-05T09:00:00\uFF09");
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new MemoError("dueDate \u4E0D\u662F\u6709\u6548\u7684\u65F6\u95F4\uFF08\u5982 2026-03-05T09:00:00\uFF09");
  return parsed.toISOString();
}
function normalizeNotes(value) {
  if (value === void 0 || value === null) return "";
  if (typeof value !== "string") throw new MemoError("notes \u5FC5\u987B\u662F\u5B57\u7B26\u4E32");
  const notes = value.trim();
  if (notes.length > MAX_NOTES_LENGTH) throw new MemoError(`\u5907\u6CE8\u4E0D\u80FD\u8D85\u8FC7 ${MAX_NOTES_LENGTH} \u5B57`);
  return notes;
}
function normalizeListField(value) {
  if (value === void 0 || value === null || value === "") return void 0;
  if (typeof value !== "string") throw new MemoError("list \u5FC5\u987B\u662F\u5B57\u7B26\u4E32");
  const name = value.trim();
  if (!name) return void 0;
  if (name.length > MAX_LIST_NAME_LENGTH) throw new MemoError(`\u5217\u8868\u540D\u4E0D\u80FD\u8D85\u8FC7 ${MAX_LIST_NAME_LENGTH} \u5B57`);
  return name;
}
function normalizeId(value) {
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) value = Number(value.trim());
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  throw new MemoError("id \u5FC5\u987B\u662F\u6B63\u6574\u6570\uFF08memos_list \u8FD4\u56DE\u7684\u7F16\u53F7\uFF09");
}
function findItem(state, rawId) {
  const id2 = normalizeId(rawId);
  const existing = state.items.find((item) => item.id === id2);
  if (!existing) throw new MemoError(`\u5907\u5FD8 #${id2} \u4E0D\u5B58\u5728\uFF0C\u53EF\u7528 memos_list \u67E5\u770B\u5F53\u524D\u7F16\u53F7`);
  return existing;
}
function listItems(state, status = "open", list) {
  const filtered = state.items.filter((item) => {
    if (status === "all") return true;
    if (status === "done") return item.done;
    return !item.done;
  });
  const scoped = list === void 0 ? filtered : filtered.filter((item) => (item.list ?? "") === list);
  return [...scoped].sort((a, b) => b.id - a.id).map(cloneItem);
}
function createItem(state, input, now = /* @__PURE__ */ new Date()) {
  const text = normalizeText(input?.text);
  if (state.items.length >= MAX_MEMOS) throw new MemoError(`\u5907\u5FD8\u6700\u591A ${MAX_MEMOS} \u6761`);
  const item = { id: state.nextId, text, done: false, createdAt: now.toISOString() };
  const due = normalizeDueDate(input?.dueDate);
  if (due) item.dueDate = due;
  const priority = normalizePriority(input?.priority);
  if (priority !== "none") item.priority = priority;
  const notes = normalizeNotes(input?.notes);
  if (notes) item.notes = notes;
  const list = normalizeListField(input?.list);
  if (list) item.list = list;
  const next = { nextId: state.nextId + 1, items: [...state.items, item] };
  return { state: next, item: cloneItem(item) };
}
function completeItem(state, id2, now = /* @__PURE__ */ new Date()) {
  const existing = findItem(state, id2);
  if (existing.done) return { state, item: cloneItem(existing), alreadyDone: true };
  const item = { ...cloneItem(existing), done: true, doneAt: now.toISOString() };
  const items = state.items.map((entry) => entry.id === item.id ? item : entry);
  return { state: { nextId: state.nextId, items }, item: cloneItem(item), alreadyDone: false };
}
function reopenItem(state, id2) {
  const existing = findItem(state, id2);
  if (!existing.done) return { state, item: cloneItem(existing) };
  const item = { id: existing.id, text: existing.text, done: false, createdAt: existing.createdAt };
  const items = state.items.map((entry) => entry.id === item.id ? item : entry);
  return { state: { nextId: state.nextId, items }, item: cloneItem(item) };
}
function toggleItem(state, id2) {
  const existing = findItem(state, id2);
  if (!existing.done) {
    const outcome2 = completeItem(state, id2);
    return { state: outcome2.state, item: outcome2.item, reopened: false };
  }
  const outcome = reopenItem(state, id2);
  return { state: outcome.state, item: outcome.item, reopened: true };
}
function updateItem(state, id2, patch) {
  const existing = findItem(state, id2);
  const next = cloneItem(existing);
  const changed = [];
  if (patch.text !== void 0) {
    next.text = normalizeText(patch.text);
    changed.push("\u6807\u9898");
  }
  if (patch.notes !== void 0) {
    const notes = normalizeNotes(patch.notes);
    if (notes) next.notes = notes;
    else delete next.notes;
    changed.push("\u5907\u6CE8");
  }
  if (patch.dueDate !== void 0) {
    const due = normalizeDueDate(patch.dueDate);
    if (due === null) delete next.dueDate;
    else if (due !== void 0) next.dueDate = due;
    changed.push("\u5230\u671F\u65F6\u95F4");
  }
  if (patch.priority !== void 0) {
    const priority = normalizePriority(patch.priority);
    if (priority === "none") delete next.priority;
    else next.priority = priority;
    changed.push("\u4F18\u5148\u7EA7");
  }
  if (changed.length === 0) throw new MemoError("\u81F3\u5C11\u63D0\u4F9B text\u3001notes\u3001dueDate\u3001priority \u4E2D\u7684\u4E00\u4E2A\u4FEE\u6539\u5B57\u6BB5");
  const items = state.items.map((entry) => entry.id === next.id ? next : entry);
  return { state: { nextId: state.nextId, items }, item: cloneItem(next), changed };
}
function deleteItem(state, id2) {
  const existing = findItem(state, id2);
  const items = state.items.filter((entry) => entry.id !== existing.id);
  return { state: { nextId: state.nextId, items }, item: cloneItem(existing) };
}
function pad2(value) {
  return value < 10 ? `0${value}` : String(value);
}
function dueLabel(dueDate, now = /* @__PURE__ */ new Date()) {
  if (!dueDate) return null;
  const due = new Date(dueDate);
  const time = due.getTime();
  if (!Number.isFinite(time)) return null;
  const hhmm = `${pad2(due.getHours())}:${pad2(due.getMinutes())}`;
  const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round((dayStart(due) - dayStart(now)) / 864e5);
  if (time < now.getTime()) return { text: "\u5DF2\u8FC7\u671F", tone: "overdue" };
  if (diffDays === 0) return { text: `\u4ECA\u5929 ${hhmm}`, tone: "today" };
  if (diffDays === 1) return { text: "\u660E\u5929", tone: "tomorrow" };
  return { text: `${due.getMonth() + 1}\u6708${due.getDate()}\u65E5${hhmm === "00:00" ? "" : ` ${hhmm}`}`, tone: "later" };
}
function formatDueLocal(dueDate) {
  const d = new Date(dueDate);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
function sortForPanel(items) {
  const dueTime = (item) => {
    if (!item.dueDate) return null;
    const time = Date.parse(item.dueDate);
    return Number.isFinite(time) ? time : null;
  };
  const open = items.filter((item) => !item.done).sort((a, b) => {
    const da = dueTime(a);
    const db = dueTime(b);
    if (da !== null && db !== null) return da - db;
    if (da !== null) return -1;
    if (db !== null) return 1;
    return b.id - a.id;
  });
  const done = items.filter((item) => item.done).sort((a, b) => b.id - a.id);
  return { open, done };
}
function describeMemo(item, now = /* @__PURE__ */ new Date()) {
  const meta = [];
  if (item.dueDate) {
    const label = dueLabel(item.dueDate, now);
    meta.push(`\u622A\u6B62 ${formatDueLocal(item.dueDate)}${label?.tone === "overdue" ? "\uFF08\u5DF2\u8FC7\u671F\uFF09" : ""}`);
  }
  if (item.priority && item.priority !== "none") meta.push(`\u4F18\u5148\u7EA7 ${PRIORITY_LABELS[item.priority]}`);
  if (item.list) meta.push(`\u5217\u8868\u300C${item.list}\u300D`);
  const notes = item.notes ? `\uFF1B\u5907\u6CE8\uFF1A${item.notes.replace(/\r?\n/g, " / ")}` : "";
  return `${item.text}${meta.length ? `\uFF08${meta.join("\uFF0C")}\uFF09` : ""}${notes}`;
}
function renderItem(item, now) {
  const stamp = item.doneAt ? `\uFF08\u5B8C\u6210\u4E8E ${item.doneAt.slice(0, 10)}\uFF09` : "";
  return `- ${item.done ? "[x]" : "[ ]"} #${item.id} ${describeMemo(item, now)}${stamp}`;
}
function renderList(status, items, now = /* @__PURE__ */ new Date()) {
  if (status === "all") {
    if (!items.length) return "\u5F53\u524D\u6CA1\u6709\u4EFB\u4F55\u5907\u5FD8\u3002";
    const open = items.filter((item) => !item.done).length;
    const done = items.length - open;
    return [`\u5171 ${items.length} \u6761\u5907\u5FD8\uFF08\u672A\u5B8C\u6210 ${open} \u6761\uFF0C\u5DF2\u5B8C\u6210 ${done} \u6761\uFF09\uFF1A`, ...items.map((item) => renderItem(item, now))].join("\n");
  }
  const label = status === "open" ? "\u672A\u5B8C\u6210" : "\u5DF2\u5B8C\u6210";
  if (!items.length) return `\u5F53\u524D\u6CA1\u6709${label}\u7684\u5907\u5FD8\u3002`;
  return [`\u5171 ${items.length} \u6761${label}\u5907\u5FD8\uFF1A`, ...items.map((item) => renderItem(item, now))].join("\n");
}

// src/apple.ts
var APPLE_LIST_NAME = "\u5F8B\u5E08\u5907\u5FD8\u5F55";
var MEMO_TAG_PREFIX = "#lc-";
var OSA_TIMEOUT_MS = 2e4;
var RECONCILE_SOFT_TIMEOUT_MS = 9e3;
var RECONCILE_MIN_INTERVAL_MS = 15e3;
var MAX_TOMBSTONES = 5e3;
var AppleSyncError = class extends Error {
  constructor(message2) {
    super(message2);
    this.name = "AppleSyncError";
  }
};
function lit(value) {
  return JSON.stringify(value);
}
function tagFor(memoId) {
  return `${MEMO_TAG_PREFIX}${memoId}`;
}
function reminderBodyFor(memoId, notes) {
  const marker = `\u2014 LawyerCopilot ${tagFor(memoId)}`;
  return notes ? `${notes}
${marker}` : marker;
}
function applePriorityFor(priority) {
  if (priority === "high") return 1;
  if (priority === "medium") return 5;
  if (priority === "low") return 9;
  return 0;
}
function buildEnsureListScript(listName = APPLE_LIST_NAME) {
  return `const app = Application("Reminders");
const LIST = ${lit(listName)};
let found = app.lists.whose({name: LIST});
if (found.length === 0) { app.lists.push(app.List({name: LIST})); found = app.lists.whose({name: LIST}); }
JSON.stringify({ok: found.length > 0})`;
}
function buildListListsScript() {
  return `const app = Application("Reminders");
JSON.stringify({ok: true, names: app.lists().map(function (l) { return l.name() })})`;
}
function buildReadListsScript(listNames) {
  const names = listNames.length > 0 ? [...listNames] : [APPLE_LIST_NAME];
  return `const app = Application("Reminders");
const WANT = ${JSON.stringify(names)};
const out = [];
for (const name of WANT) {
  const found = app.lists.whose({name: name});
  if (found.length === 0) { continue }
  const list = found[0];
  for (const r of list.reminders()) {
    let due = null;
    try { const d = r.dueDate(); if (d !== null && d !== undefined && typeof d === "object") { due = d.toISOString() } } catch (e) { due = null }
    out.push({list: name, name: r.name(), body: String(r.body() || ""), completed: r.completed(), id: r.id(), dueDate: due, priority: r.priority()});
  }
}
JSON.stringify({ok: true, items: out})`;
}
function buildFindByIdScript(reminderId) {
  return `const app = Application("Reminders");
let result;
try {
  const rs = app.reminders.whose({id: ${lit(reminderId)}});
  if (rs.length === 0) { result = {ok: true, found: false, list: null, name: null, completed: null} }
  else { const r = rs[0]; result = {ok: true, found: true, list: String(r.container().name()), name: r.name(), completed: r.completed()} }
} catch (e) { result = {ok: false, error: "lookup-failed: " + String(e)} }
JSON.stringify(result)`;
}
function buildCreateReminderScript(name, memoId, options = {}) {
  const listName = options.listName ?? APPLE_LIST_NAME;
  const body = reminderBodyFor(memoId, options.notes);
  const dueLine = options.dueDate ? `  PROP.dueDate = new Date(${lit(options.dueDate)});
` : "";
  const priorityLine = `  PROP.priority = ${applePriorityFor(options.priority)};
`;
  return `const app = Application("Reminders");
const found = app.lists.whose({name: ${lit(listName)}});
if (found.length === 0) { JSON.stringify({ok: false, error: "list-missing"}) }
else {
  const list = found[0];
  const NAME = ${lit(name)};
  const TAG = ${lit(tagFor(memoId))};
  const BODY = ${lit(body)};
  const PROP = {name: NAME, body: BODY};
` + dueLine + priorityLine + `  list.reminders.push(app.Reminder(PROP));
  const all = list.reminders();
  let hit = null;
  for (const x of all) { if (x.name() === NAME && x.body() != null && String(x.body()).indexOf(TAG) >= 0) { hit = x; break } }
  if (!hit) { for (const x of all) { if (x.name() === NAME) { hit = x; break } } }
  JSON.stringify({ok: !!hit, id: hit ? hit.id() : null, name: hit ? hit.name() : null});
}`;
}
function buildUpdateReminderScript(reminderId, changes, listName = APPLE_LIST_NAME) {
  const parts = [];
  if (changes.name !== void 0) parts.push(`    r.name = ${lit(changes.name)};
`);
  if (changes.body !== void 0) parts.push(`    r.body = ${lit(changes.body)};
`);
  if (changes.dueDate !== void 0) parts.push(`    r.dueDate = new Date(${lit(changes.dueDate)});
`);
  if (changes.priority !== void 0) parts.push(`    r.priority = ${changes.priority};
`);
  return `const app = Application("Reminders");
const found = app.lists.whose({name: ${lit(listName)}});
if (found.length === 0) { JSON.stringify({ok: false, error: "list-missing"}) }
else {
  const rs = found[0].reminders.whose({id: ${lit(reminderId)}});
  if (rs.length === 0) { JSON.stringify({ok: false, error: "not-found"}) }
  else {
    const r = rs[0];
` + parts.join("") + `    JSON.stringify({ok: true});
  }
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
function buildDeleteReminderScript(reminderId, listName = APPLE_LIST_NAME) {
  return `const app = Application("Reminders");
const found = app.lists.whose({name: ${lit(listName)}});
if (found.length === 0) { JSON.stringify({ok: false, error: "list-missing"}) }
else {
  const rs = found[0].reminders.whose({id: ${lit(reminderId)}});
  if (rs.length === 0) { JSON.stringify({ok: false, error: "not-found"}) }
  else { rs[0].delete(); JSON.stringify({ok: true}) }
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
  const record2 = raw;
  const name = typeof record2.name === "string" ? record2.name : "";
  const id2 = typeof record2.id === "string" ? record2.id : "";
  if (!name || !id2) return null;
  return {
    name,
    id: id2,
    body: typeof record2.body === "string" ? record2.body : "",
    completed: record2.completed === true,
    list: typeof record2.list === "string" ? record2.list : "",
    dueDate: typeof record2.dueDate === "string" ? record2.dueDate : null,
    priority: typeof record2.priority === "number" ? record2.priority : 0
  };
}
function parseReminderList(result) {
  if (typeof result !== "object" || result === null) throw new AppleSyncError("readAllReminders \u7ED3\u679C\u4E0D\u662F\u5BF9\u8C61");
  const record2 = result;
  if (record2.ok !== true) throw new AppleSyncError(`readAllReminders \u5931\u8D25\uFF1A${String(record2.error ?? "unknown")}`);
  if (!Array.isArray(record2.items)) throw new AppleSyncError("readAllReminders \u7ED3\u679C\u7F3A\u5C11 items");
  const views = [];
  for (const entry of record2.items) {
    const view = toView(entry);
    if (view) views.push(view);
  }
  return views;
}
function parseListNames(result) {
  if (typeof result !== "object" || result === null) throw new AppleSyncError("listLists \u7ED3\u679C\u4E0D\u662F\u5BF9\u8C61");
  const record2 = result;
  if (record2.ok !== true) throw new AppleSyncError(`listLists \u5931\u8D25\uFF1A${String(record2.error ?? "unknown")}`);
  if (!Array.isArray(record2.names)) throw new AppleSyncError("listLists \u7ED3\u679C\u7F3A\u5C11 names");
  const names = [];
  for (const entry of record2.names) {
    if (typeof entry === "string" && entry) names.push(entry);
  }
  return names;
}
function parseFoundReminder(result) {
  if (typeof result !== "object" || result === null) throw new AppleSyncError("findReminder \u7ED3\u679C\u4E0D\u662F\u5BF9\u8C61");
  const record2 = result;
  if (record2.ok !== true) throw new AppleSyncError(`findReminder \u5931\u8D25\uFF1A${String(record2.error ?? "unknown")}`);
  if (typeof record2.found !== "boolean") throw new AppleSyncError("findReminder \u7ED3\u679C\u7F3A\u5C11 found");
  if (record2.found && (typeof record2.list !== "string" || !record2.list || typeof record2.name !== "string" || typeof record2.completed !== "boolean")) {
    throw new AppleSyncError("findReminder \u627E\u5230\u7684\u63D0\u9192\u5B57\u6BB5\u4E0D\u5B8C\u6574");
  }
  return {
    found: record2.found,
    list: typeof record2.list === "string" ? record2.list : "",
    name: typeof record2.name === "string" ? record2.name : "",
    completed: record2.completed === true
  };
}
function parseCreatedId(result) {
  if (typeof result !== "object" || result === null) throw new AppleSyncError("createReminder \u7ED3\u679C\u4E0D\u662F\u5BF9\u8C61");
  const record2 = result;
  if (record2.ok !== true || typeof record2.id !== "string" || !record2.id) {
    throw new AppleSyncError(`createReminder \u5931\u8D25\uFF1A${String(record2.error ?? record2.id ?? "unknown")}`);
  }
  return record2.id;
}
function parseUpdatedOk(result) {
  if (typeof result !== "object" || result === null) throw new AppleSyncError("updateReminder \u7ED3\u679C\u4E0D\u662F\u5BF9\u8C61");
  const record2 = result;
  if (record2.ok !== true) throw new AppleSyncError(`updateReminder \u5931\u8D25\uFF1A${String(record2.error ?? "unknown")}`);
}
function parseDeleteResult(result) {
  if (typeof result !== "object" || result === null) throw new AppleSyncError("deleteReminder \u7ED3\u679C\u4E0D\u662F\u5BF9\u8C61");
  const record2 = result;
  if (record2.ok === true) return true;
  if (record2.error === "not-found") return false;
  throw new AppleSyncError(`deleteReminder \u5931\u8D25\uFF1A${String(record2.error ?? "unknown")}`);
}
function validateAppleMap(value) {
  if (value === void 0 || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new AppleSyncError("apple-map \u4E0D\u662F\u5BF9\u8C61");
  const map = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!/^\d+$/.test(key)) throw new AppleSyncError(`apple-map \u952E\u4E0D\u662F memo id\uFF1A${key}`);
    if (typeof entry !== "object" || entry === null) throw new AppleSyncError(`apple-map \u6761\u76EE\u4E0D\u662F\u5BF9\u8C61\uFF1A${key}`);
    const record2 = entry;
    if (typeof record2.id !== "string" || !record2.id) throw new AppleSyncError(`apple-map \u6761\u76EE\u7F3A\u5C11 id\uFF1A${key}`);
    if (typeof record2.name !== "string") throw new AppleSyncError(`apple-map \u6761\u76EE name \u4E0D\u662F\u5B57\u7B26\u4E32\uFF1A${key}`);
    if (typeof record2.lastCompleted !== "boolean") {
      throw new AppleSyncError(`apple-map \u6761\u76EE lastCompleted \u4E0D\u662F\u5E03\u5C14\u503C\uFF1A${key}`);
    }
    if (record2.list !== void 0 && (typeof record2.list !== "string" || !record2.list)) {
      throw new AppleSyncError(`apple-map \u6761\u76EE list \u4E0D\u5408\u6CD5\uFF1A${key}`);
    }
    map[key] = record2.list === void 0 ? { id: record2.id, name: record2.name, lastCompleted: record2.lastCompleted } : { id: record2.id, name: record2.name, lastCompleted: record2.lastCompleted, list: record2.list };
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
function parseTombstones(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  const ids = value.ids;
  if (!Array.isArray(ids)) return [];
  const out = /* @__PURE__ */ new Set();
  for (const id2 of ids) {
    if (typeof id2 === "number" && Number.isSafeInteger(id2) && id2 > 0) out.add(id2);
  }
  return [...out].sort((a, b) => a - b);
}
function mergeTombstones(existing, added) {
  const set = /* @__PURE__ */ new Set([...existing, ...added]);
  const sorted = [...set].sort((a, b) => a - b);
  return sorted.length > MAX_TOMBSTONES ? sorted.slice(sorted.length - MAX_TOMBSTONES) : sorted;
}
function extractMemoTag(body) {
  const match = body.match(/#lc-(\d+)/);
  if (!match) return null;
  const id2 = Number(match[1]);
  return Number.isSafeInteger(id2) && id2 > 0 ? id2 : null;
}
function resolveMissingLookup(lookup, found) {
  if (found !== null && found.list) {
    return {
      kind: "follow",
      mapUpdate: { id: lookup.reminderId, name: lookup.name, lastCompleted: found.completed, list: found.list }
    };
  }
  return { kind: "deleted", memoId: lookup.memoId };
}
function entryFor(memo, entry, views) {
  const byId = /* @__PURE__ */ new Map();
  for (const view of views) byId.set(view.id, view);
  if (entry) {
    const hit = byId.get(entry.id);
    if (hit) return hit;
    for (const view of views) {
      if (extractMemoTag(view.body) === memo.id) return view;
    }
    for (const view of views) {
      if (view.name === entry.name && view.name === memo.text) return view;
    }
    return null;
  }
  for (const view of views) {
    if (extractMemoTag(view.body) === memo.id) return view;
  }
  for (const view of views) {
    if (view.name === memo.text && extractMemoTag(view.body) === null) return view;
  }
  return null;
}
function planSync(localItems, map, apple, tombstones = [], defaultList = APPLE_LIST_NAME) {
  const plan = {
    localPatches: [],
    localDeletes: [],
    appleCreates: [],
    applePatches: [],
    appleDeletes: [],
    lookups: [],
    mapUpdates: {},
    mapDrops: [],
    tombstones: []
  };
  const tombSet = new Set(tombstones);
  for (const view of apple) {
    const tag = extractMemoTag(view.body);
    if (tag !== null && tombSet.has(tag)) {
      plan.appleDeletes.push({ reminderId: view.id, memoId: tag, list: view.list });
    }
  }
  const seenMemoIds = /* @__PURE__ */ new Set();
  for (const memo of localItems) {
    if (tombSet.has(memo.id)) continue;
    seenMemoIds.add(memo.id);
    const key = String(memo.id);
    const entry = map[key];
    const homeList = entry?.list ?? memo.list ?? defaultList;
    const view = entryFor(memo, entry, apple);
    if (!view) {
      if (entry) {
        plan.lookups.push({ memoId: memo.id, reminderId: entry.id, name: entry.name });
        continue;
      }
      plan.appleCreates.push({
        memoId: memo.id,
        name: memo.text,
        list: homeList,
        dueDate: memo.dueDate,
        priority: memo.priority,
        notes: memo.notes,
        completeAfter: memo.done
      });
      continue;
    }
    const listChanged = entry !== void 0 && entry.list !== view.list;
    if (!entry) {
      plan.mapUpdates[key] = { id: view.id, name: view.name, lastCompleted: view.completed, list: view.list };
      if (view.completed !== memo.done) {
        plan.localPatches.push({ memoId: memo.id, done: view.completed });
      }
      continue;
    }
    if (view.completed === memo.done) {
      if (entry.lastCompleted !== view.completed || listChanged) {
        plan.mapUpdates[key] = { id: view.id, name: view.name, lastCompleted: view.completed, list: view.list };
      }
      continue;
    }
    const appleChanged = entry.lastCompleted !== view.completed;
    const localChanged = entry.lastCompleted !== memo.done;
    const localWins = localChanged || !appleChanged && !localChanged;
    if (localWins) {
      plan.applePatches.push({ reminderId: view.id, memoId: memo.id, completed: memo.done, list: view.list });
      plan.mapUpdates[key] = { id: view.id, name: view.name, lastCompleted: memo.done, list: view.list };
    } else {
      plan.localPatches.push({ memoId: memo.id, done: view.completed });
      plan.mapUpdates[key] = { id: view.id, name: view.name, lastCompleted: view.completed, list: view.list };
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

// src/panel.ts
var STATUS_REFRESH_MS = 4e3;
var ICONS = {
  refresh: ["M3 12a9 9 0 0 1 15-6.7L21 8", "M21 3v5h-5", "M21 12a9 9 0 0 1-15 6.7L3 16", "M3 21v-5h5"],
  check: ["M20 6 9 17l-5-5"],
  chevron: ["m6 9 6 6 6-6"],
  plus: ["M12 5v14", "M5 12h14"],
  trash: ["M3 6h18", "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6", "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2", "M10 11v6", "M14 11v6"],
  note: ["M9 2h6a1 1 0 0 1 1 1v2H8V3a1 1 0 0 1 1-1Z", "M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2", "M9 12h6", "M9 16h4"]
};
function icon(el, name, opts = {}) {
  const size = opts.size ?? 16;
  return el(
    "svg",
    {
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 2,
      strokeLinecap: "round",
      strokeLinejoin: "round",
      width: size,
      height: size,
      ...opts.className === void 0 ? {} : { className: opts.className },
      ...opts.style === void 0 ? {} : { style: opts.style },
      "aria-hidden": true
    },
    ...ICONS[name].map((d) => el("path", { d }))
  );
}
function dueToneClass(tone) {
  if (tone === "overdue") return "text-text-error-primary";
  if (tone === "today") return "text-status-blue-text";
  return "text-text-tertiary";
}
function priorityBadge(el, priority) {
  if (!priority || priority === "none") return null;
  const label = PRIORITY_LABELS[priority];
  const className = priority === "high" ? "shrink-0 rounded-full bg-badge-neutral-background text-caption-2-medium text-red-600" : priority === "medium" ? "shrink-0 rounded-full bg-badge-neutral-background text-caption-2-medium" : "shrink-0 rounded-full bg-badge-neutral-background text-caption-2-medium text-text-tertiary";
  return el(
    "span",
    {
      className,
      style: priority === "medium" ? { padding: "1px 7px", color: "#d97706" } : { padding: "1px 7px" }
    },
    label
  );
}
function renderMemoRow(el, item, busy, onToggle, onRemove) {
  const due = dueLabel(item.dueDate);
  return el(
    "div",
    { key: item.id, className: "flex items-start gap-2.5 px-2 py-2 transition-colors hover:bg-background-secondary-hover rounded-xl" },
    el(
      "button",
      {
        type: "button",
        title: item.done ? "\u91CD\u65B0\u6253\u5F00\u8FD9\u6761\u5907\u5FD8" : "\u6807\u8BB0\u5B8C\u6210\uFF08\u540C\u6B65\u5230\u7CFB\u7EDF\u63D0\u9192\u4E8B\u9879\uFF09",
        className: `mt-1 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${item.done ? "border-transparent bg-blue-600 text-white" : "border-border-button-default text-transparent"}`,
        disabled: busy,
        onClick: () => onToggle(item)
      },
      icon(el, "check", { size: 10 })
    ),
    el(
      "div",
      { className: "flex min-w-0 flex-1 flex-col gap-1" },
      el(
        "div",
        { className: "flex items-center gap-1.5" },
        el(
          "span",
          {
            className: item.done ? "min-w-0 flex-1 truncate text-body-2-regular text-text-tertiary" : "min-w-0 flex-1 truncate text-body-2-regular text-text-primary",
            style: item.done ? { textDecoration: "line-through" } : void 0
          },
          item.text
        ),
        due === null ? null : el("span", { className: `shrink-0 text-caption-2-medium ${dueToneClass(due.tone)}` }, due.text),
        priorityBadge(el, item.priority)
      ),
      item.notes ? el("span", { className: "truncate text-caption-2-medium text-text-tertiary" }, item.notes) : null
    ),
    el(
      "button",
      {
        type: "button",
        title: "\u5220\u9664\u8FD9\u6761\u5907\u5FD8\uFF08\u7CFB\u7EDF\u63D0\u9192\u4E8B\u9879\u91CC\u7684\u4E00\u5E76\u5220\u9664\uFF09",
        className: "shrink-0 flex items-center justify-center rounded-full text-foreground-icon-tertiary transition-colors hover:bg-button-ghost-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50",
        style: { width: "28px", height: "28px" },
        disabled: busy,
        onClick: () => onRemove(item)
      },
      icon(el, "trash", { size: 14 })
    )
  );
}
function createMemosPanelTab(ctx, api) {
  const { createElement: el, useState, useEffect } = ctx.react;
  return function MemosPanelTab() {
    const [items, setItems] = useState([]);
    const [draft, setDraft] = useState("");
    const [dueDraft, setDueDraft] = useState("");
    const [priorityDraft, setPriorityDraft] = useState("\u65E0");
    const [busy, setBusy] = useState(false);
    const [refreshing, setRefreshing] = useState(false);
    const [error, setError] = useState("");
    const [showDone, setShowDone] = useState(false);
    const [sync, setSync] = useState(() => api.syncInfo());
    async function reload() {
      setItems(await api.all());
      setSync(api.syncInfo());
    }
    useEffect(() => {
      void reload().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
      const timer = setInterval(() => setSync(api.syncInfo()), STATUS_REFRESH_MS);
      return () => clearInterval(timer);
    }, []);
    async function run(action) {
      setBusy(true);
      setError("");
      try {
        await action();
        await reload();
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
        await api.createFull({
          text,
          dueDate: dueDraft === "" ? void 0 : dueDraft,
          priority: priorityDraft
        });
        setDraft("");
        setDueDraft("");
        setPriorityDraft("\u65E0");
      });
    }
    async function refresh() {
      setRefreshing(true);
      setError("");
      try {
        await api.syncNow();
        await reload();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setRefreshing(false);
      }
    }
    const { open, done } = sortForPanel(items);
    const statusLine = sync.status === "connecting" ? "\u6B63\u5728\u8FDE\u63A5\u7CFB\u7EDF\u63D0\u9192\u4E8B\u9879\u2026" : sync.status === "connected" ? `\u5DF2\u8FDE\u63A5\u63D0\u9192\u4E8B\u9879 \xB7 \u672A\u5B8C\u6210 ${open.length} \xB7 \u5DF2\u5B8C\u6210 ${done.length}` : `\u4EC5\u672C\u673A\u8BB0\u5F55\uFF08\u672A\u8FDE\u63A5\u63D0\u9192\u4E8B\u9879\uFF09\xB7 \u672A\u5B8C\u6210 ${open.length}`;
    return el(
      "div",
      { className: "flex h-full min-h-0 flex-col" },
      // ———————— 标题行：备忘 + 状态副行 + 刷新圆钮 ————————
      el(
        "div",
        { className: "flex items-center gap-2 px-3 pt-3" },
        el(
          "div",
          { className: "min-w-0" },
          el("div", { className: "text-title-3-semibold text-text-primary" }, "\u5907\u5FD8"),
          el("div", { className: "truncate text-caption-2-medium text-text-tertiary" }, statusLine)
        ),
        el("div", { className: "flex-1" }),
        el("button", {
          title: "\u5237\u65B0\uFF08\u4E0E\u7CFB\u7EDF\u63D0\u9192\u4E8B\u9879\u5BF9\u8D26\u4E00\u6B21\uFF09",
          className: "flex h-9 w-9 items-center justify-center rounded-full text-foreground-icon-secondary transition-colors hover:bg-button-ghost-hover hover:text-foreground-icon-primary disabled:opacity-40",
          disabled: refreshing,
          onClick: () => {
            void refresh();
          }
        }, icon(el, "refresh", { size: 15, style: refreshing ? { animation: "spin 1s linear infinite" } : void 0 }))
      ),
      // ———————— 新建区：输入 + 到期 + 优先级 ————————
      el(
        "div",
        { className: "flex flex-col gap-1.5 px-3 pt-2.5 pb-1" },
        el("input", {
          className: "w-full rounded-lg bg-background-quaternary-default px-3 py-2 text-caption-1-regular text-text-primary outline-none disabled:opacity-50",
          placeholder: "\u8BB0\u70B9\u4EC0\u4E48\u2026",
          value: draft,
          disabled: busy,
          onChange: (event) => setDraft(event.target.value),
          onKeyDown: (event) => {
            if (event.key === "Enter") add();
          }
        }),
        el(
          "div",
          { className: "flex items-center gap-2" },
          el("input", {
            type: "datetime-local",
            title: "\u5230\u671F\u65F6\u95F4\uFF08\u53EF\u4E0D\u586B\uFF09",
            className: "rounded-md border border-separator-border bg-background-full text-caption-2-medium text-text-secondary disabled:opacity-50",
            style: { padding: "5px 8px" },
            value: dueDraft,
            disabled: busy,
            onChange: (event) => setDueDraft(event.target.value)
          }),
          el(
            "select",
            {
              title: "\u4F18\u5148\u7EA7",
              className: "rounded-md border border-separator-border bg-background-full text-caption-2-medium text-text-secondary disabled:opacity-50",
              style: { padding: "5px 8px" },
              value: priorityDraft,
              disabled: busy,
              onChange: (event) => setPriorityDraft(event.target.value)
            },
            el("option", { value: "\u65E0" }, "\u4F18\u5148\u7EA7\uFF1A\u65E0"),
            el("option", { value: "\u4F4E" }, "\u4F18\u5148\u7EA7\uFF1A\u4F4E"),
            el("option", { value: "\u4E2D" }, "\u4F18\u5148\u7EA7\uFF1A\u4E2D"),
            el("option", { value: "\u9AD8" }, "\u4F18\u5148\u7EA7\uFF1A\u9AD8")
          ),
          el("div", { className: "flex-1" }),
          el("button", {
            type: "button",
            className: "flex items-center gap-1.5 rounded-full bg-blue-600 px-3 py-2 text-caption-1-medium text-white shadow-sm transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50",
            disabled: busy || !draft.trim(),
            onClick: add
          }, icon(el, "plus", { size: 13 }), "\u6DFB\u52A0")
        )
      ),
      // ———————— 错误提示 ————————
      error === "" ? null : el("div", {
        className: "mx-3 mt-2 rounded-lg bg-background-tertiary-error px-3 py-2 text-caption-1-regular text-text-error-primary"
      }, error),
      // ———————— 列表 / 空态 ————————
      el(
        "div",
        { className: "min-h-0 flex-1 overflow-y-auto px-2" },
        items.length === 0 ? el(
          "div",
          { className: "flex flex-col items-center px-6 pt-14 text-center" },
          el("div", {
            className: "flex items-center justify-center rounded-full bg-background-quaternary-default text-foreground-icon-tertiary",
            style: { width: "56px", height: "56px" }
          }, icon(el, "note", { size: 26 })),
          el("div", { className: "mt-3 text-body-2-medium text-text-primary" }, "\u8FD8\u6CA1\u6709\u5907\u5FD8\uFF0C\u5728\u4E0A\u9762\u8F93\u5165\u4E00\u6761"),
          el("div", { className: "mt-1 text-caption-1-regular text-text-tertiary" }, "\u5199\u6E05\u8981\u505A\u7684\u4E8B\uFF0C\u9700\u8981\u65F6\u8865\u4E2A\u5230\u671F\u65F6\u95F4")
        ) : el(
          "div",
          { className: "divide-y divide-separator-border" },
          ...open.map((item) => renderMemoRow(
            el,
            item,
            busy,
            (target) => {
              void run(async () => {
                await api.toggle(target.id);
                api.scheduleSync();
              });
            },
            (target) => {
              void run(async () => {
                await api.remove(target.id);
              });
            }
          )),
          done.length > 0 ? el(
            "div",
            null,
            el(
              "button",
              {
                type: "button",
                className: "flex w-full items-center gap-1.5 px-2 py-2 text-caption-1-medium text-text-secondary transition-colors hover:bg-background-secondary-hover rounded-xl",
                onClick: () => setShowDone(!showDone)
              },
              el("span", {
                className: "text-foreground-icon-tertiary transition-transform",
                style: { transform: showDone ? "rotate(180deg)" : void 0 }
              }, icon(el, "chevron", { size: 13 })),
              `\u5DF2\u5B8C\u6210\uFF08${done.length}\uFF09`,
              el("span", { className: "text-caption-2-medium text-text-tertiary" }, showDone ? "\u70B9\u6536\u8D77" : "\u70B9\u5F00\u67E5\u770B\uFF0C\u53EF\u52FE\u56DE\u672A\u5B8C\u6210")
            ),
            showDone ? el(
              "div",
              { className: "divide-y divide-separator-border" },
              ...done.map((item) => renderMemoRow(
                el,
                item,
                busy,
                (target) => {
                  void run(async () => {
                    await api.toggle(target.id);
                    api.scheduleSync();
                  });
                },
                (target) => {
                  void run(async () => {
                    await api.remove(target.id);
                  });
                }
              ))
            ) : null
          ) : null
        )
      )
    );
  };
}

// src/notes-jxa.ts
function noteHtml(title, text) {
  const escape = (value) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return `<div><b>${escape(title.trim())}</b></div><div>${escape(text).replace(/\r\n?/g, "\n").replace(/\n/g, "<br>")}</div>`;
}
function canEditNote(html, locked, attachmentCount) {
  if (locked || attachmentCount > 0) return false;
  const body = html.replace(/^\s*<div>[\s\S]*?<\/div>/i, "");
  return !/<(?!\/?(?:div|p|br)\s*\/?\s*>)[^>]*>/i.test(body);
}
function noteText(title, plain) {
  if (plain.trimEnd() === title) return "";
  return plain.startsWith(title + "\n") ? plain.slice(title.length + 1).replace(/\n$/, "") : plain;
}
function buildNotesScript(command) {
  return `(function () {
    let writeAttempted = false;
    try {
      const input = ${JSON.stringify(command)};
      const noteHtml = ${noteHtml.toString()};
      const canEditNote = ${canEditNote.toString()};
      const noteText = ${noteText.toString()};
      const app = Application("Notes");
      function snapshot(note) {
        const title = String(note.name());
        const locked = note.passwordProtected() === true;
        const html = locked ? "" : String(note.body());
        const plain = locked ? "" : String(note.plaintext());
        const text = noteText(title, plain);
        const attachments = locked ? 0 : note.attachments().length;
        return {id: String(note.id()), title, text, html, locked, shared: note.shared() === true,
          modifiedMs: note.modificationDate().getTime(), editable: canEditNote(html, locked, attachments)};
      }
      if (input.op === "folders") {
        const folders = [];
        function visit(items, account, parent) {
          for (const f of items) {
            const name = parent ? parent + " / " + f.name() : f.name();
            folders.push({id: String(f.id()), name: String(name), account: String(account)});
            visit(f.folders(), account, name);
          }
        }
        for (const a of app.accounts()) visit(a.folders(), a.name(), "");
        return JSON.stringify({ok: true, folders, defaultFolderId: String(app.defaultAccount().defaultFolder().id())});
      }
      const folders = app.folders.whose({id: input.folderId})();
      if (folders.length !== 1) throw new Error("\u6240\u9009\u5907\u5FD8\u5F55\u6587\u4EF6\u5939\u5DF2\u4E0D\u5B58\u5728\uFF0C\u8BF7\u5237\u65B0\u540E\u91CD\u65B0\u9009\u62E9");
      const folder = folders[0];
      if (input.op === "list") {
        if (!Number.isSafeInteger(input.offset) || input.offset < 0) throw new Error("\u5217\u8868\u9875\u7801\u65E0\u6548");
        const allIds = folder.notes.id();
        const pageIds = allIds.slice(input.offset, input.offset + 30);
        if (pageIds.length === 0) return JSON.stringify({ok: true, notes: [], total: allIds.length});
        const matchingIds = ids => ids.length === 1 ? {id: ids[0]} : {_or: ids.map(id => ({id}))};
        const group = folder.notes.whose(matchingIds(pageIds));
        const ids = group.id(), titles = group.name(), dates = group.modificationDate(), locked = group.passwordProtected();
        const readableIds = ids.filter((id, i) => locked[i] !== true);
        let bodyIds = [], bodies = [];
        if (readableIds.length > 0) {
          const readable = folder.notes.whose(matchingIds(readableIds));
          bodyIds = readable.id();
          bodies = readable.plaintext();
          if (JSON.stringify(bodyIds) !== JSON.stringify(readable.id()) || bodyIds.length !== bodies.length) throw new Error("\u5217\u8868\u8BFB\u53D6\u671F\u95F4\u5185\u5BB9\u53D1\u751F\u53D8\u66F4\uFF0C\u8BF7\u5237\u65B0\u91CD\u8BD5");
        }
        if (ids.length !== pageIds.length || titles.length !== ids.length || dates.length !== ids.length || locked.length !== ids.length ||
          JSON.stringify(ids) !== JSON.stringify(group.id())) throw new Error("\u5217\u8868\u8BFB\u53D6\u671F\u95F4\u5185\u5BB9\u53D1\u751F\u53D8\u66F4\uFF0C\u8BF7\u5237\u65B0\u91CD\u8BD5");
        const byId = new Map(bodyIds.map((id, i) => [id, bodies[i]]));
        const notes = ids.map((id, i) => {
          if (!locked[i] && !byId.has(id)) throw new Error("\u5907\u5FD8\u5F55\u6B63\u6587\u672A\u5B8C\u6574\u8FD4\u56DE\uFF0C\u8BF7\u5237\u65B0\u91CD\u8BD5");
          return {id: String(id), title: String(titles[i]), locked: locked[i] === true,
            modifiedMs: dates[i].getTime(), summary: locked[i] ? "\u5DF2\u9501\u5B9A\uFF0C\u8BF7\u5728\u7CFB\u7EDF\u5907\u5FD8\u5F55\u4E2D\u67E5\u770B" : noteText(String(titles[i]), String(byId.get(id))).replace(/\\s+/g, " ").slice(0, 120)};
        });
        return JSON.stringify({ok: true, notes, total: allIds.length});
      }
      if (input.op === "create" || input.op === "update") {
        if (input.confirm !== true) throw new Error("\u8BF7\u786E\u8BA4\u540E\u518D\u4FDD\u5B58\u5230\u7CFB\u7EDF\u5907\u5FD8\u5F55");
        if (typeof input.title !== "string" || !input.title.trim() || input.title.trim().length > 200) throw new Error("\u6807\u9898\u987B\u4E3A 1 \u81F3 200 \u5B57");
        if (typeof input.text !== "string" || input.text.length > 50000) throw new Error("\u6B63\u6587\u6700\u591A 50000 \u5B57");
      }
      if (input.op === "create") {
        const note = app.Note({body: noteHtml(input.title, input.text)});
        writeAttempted = true;
        folder.notes.push(note);
        return JSON.stringify({ok: true, note: snapshot(note)});
      }
      const notes = folder.notes.whose({id: input.id})();
      if (notes.length !== 1) throw new Error("\u8FD9\u6761\u5907\u5FD8\u5F55\u5DF2\u88AB\u79FB\u8D70\u6216\u5220\u9664\uFF0C\u8BF7\u5237\u65B0\u5217\u8868");
      const note = notes[0];
      if (input.op === "show") {
        app.show(note);
        app.activate();
        return JSON.stringify({ok: true});
      }
      if (input.op === "update") {
        const current = snapshot(note);
        if (!current.editable) throw new Error("\u6B64\u6761\u5305\u542B\u9501\u5B9A\u3001\u9644\u4EF6\u6216\u590D\u6742\u6392\u7248\uFF0C\u8BF7\u5728\u7CFB\u7EDF\u5907\u5FD8\u5F55\u4E2D\u7F16\u8F91\uFF0C\u907F\u514D\u4E22\u5931\u5185\u5BB9");
        if (current.html !== input.expectedBody) throw new Error("\u5185\u5BB9\u5DF2\u5728\u7CFB\u7EDF\u5907\u5FD8\u5F55\u4E2D\u53D8\u66F4\uFF0C\u8BF7\u91CD\u65B0\u8BFB\u53D6\u540E\u518D\u4FEE\u6539");
        writeAttempted = true;
        note.body = noteHtml(input.title, input.text);
      }
      return JSON.stringify({ok: true, note: snapshot(note)});
    } catch (error) {
      const hint = writeAttempted ? "\u5199\u5165\u5DF2\u5C1D\u8BD5\u4F46\u4FDD\u5B58\u7ED3\u679C\u672A\u786E\u8BA4\uFF0C\u8BF7\u5148\u5237\u65B0\u5217\u8868\u6838\u5BF9\uFF0C\u4E0D\u8981\u91CD\u590D\u521B\u5EFA\u3002 " : "";
      return JSON.stringify({ok: false, error: hint + String(error && error.message ? error.message : error)});
    }
  })()`;
}

// src/notes-api.ts
function record(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("\u7CFB\u7EDF\u5907\u5FD8\u5F55\u8FD4\u56DE\u683C\u5F0F\u4E0D\u6B63\u786E");
  return value;
}
function string(value) {
  if (typeof value !== "string") throw new Error("\u7CFB\u7EDF\u5907\u5FD8\u5F55\u8FD4\u56DE\u683C\u5F0F\u4E0D\u6B63\u786E");
  return value;
}
function id(value) {
  const result = string(value);
  if (!result) throw new Error("\u7CFB\u7EDF\u5907\u5FD8\u5F55\u672A\u8FD4\u56DE\u6709\u6548\u7F16\u53F7\uFF0C\u8BF7\u91CD\u65B0\u8BFB\u53D6\u786E\u8BA4");
  return result;
}
function number(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("\u7CFB\u7EDF\u5907\u5FD8\u5F55\u8FD4\u56DE\u7684\u65F6\u95F4\u6216\u6570\u91CF\u683C\u5F0F\u4E0D\u6B63\u786E");
  return value;
}
function boolean(value) {
  if (typeof value !== "boolean") throw new Error("\u7CFB\u7EDF\u5907\u5FD8\u5F55\u8FD4\u56DE\u7684\u72B6\u6001\u683C\u5F0F\u4E0D\u6B63\u786E");
  return value;
}
function array(value) {
  if (!Array.isArray(value)) throw new Error("\u7CFB\u7EDF\u5907\u5FD8\u5F55\u8FD4\u56DE\u7684\u5217\u8868\u683C\u5F0F\u4E0D\u6B63\u786E");
  return value;
}
function parseNote(value) {
  const v = record(value);
  return {
    id: id(v.id),
    title: string(v.title),
    text: string(v.text),
    html: string(v.html),
    modifiedMs: number(v.modifiedMs),
    locked: boolean(v.locked),
    shared: boolean(v.shared),
    editable: boolean(v.editable)
  };
}
function verifySaved(note, title, text) {
  if (note.title !== title.trim() || note.text.trimEnd() !== text.replace(/\r\n?/g, "\n").trimEnd()) {
    throw new Error("\u4FDD\u5B58\u7ED3\u679C\u4E0E\u8F93\u5165\u4E0D\u4E00\u81F4\uFF0C\u8BF7\u5237\u65B0\u7CFB\u7EDF\u5907\u5FD8\u5F55\u6838\u5BF9\uFF0C\u4E0D\u8981\u91CD\u590D\u521B\u5EFA\u3002");
  }
  return note;
}
function createNotesApi(bridge) {
  async function run(command) {
    let raw;
    try {
      raw = await bridge.invoke("plugin_exec_run", { bin: "osascript", args: ["-l", "JavaScript", "-e", buildNotesScript(command)], timeoutMs: 2e4 });
    } catch (error) {
      if (/timed out|timeout/i.test(String(error))) throw new Error("\u8BFB\u53D6\u6216\u4FDD\u5B58\u5907\u5FD8\u5F55\u8D85\u65F6\uFF0C\u8BF7\u6253\u5F00\u7CFB\u7EDF\u5907\u5FD8\u5F55\u540E\u91CD\u8BD5\uFF1B\u4FDD\u5B58\u8D85\u65F6\u8BF7\u5148\u5237\u65B0\u6838\u5BF9\uFF0C\u907F\u514D\u91CD\u590D\u521B\u5EFA\u3002");
      throw new Error("\u65E0\u6CD5\u8FDE\u63A5\u7CFB\u7EDF\u5907\u5FD8\u5F55\uFF0C\u8BF7\u786E\u8BA4\u5728 Mac \u4E0A\u4F7F\u7528\u5E76\u5DF2\u6388\u4E88\u63D2\u4EF6\u81EA\u52A8\u5316\u6743\u9650\u3002");
    }
    const result = record(raw);
    const stdout = string(result.stdout);
    const stderr = string(result.stderr);
    if (/-1743|not authorized|不允许发送 AppleEvent/.test(stderr + stdout)) {
      throw new Error("\u8BF7\u5728\u7CFB\u7EDF\u8BBE\u7F6E \u2192 \u9690\u79C1\u4E0E\u5B89\u5168\u6027 \u2192 \u81EA\u52A8\u5316\u4E2D\uFF0C\u5141\u8BB8 LawyerCopilot \u63A7\u5236\u201C\u5907\u5FD8\u5F55\u201D\uFF0C\u7136\u540E\u91CD\u8BD5\u3002");
    }
    if (result.code !== 0) throw new Error("\u65E0\u6CD5\u8BFB\u53D6\u6216\u4FDD\u5B58\u7CFB\u7EDF\u5907\u5FD8\u5F55\uFF0C\u8BF7\u6253\u5F00\u201C\u5907\u5FD8\u5F55\u201D\u68C0\u67E5\u8FDE\u63A5\u548C\u6388\u6743\u3002");
    let payload;
    try {
      payload = record(JSON.parse(stdout));
    } catch {
      throw new Error("\u7CFB\u7EDF\u5907\u5FD8\u5F55\u8FD4\u56DE\u683C\u5F0F\u4E0D\u6B63\u786E");
    }
    if (payload.ok !== true) throw new Error(string(payload.error));
    return payload;
  }
  async function write(command) {
    try {
      const saved = parseNote((await run(command)).note);
      if (command.op === "update" && saved.id !== command.id) throw new Error("\u8FD4\u56DE\u7684\u5907\u5FD8\u5F55\u7F16\u53F7\u4E0D\u4E00\u81F4");
      return verifySaved(saved, command.title, command.text);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new Error(detail.includes("\u4E0D\u8981\u91CD\u590D\u521B\u5EFA") ? detail : `${detail} \u8BF7\u5148\u5237\u65B0\u5217\u8868\u6838\u5BF9\u4FDD\u5B58\u7ED3\u679C\uFF0C\u4E0D\u8981\u91CD\u590D\u521B\u5EFA\u3002`);
    }
  }
  return {
    async folders() {
      const out = await run({ op: "folders" });
      return { defaultFolderId: id(out.defaultFolderId), folders: array(out.folders).map((v) => {
        const row = record(v);
        return { id: id(row.id), name: string(row.name), account: string(row.account) };
      }) };
    },
    async list(folderId, offset) {
      const out = await run({ op: "list", folderId, offset });
      return { total: number(out.total), notes: array(out.notes).map((v) => {
        const row = record(v);
        return { id: id(row.id), title: string(row.title), summary: string(row.summary), modifiedMs: number(row.modifiedMs), locked: boolean(row.locked) };
      }) };
    },
    async read(folderId, noteId) {
      return parseNote((await run({ op: "read", folderId, id: noteId })).note);
    },
    async create(folderId, title, text, confirm) {
      return write({ op: "create", folderId, title, text, confirm });
    },
    async update(folderId, note, title, text, confirm) {
      return write({ op: "update", folderId, id: note.id, expectedBody: note.html, title, text, confirm });
    },
    async show(folderId, noteId) {
      await run({ op: "show", folderId, id: noteId });
    }
  };
}

// src/notes-panel.ts
var BUTTON = "rounded-lg px-3 py-2 text-caption-1-medium text-text-secondary hover:bg-button-ghost-hover disabled:opacity-40";
var PRIMARY = "rounded-lg bg-accent-500 px-3 py-2 text-caption-1-medium text-white disabled:opacity-40";
var FIELD = "w-full rounded-lg border border-border-button-default bg-background-full px-3 py-2 text-body-3-regular text-text-primary";
var FOLDER_KEY = "notes-folder";
function message(error) {
  return error instanceof Error ? error.message : String(error);
}
function createNotesPanel(ctx, api) {
  const { createElement: el, useState, useEffect, useRef } = ctx.react;
  return function NotesPanel() {
    const [folders, setFolders] = useState([]);
    const [folderId, setFolderId] = useState("");
    const [notes, setNotes] = useState([]);
    const [total, setTotal] = useState(0);
    const [offset, setOffset] = useState(0);
    const [busy, setBusy] = useState(true);
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    const [selected, setSelected] = useState(null);
    const [editing, setEditing] = useState(false);
    const [title, setTitle] = useState("");
    const [text, setText] = useState("");
    const [confirming, setConfirming] = useState(false);
    const request = useRef({ busy: false, live: true });
    async function run(work, apply) {
      if (request.current.busy) return;
      request.current.busy = true;
      setBusy(true);
      setError("");
      setNotice("");
      try {
        const result = await work();
        if (request.current.live) apply(result);
      } catch (cause) {
        if (request.current.live) setError(message(cause));
      } finally {
        request.current.busy = false;
        if (request.current.live) setBusy(false);
      }
    }
    function applyList(result, folder, page) {
      setFolderId(folder);
      setOffset(page);
      setNotes(result.notes);
      setTotal(result.total);
      setSelected(null);
    }
    useEffect(() => {
      request.current.live = true;
      void run(async () => {
        const available = await api.folders();
        const stored = await ctx.storage.get(FOLDER_KEY);
        const folder = available.folders.find((item) => item.id === stored)?.id ?? available.defaultFolderId;
        if (request.current.live) {
          setFolders(available.folders);
          setFolderId(folder);
        }
        const listed = await api.list(folder, 0);
        return { available, folder, listed };
      }, ({ available, folder, listed }) => {
        setFolders(available.folders);
        applyList(listed, folder, 0);
      });
      return () => {
        request.current.live = false;
      };
    }, []);
    function load(folder, page = 0) {
      if (editing) return;
      void run(async () => {
        let listed = await api.list(folder, page);
        const currentPage = page > 0 && listed.notes.length === 0 ? 0 : page;
        if (currentPage !== page && listed.total > 0) listed = await api.list(folder, currentPage);
        await ctx.storage.set(FOLDER_KEY, folder);
        return { listed, currentPage };
      }, ({ listed, currentPage }) => applyList(listed, folder, currentPage));
    }
    function refresh() {
      void run(async () => {
        const available = await api.folders();
        const folder = available.folders.some((f) => f.id === folderId) ? folderId : available.defaultFolderId;
        const listed = await api.list(folder, 0);
        return { available, folder, listed };
      }, ({ available, folder, listed }) => {
        setFolders(available.folders);
        applyList(listed, folder, 0);
      });
    }
    function open(note) {
      void run(() => api.read(folderId, note.id), setSelected);
    }
    function edit(note) {
      setSelected(note);
      setTitle(note?.title ?? "");
      setText(note?.text ?? "");
      setConfirming(false);
      setEditing(true);
      setError("");
      setNotice("");
    }
    function save() {
      if (!title.trim()) return;
      if (selected && !confirming) {
        setConfirming(true);
        return;
      }
      void run(() => selected ? api.update(folderId, selected, title, text, true) : api.create(folderId, title, text, true), (saved) => {
        setSelected(saved);
        setEditing(false);
        setConfirming(false);
        setNotice("\u5DF2\u4FDD\u5B58\u5230\u7CFB\u7EDF\u5907\u5FD8\u5F55");
      });
    }
    const button = (label, onClick, disabled = false, primary = false) => el("button", { type: "button", className: primary ? PRIMARY : BUTTON, disabled: busy || disabled, onClick }, label);
    const fieldChange = (setter) => (event) => {
      setter(event.target.value);
      setConfirming(false);
    };
    function cancelEdit() {
      setEditing(false);
      setConfirming(false);
      setError("");
      if (selected) void run(() => api.read(folderId, selected.id), setSelected);
    }
    const formatTime = (ms) => new Date(ms).toLocaleString("zh-CN", { year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
    return el(
      "div",
      { className: "flex h-full min-h-0 flex-col gap-3 p-3" },
      el(
        "div",
        { className: "flex items-center justify-between gap-2" },
        el(
          "div",
          null,
          el("h2", { className: "text-title-3-semibold text-text-primary" }, "\u82F9\u679C\u5907\u5FD8\u5F55"),
          el("p", { className: "text-caption-2-medium text-text-tertiary" }, "\u4E0E Mac \u7684\u201C\u5907\u5FD8\u5F55\u201D\u5171\u7528\u539F\u59CB\u5185\u5BB9")
        ),
        button("\u5237\u65B0", refresh, editing)
      ),
      el(
        "select",
        {
          "aria-label": "\u5907\u5FD8\u5F55\u6587\u4EF6\u5939",
          className: FIELD,
          value: folderId,
          disabled: busy || editing,
          onChange: (e) => load(e.target.value)
        },
        folders.map((f) => el("option", { key: f.id, value: f.id }, `${f.account} \xB7 ${f.name}`))
      ),
      error ? el("div", { role: "alert", className: "rounded-lg bg-background-secondary-default p-3 text-caption-1-regular text-text-primary" }, error) : null,
      notice ? el("p", { role: "status", className: "text-caption-1-regular text-text-secondary" }, notice) : null,
      busy ? el("p", { role: "status", className: "text-caption-1-regular text-text-tertiary" }, "\u6B63\u5728\u8BFB\u53D6\u6216\u4FDD\u5B58\u5907\u5FD8\u5F55\u2026") : null,
      editing ? el(
        "div",
        { className: "flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto" },
        el(
          "label",
          { className: "text-caption-1-medium text-text-secondary" },
          "\u6807\u9898",
          el("input", { "aria-label": "\u5907\u5FD8\u5F55\u6807\u9898", className: FIELD, value: title, maxLength: 200, disabled: busy, onChange: fieldChange(setTitle), placeholder: "\u4F8B\u5982\uFF1A\u5BA2\u6237\u4F1A\u8C08\u8981\u70B9" })
        ),
        el(
          "label",
          { className: "text-caption-1-medium text-text-secondary" },
          "\u6B63\u6587",
          el("textarea", { "aria-label": "\u5907\u5FD8\u5F55\u6B63\u6587", className: FIELD, value: text, rows: 12, maxLength: 5e4, disabled: busy, onChange: fieldChange(setText), placeholder: "\u8BB0\u5F55\u60F3\u6CD5\u3001\u4E8B\u5B9E\u548C\u4E0B\u4E00\u6B65\u2026", style: { resize: "vertical", minHeight: "180px" } })
        ),
        confirming ? el(
          "div",
          { role: "status", className: "rounded-lg bg-background-secondary-default p-3 text-caption-1-regular text-text-secondary" },
          selected?.shared ? "\u8FD9\u662F\u5171\u4EAB\u5907\u5FD8\u5F55\uFF0C\u5176\u4ED6\u6210\u5458\u4E5F\u4F1A\u770B\u5230\u4FEE\u6539\u3002\u786E\u8BA4\u4FDD\u5B58\u5417\uFF1F" : "\u5C06\u4FEE\u6539\u7CFB\u7EDF\u4E2D\u7684\u8FD9\u6761\u5907\u5FD8\u5F55\uFF0C\u786E\u8BA4\u4FDD\u5B58\u5417\uFF1F"
        ) : null,
        el(
          "div",
          { className: "flex gap-2" },
          button(confirming ? "\u786E\u8BA4\u4FDD\u5B58" : selected ? "\u4FDD\u5B58\u4FEE\u6539" : "\u4FDD\u5B58\u5230\u5907\u5FD8\u5F55", save, !title.trim(), true),
          button("\u53D6\u6D88\u4FEE\u6539", cancelEdit)
        ),
        error ? button("\u653E\u5F03\u8349\u7A3F\u5E76\u91CD\u65B0\u8BFB\u53D6", () => {
          if (selected) void run(() => api.read(folderId, selected.id), edit);
          else {
            setEditing(false);
            void run(() => api.list(folderId, 0), (listed) => applyList(listed, folderId, 0));
          }
        }) : null
      ) : selected ? el(
        "div",
        { className: "flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto" },
        el(
          "div",
          { className: "flex flex-wrap gap-2" },
          button("\u8FD4\u56DE\u5217\u8868", () => load(folderId, offset)),
          selected.editable ? button("\u7F16\u8F91\u5185\u5BB9", () => edit(selected), false, true) : null
        ),
        el("h3", { className: "text-title-3-semibold text-text-primary", style: { overflowWrap: "anywhere" } }, selected.title),
        el("p", { className: "text-caption-2-medium text-text-tertiary" }, `\u4FEE\u6539\u4E8E ${formatTime(selected.modifiedMs)}`),
        el(
          "div",
          { className: "text-body-3-regular text-text-primary", style: { whiteSpace: "pre-wrap", overflowWrap: "anywhere", lineHeight: 1.7 } },
          selected.locked ? "\u6B64\u5907\u5FD8\u5F55\u5DF2\u9501\u5B9A\uFF0C\u8BF7\u5728\u7CFB\u7EDF\u5907\u5FD8\u5F55\u4E2D\u89E3\u9501\u67E5\u770B\u3002" : selected.text
        ),
        !selected.editable ? el("p", { className: "text-caption-1-regular text-text-tertiary" }, "\u6B64\u6761\u5305\u542B\u9501\u5B9A\u3001\u9644\u4EF6\u6216\u590D\u6742\u6392\u7248\uFF0C\u8BF7\u5728\u7CFB\u7EDF\u5907\u5FD8\u5F55\u4E2D\u7F16\u8F91\uFF0C\u907F\u514D\u4E22\u5931\u539F\u5185\u5BB9\u3002") : null,
        button("\u5728\u7CFB\u7EDF\u5907\u5FD8\u5F55\u4E2D\u6253\u5F00", () => {
          void run(() => api.show(folderId, selected.id), () => void 0);
        })
      ) : el(
        "div",
        { className: "flex min-h-0 flex-1 flex-col gap-3" },
        button("\u65B0\u5EFA\u5907\u5FD8\u5F55", () => edit(null), !folderId, true),
        el(
          "div",
          { className: "min-h-0 flex-1 overflow-y-auto" },
          !busy && !error && notes.length === 0 ? el("p", { className: "py-6 text-center text-caption-1-regular text-text-tertiary" }, "\u6B64\u6587\u4EF6\u5939\u8FD8\u6CA1\u6709\u5907\u5FD8\u5F55") : null,
          notes.map((note) => el(
            "button",
            {
              type: "button",
              key: note.id,
              disabled: busy,
              onClick: () => open(note),
              className: "mb-2 w-full rounded-xl border border-separator-border p-3 text-left hover:bg-button-ghost-hover disabled:opacity-40"
            },
            el("div", { className: "truncate text-body-3-medium text-text-primary" }, note.title),
            el("div", { className: "mt-1 truncate text-caption-1-regular text-text-secondary" }, note.summary),
            el("div", { className: "mt-2 text-caption-2-medium text-text-tertiary" }, `\u4FEE\u6539\u4E8E ${formatTime(note.modifiedMs)}`)
          ))
        ),
        total > 30 ? el(
          "div",
          { className: "flex items-center justify-between" },
          button("\u4E0A\u4E00\u9875", () => load(folderId, offset - 30), offset === 0),
          el("span", { className: "text-caption-2-medium text-text-tertiary" }, `${offset + 1}\u2013${Math.min(offset + 30, total)} / ${total}`),
          button("\u4E0B\u4E00\u9875", () => load(folderId, offset + 30), offset + 30 >= total)
        ) : null
      )
    );
  };
}
function createMemosNotebook(ctx, api, RemindersPanel) {
  const { createElement: el, useState } = ctx.react;
  const NotesPanel = createNotesPanel(ctx, api);
  return function MemosNotebook(props) {
    const [tab, setTab] = useState("notes");
    return el(
      "div",
      { className: "flex h-full min-h-0 flex-col" },
      el(
        "div",
        { className: "flex gap-1 border-b border-separator-border px-3 py-2", role: "tablist", "aria-label": "\u5907\u5FD8\u7C7B\u578B" },
        ["notes", "reminders"].map((key) => el("button", {
          type: "button",
          role: "tab",
          "aria-selected": tab === key,
          className: tab === key ? PRIMARY : BUTTON,
          onClick: () => setTab(key),
          key
        }, key === "notes" ? "\u82F9\u679C\u5907\u5FD8\u5F55" : "\u63D0\u9192\u4E8B\u9879"))
      ),
      el("div", { className: "min-h-0 flex-1", style: { display: tab === "notes" ? "block" : "none" } }, el(NotesPanel, props)),
      el("div", { className: "min-h-0 flex-1", style: { display: tab === "reminders" ? "block" : "none" } }, el(RemindersPanel, props))
    );
  };
}

// src/settings-panel.ts
var STATUS_REFRESH_MS2 = 4e3;
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
      const timer = setInterval(() => setSync(api.syncInfo()), STATUS_REFRESH_MS2);
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
        await api.createFull({ text });
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
    const banner = sync.status === "connecting" ? { dot: "#9ca3af", text: "\u6B63\u5728\u8FDE\u63A5\u7CFB\u7EDF\u63D0\u9192\u4E8B\u9879\u2026" } : connected ? { dot: "#10b981", text: `\u5DF2\u8FDE\u63A5\u7CFB\u7EDF\u63D0\u9192\u4E8B\u9879 \xB7 \u300C${APPLE_LIST_NAME}\u300D\u5217\u8868` } : { dot: "#f59e0b", text: "\u4EC5\u672C\u673A\uFF08\u672A\u8FDE\u63A5\u7CFB\u7EDF\u63D0\u9192\u4E8B\u9879\uFF09" };
    return createElement(
      "div",
      { className: "flex flex-col gap-3", style: { padding: "16px" } },
      createElement(
        "div",
        { className: "flex items-center gap-2 rounded-md bg-background-secondary-default px-3 py-2" },
        createElement("span", {
          className: "shrink-0 rounded-full",
          style: { width: "8px", height: "8px", background: banner.dot }
        }),
        createElement("span", { className: "min-w-0 flex-1 text-caption-1-regular text-text-secondary" }, banner.text),
        connected ? null : createElement(
          "button",
          {
            type: "button",
            className: "shrink-0 rounded-md border border-border-button-default px-2.5 py-2 text-caption-2-medium text-text-secondary transition-colors hover:bg-button-ghost-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50",
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
        { className: "text-caption-2-medium text-text-tertiary" },
        "\u5907\u5FD8\u4F1A\u81EA\u52A8\u53CC\u5411\u540C\u6B65\uFF1A\u8FD9\u91CC\u65B0\u5EFA\u3001\u5B8C\u6210\uFF0C\u6216\u76F4\u63A5\u5728\u7CFB\u7EDF\u63D0\u9192\u4E8B\u9879\u91CC\u52FE\u9009\uFF0C\u4E24\u8FB9\u4FDD\u6301\u4E00\u81F4\uFF1B\u5728\u7CFB\u7EDF\u91CC\u5220\u9664\u63D0\u9192\uFF0C\u8FD9\u91CC\u4E5F\u4F1A\u540C\u6B65\u5220\u9664\u3002"
      ) : createElement(
        "p",
        { className: "text-caption-2-medium text-text-tertiary" },
        "\u5907\u5FD8\u4ECD\u5728\u672C\u673A\u8BB0\u5F55\u548C\u4F7F\u7528\u3002\u82E5\u672A\u5F39\u51FA\u300C\u81EA\u52A8\u5316\u300D\u6388\u6743\uFF0C\u8BF7\u5728 \u7CFB\u7EDF\u8BBE\u7F6E \u2192 \u9690\u79C1\u4E0E\u5B89\u5168\u6027 \u2192 \u81EA\u52A8\u5316 \u4E2D\u5141\u8BB8 LawyerCopilot \u63A7\u5236\u63D0\u9192\u4E8B\u9879\uFF0C\u7136\u540E\u70B9\u300C\u91CD\u8BD5\u300D\u3002"
      ),
      error ? createElement(
        "div",
        { className: "rounded-md bg-background-tertiary-error px-3 py-2 text-caption-1-regular text-text-error-primary" },
        `\u64CD\u4F5C\u5931\u8D25\uFF1A${error}`
      ) : null,
      createElement(
        "div",
        { className: "flex gap-2" },
        createElement("input", {
          className: "min-w-0 flex-1 rounded-md border border-border-button-default bg-background-full px-3 py-2 text-body-2-regular text-text-primary outline-none disabled:opacity-50",
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
            className: "rounded-md bg-blue-600 px-3 py-2 text-caption-1-medium text-white shadow-sm transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50",
            disabled: busy || !draft.trim(),
            onClick: () => add()
          },
          "\u6DFB\u52A0"
        )
      ),
      items.length === 0 ? createElement(
        "p",
        { className: "text-center text-body-2-regular text-text-tertiary", style: { padding: "40px 0" } },
        "\u6682\u65E0\u5907\u5FD8\u3002\u5728\u4E0A\u65B9\u8F93\u5165\u5185\u5BB9\uFF0C\u6216\u76F4\u63A5\u7528\u804A\u5929\u53F3\u4FA7\u7684\u300C\u5907\u5FD8\u300D\u9762\u677F\u968F\u624B\u8BB0\u3002"
      ) : createElement(
        "ul",
        { className: "flex flex-col divide-y divide-separator-border" },
        ordered.map(
          (item) => createElement(
            "li",
            { key: item.id, className: "flex items-start gap-3 py-2" },
            createElement("input", {
              type: "checkbox",
              className: "mt-1 h-4 w-4 shrink-0",
              style: { accentColor: "var(--color-accent-500)" },
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
              {
                className: item.done ? "min-w-0 flex-1 text-body-2-regular text-text-tertiary" : "min-w-0 flex-1 text-body-2-regular text-text-primary",
                style: item.done ? { textDecoration: "line-through" } : void 0
              },
              item.text
            ),
            createElement("span", { className: "shrink-0 text-caption-2-medium text-text-tertiary" }, `#${item.id}`)
          )
        )
      ),
      items.length === 0 ? null : createElement(
        "p",
        { className: "text-caption-2-medium text-text-tertiary" },
        `\u5171 ${items.length} \u6761 \xB7 \u672A\u5B8C\u6210 ${open.length} \u6761 \xB7 \u5DF2\u5B8C\u6210 ${done.length} \u6761\uFF1B\u5230\u671F\u3001\u4F18\u5148\u7EA7\u4E0E\u5220\u9664\u8BF7\u5728\u53F3\u4FA7\u300C\u5907\u5FD8\u300D\u9762\u677F\u64CD\u4F5C\u3002`
      )
    );
  };
}

// src/index.ts
var STORAGE_KEY = "records";
var MAP_KEY = "apple-map";
var TOMBSTONE_KEY = "tombstones";
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
    const record2 = raw;
    return parseAppleOut(
      typeof record2.stdout === "string" ? record2.stdout : "",
      typeof record2.code === "number" ? record2.code : -1,
      typeof record2.stderr === "string" ? record2.stderr : ""
    );
  }
  async function loadMap() {
    return parseAppleMap(await ctx.storage.get(MAP_KEY));
  }
  async function saveMap(map) {
    await ctx.storage.set(MAP_KEY, map);
  }
  async function loadTombstones() {
    return parseTombstones(await ctx.storage.get(TOMBSTONE_KEY));
  }
  async function saveTombstones(ids) {
    await ctx.storage.set(TOMBSTONE_KEY, { ids });
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
          (current) => current.items.map((item) => ({
            id: item.id,
            text: item.text,
            done: item.done,
            list: item.list,
            dueDate: item.dueDate,
            priority: item.priority,
            notes: item.notes
          }))
        );
        const map = await loadMap();
        const tombstones = await loadTombstones();
        const ensured = await osa(buildEnsureListScript());
        if (ensured?.ok !== true) throw new Error(`\u5217\u8868\u300C${APPLE_LIST_NAME}\u300D\u4E0D\u53EF\u7528`);
        const trackedLists = /* @__PURE__ */ new Set([APPLE_LIST_NAME]);
        for (const memo of items) if (memo.list) trackedLists.add(memo.list);
        for (const entry of Object.values(map)) if (entry.list) trackedLists.add(entry.list);
        const views = parseReminderList(await osa(buildReadListsScript([...trackedLists])));
        const plan = planSync(items, map, views, tombstones);
        for (const lookup of plan.lookups) {
          const found = parseFoundReminder(await osa(buildFindByIdScript(lookup.reminderId)));
          const resolution = resolveMissingLookup(
            lookup,
            found.found ? { list: found.list, completed: found.completed } : null
          );
          if (resolution.kind === "follow") {
            plan.mapUpdates[String(lookup.memoId)] = resolution.mapUpdate;
          } else {
            plan.localDeletes.push(resolution.memoId);
            plan.mapDrops.push(String(resolution.memoId));
            plan.tombstones.push(resolution.memoId);
          }
        }
        for (const target of plan.appleDeletes) {
          await osa(buildDeleteReminderScript(target.reminderId, target.list));
        }
        for (const memoId of plan.localDeletes) {
          await mutate((current) => {
            if (!current.items.some((entry) => entry.id === memoId)) return { state: current, result: false };
            return { state: deleteItem(current, memoId).state, result: true };
          });
        }
        for (const patch of plan.localPatches) {
          await mutate((current) => {
            const outcome = patch.done ? completeItem(current, patch.memoId) : reopenItem(current, patch.memoId);
            return { state: outcome.state, result: outcome.item.done };
          });
        }
        const mapUpdates = { ...plan.mapUpdates };
        for (const create of plan.appleCreates) {
          const id2 = parseCreatedId(
            await osa(
              buildCreateReminderScript(create.name, create.memoId, {
                notes: create.notes,
                dueDate: create.dueDate,
                priority: create.priority,
                listName: create.list
              })
            )
          );
          if (create.completeAfter) await osa(buildSetCompletedScript(id2, true, create.list));
          mapUpdates[String(create.memoId)] = {
            id: id2,
            name: create.name,
            lastCompleted: create.completeAfter,
            list: create.list
          };
        }
        for (const patch of plan.applePatches) {
          await osa(buildSetCompletedScript(patch.reminderId, patch.completed, patch.list));
        }
        await saveMap(applyPlanToMap(map, { ...plan, mapUpdates }));
        if (plan.tombstones.length > 0) {
          await saveTombstones(mergeTombstones(tombstones, plan.tombstones));
        }
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
  async function appleListNames() {
    return withSoftTimeout(async () => parseListNames(await osa(buildListListsScript())), []);
  }
  async function requireListExists(list) {
    if (ctx.host.isWeb) throw new MemoError("\u5F53\u524D\u73AF\u5883\u65E0\u6CD5\u8BBF\u95EE\u7CFB\u7EDF\u63D0\u9192\u4E8B\u9879");
    const names = await appleListNames();
    if (names.length === 0) throw new MemoError("\u6682\u65F6\u8FDE\u4E0D\u4E0A\u7CFB\u7EDF\u63D0\u9192\u4E8B\u9879\uFF0C\u65E0\u6CD5\u786E\u8BA4\u5217\u8868\uFF0C\u8BF7\u7A0D\u540E\u518D\u8BD5");
    if (!names.includes(list)) {
      throw new MemoError(`\u63D0\u9192\u4E8B\u9879\u91CC\u6CA1\u6709\u300C${list}\u300D\u5217\u8868\uFF1B\u53EF\u5148\u7528 memos_lists \u67E5\u770B\u73B0\u6709\u5217\u8868\uFF0C\u6216\u5148\u5728\u63D0\u9192\u4E8B\u9879 App \u4E2D\u521B\u5EFA`);
    }
  }
  function normalizeListParam(value) {
    if (value === void 0 || value === null || value === "") return void 0;
    if (typeof value !== "string") throw new MemoError("list \u5FC5\u987B\u662F\u5B57\u7B26\u4E32\uFF08\u63D0\u9192\u4E8B\u9879\u5217\u8868\u540D\uFF09");
    const name = value.trim();
    if (!name) return void 0;
    if (name === APPLE_LIST_NAME) return void 0;
    if (name.length > 100) throw new MemoError("\u5217\u8868\u540D\u8FC7\u957F\uFF08\u6700\u591A 100 \u5B57\uFF09");
    return name;
  }
  function pushCreate(item) {
    if (syncStatus !== "connected" || ctx.host.isWeb) return;
    const listName = item.list ?? APPLE_LIST_NAME;
    void updateMap(async (map) => {
      const key = String(item.id);
      if (map[key]) return void 0;
      const id2 = parseCreatedId(
        await osa(
          buildCreateReminderScript(item.text, item.id, {
            notes: item.notes,
            dueDate: item.dueDate,
            priority: item.priority,
            listName
          })
        )
      );
      return { ...map, [key]: { id: id2, name: item.text, lastCompleted: false, list: listName } };
    }).catch(() => void 0);
  }
  function pushUpdate(item, recreate) {
    if (syncStatus !== "connected" || ctx.host.isWeb) return;
    void updateMap(async (map) => {
      const entry = map[String(item.id)];
      if (!entry) return void 0;
      const listName = entry.list ?? APPLE_LIST_NAME;
      const key = String(item.id);
      if (!recreate) {
        parseUpdatedOk(
          await osa(
            buildUpdateReminderScript(
              entry.id,
              {
                name: item.text,
                body: reminderBodyFor(item.id, item.notes),
                dueDate: item.dueDate,
                priority: applePriorityFor(item.priority)
              },
              listName
            )
          )
        );
        return { ...map, [key]: { ...entry, name: item.text } };
      }
      parseDeleteResult(await osa(buildDeleteReminderScript(entry.id, listName)));
      const id2 = parseCreatedId(
        await osa(
          buildCreateReminderScript(item.text, item.id, {
            notes: item.notes,
            dueDate: item.dueDate,
            priority: item.priority,
            listName
          })
        )
      );
      if (item.done) await osa(buildSetCompletedScript(id2, true, listName));
      return { ...map, [key]: { id: id2, name: item.text, lastCompleted: item.done, list: listName } };
    }).catch(() => void 0);
  }
  function pushComplete(item) {
    if (syncStatus !== "connected" || ctx.host.isWeb) return;
    void (async () => {
      try {
        const entry = await enqueueSync(async () => (await loadMap())[String(item.id)]);
        if (entry) {
          await updateMap(async (map) => {
            const current = map[String(item.id)];
            if (!current) return void 0;
            await osa(buildSetCompletedScript(current.id, true, current.list ?? APPLE_LIST_NAME));
            return { ...map, [String(item.id)]: { ...current, lastCompleted: true } };
          });
          return;
        }
        await reconcile();
      } catch {
      }
    })();
  }
  function pushRemove(item) {
    if (ctx.host.isWeb) return;
    void enqueueSync(async () => {
      await saveTombstones(mergeTombstones(await loadTombstones(), [item.id]));
      const map = await loadMap();
      const entry = map[String(item.id)];
      if (!entry) return;
      try {
        parseDeleteResult(await osa(buildDeleteReminderScript(entry.id, entry.list ?? APPLE_LIST_NAME)));
      } catch {
      }
      const next = { ...map };
      delete next[String(item.id)];
      await saveMap(next);
    }).catch(() => void 0);
  }
  function syncSuffix() {
    return syncStatus === "connected" ? "\uFF08\u5DF2\u540C\u6B65\u5230\u7CFB\u7EDF\u63D0\u9192\u4E8B\u9879\uFF09" : "\uFF08\u672C\u673A\u8BB0\u5F55\uFF0C\u7CFB\u7EDF\u63D0\u9192\u4E8B\u9879\u672A\u8FDE\u63A5\uFF09";
  }
  function deleteSuffix() {
    return syncStatus === "connected" ? "\uFF08\u7CFB\u7EDF\u63D0\u9192\u4E8B\u9879\u91CC\u7684\u4E00\u5E76\u5220\u9664\uFF09" : "\uFF08\u672C\u673A\u5DF2\u5220\u9664\uFF1B\u6062\u590D\u8FDE\u63A5\u540E\u4F1A\u81EA\u52A8\u6E05\u7406\u7CFB\u7EDF\u63D0\u9192\uFF09";
  }
  if (!ctx.host.isWeb) {
    void reconcile().catch(() => void 0);
  }
  const api = {
    list: (status, list) => read((current) => listItems(current, normalizeStatus(status), list)),
    all: () => read((current) => [...current.items]),
    get: (id2) => read((current) => {
      if (typeof id2 !== "number" || !Number.isSafeInteger(id2) || id2 <= 0) return null;
      return current.items.find((item) => item.id === id2) ?? null;
    }),
    createFull: (input) => mutate((current) => {
      const outcome = createItem(current, input);
      return { state: outcome.state, result: outcome.item };
    }),
    complete: (id2) => mutate((current) => {
      const outcome = completeItem(current, id2);
      return { state: outcome.state, result: outcome };
    }),
    toggle: (id2) => mutate((current) => {
      const outcome = toggleItem(current, id2);
      return { state: outcome.state, result: outcome };
    }),
    update: (id2, patch) => mutate((current) => {
      const outcome = updateItem(current, id2, patch);
      return { state: outcome.state, result: outcome };
    }),
    remove: (id2) => mutate((current) => {
      const outcome = deleteItem(current, id2);
      return { state: outcome.state, result: outcome.item };
    }),
    syncInfo: () => syncInfo(),
    syncNow: () => {
      if (ctx.host.isWeb) return Promise.resolve(syncInfo());
      return withSoftTimeout(reconcile, syncInfo());
    },
    retrySync: () => {
      if (ctx.host.isWeb) return Promise.resolve(syncInfo());
      syncStatus = "connecting";
      void reconcile().catch(() => void 0);
      return Promise.resolve(syncInfo());
    },
    /** 设置页 / 面板操作后触发后台对账（覆盖新建、完成、重新打开全部方向）。 */
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
      description: "\u5217\u51FA\u5F8B\u5E08\u5907\u5FD8\u5F55\u3002\u9ED8\u8BA4\u53EA\u770B\u672A\u5B8C\u6210\uFF08open\uFF09\uFF0C\u53EF\u9009 done\uFF08\u5DF2\u5B8C\u6210\uFF09\u3001all\uFF08\u5168\u90E8\uFF09\uFF1B\u53EF\u4F20 list \u53EA\u770B\u67D0\u4E2A\u63D0\u9192\u4E8B\u9879\u5217\u8868\u91CC\u7684\u5907\u5FD8\uFF08\u5217\u8868\u540D\u5148\u7528 memos_lists \u67E5\uFF09\uFF1B\u53EA\u8BFB\uFF0C\u4E0D\u4FEE\u6539\u6570\u636E\u3002",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          status: {
            type: "string",
            enum: ["open", "done", "all"],
            description: "\u7B5B\u9009\u8303\u56F4\uFF1Aopen=\u672A\u5B8C\u6210\uFF08\u9ED8\u8BA4\uFF09\u3001done=\u5DF2\u5B8C\u6210\u3001all=\u5168\u90E8"
          },
          list: {
            type: "string",
            description: "\u63D0\u9192\u4E8B\u9879\u5217\u8868\u540D\uFF08\u53EF\u9009\uFF1B\u4E0D\u4F20 = \u5168\u90E8\u5217\u8868\u7684\u5907\u5FD8\uFF09"
          }
        },
        required: []
      },
      async execute(args = {}) {
        const input = args ?? {};
        const status = normalizeStatus(input.status);
        const list = normalizeListParam(input.list);
        await syncBeforeTool();
        if (list !== void 0) await requireListExists(list);
        const items = await api.list(status, list);
        return textResult(renderList(status, items));
      }
    })
  );
  disposers.push(
    ctx.tools.register({
      name: "memos_create",
      description: "\u65B0\u5EFA\u4E00\u6761\u5907\u5FD8\uFF08\u5F85\u529E\uFF09\uFF0C\u53EF\u5E26\u5230\u671F\u65F6\u95F4 dueDate\u3001\u4F18\u5148\u7EA7 priority\uFF08\u65E0/\u4F4E/\u4E2D/\u9AD8\uFF09\u3001\u5907\u6CE8 notes\uFF0C\u81EA\u52A8\u540C\u6B65\u5230 macOS\u300C\u63D0\u9192\u4E8B\u9879\u300D\u3002\u9002\u5408\u8BB0\u5F55\u5F85\u529E\u3001\u671F\u9650\u3001\u540E\u7EED\u52A8\u4F5C\uFF1B\u7EAF\u8FFD\u52A0\uFF0C\u4E0D\u5F71\u54CD\u5DF2\u6709\u5907\u5FD8\u3002",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["text"],
        properties: {
          text: {
            type: "string",
            description: "\u5907\u5FD8\u5185\u5BB9\uFF0C\u4E00\u53E5\u8BDD\u5199\u6E05\u8981\u505A\u4EC0\u4E48\uFF08\u5FC5\u586B\uFF0C\u53BB\u9996\u5C3E\u7A7A\u767D\u540E\u4E0D\u80FD\u4E3A\u7A7A\uFF0C\u6700\u591A 2000 \u5B57\uFF09"
          },
          dueDate: {
            type: "string",
            description: "\u5230\u671F\u65F6\u95F4\uFF0CISO \u683C\u5F0F\uFF08\u5982 2026-03-05T09:00:00\uFF09\uFF1B\u7559\u7A7A\u6216\u4E0D\u4F20 = \u4E0D\u8BBE\u7F6E\u5230\u671F"
          },
          priority: {
            type: "string",
            enum: ["\u65E0", "\u4F4E", "\u4E2D", "\u9AD8"],
            description: "\u4F18\u5148\u7EA7\uFF0C\u9ED8\u8BA4\u300C\u65E0\u300D"
          },
          notes: {
            type: "string",
            description: "\u5907\u6CE8\uFF08\u53EF\u9009\uFF0C\u6700\u591A 2000 \u5B57\uFF0C\u4F1A\u5199\u8FDB\u63D0\u9192\u4E8B\u9879\u7684\u5907\u6CE8\u680F\uFF09"
          },
          list: {
            type: "string",
            description: "\u63D0\u9192\u4E8B\u9879\u5217\u8868\u540D\uFF08\u53EF\u9009\uFF0C\u9ED8\u8BA4\u300C\u5F8B\u5E08\u5907\u5FD8\u5F55\u300D\uFF1B\u5217\u8868\u9700\u5DF2\u5B58\u5728\uFF0C\u53EF\u5148\u7528 memos_lists \u67E5\u770B\uFF09"
          }
        }
      },
      async execute(args = {}) {
        const input = args ?? {};
        const list = normalizeListParam(input.list);
        await syncBeforeTool();
        if (list !== void 0) await requireListExists(list);
        const item = await api.createFull({ ...input, list });
        pushCreate(item);
        return textResult(`\u5DF2\u521B\u5EFA\u5907\u5FD8 #${item.id}\uFF1A${describeMemo(item)}${syncSuffix()}`);
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
          outcome.alreadyDone ? `\u5907\u5FD8 #${outcome.item.id} \u6B64\u524D\u5DF2\u5B8C\u6210\uFF0C\u4FDD\u6301\u4E0D\u53D8\uFF1A${outcome.item.text}` : `\u5DF2\u5B8C\u6210\u5907\u5FD8 #${outcome.item.id}\uFF1A${describeMemo(outcome.item)}${syncSuffix()}`
        );
      }
    })
  );
  disposers.push(
    ctx.tools.register({
      name: "memos_update",
      description: "\u6309\u7F16\u53F7\u4FEE\u6539\u4E00\u6761\u5907\u5FD8\u7684\u6807\u9898\u3001\u5907\u6CE8\u3001\u5230\u671F\u65F6\u95F4\u6216\u4F18\u5148\u7EA7\uFF08\u53EA\u4F20\u8981\u6539\u7684\u5B57\u6BB5\uFF0C\u672A\u4F20\u7684\u4FDD\u6301\u4E0D\u53D8\uFF09\uFF0C\u5E76\u540C\u6B65\u66F4\u65B0\u7CFB\u7EDF\u63D0\u9192\u4E8B\u9879\u91CC\u7684\u5BF9\u5E94\u63D0\u9192\u3002dueDate \u4F20\u7A7A\u5B57\u7B26\u4E32\u53EF\u6E05\u9664\u5230\u671F\uFF1Bpriority \u4F20\u300C\u65E0\u300D\u53EF\u6E05\u9664\u4F18\u5148\u7EA7\u3002",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["id"],
        properties: {
          id: {
            type: "integer",
            minimum: 1,
            description: "\u8981\u4FEE\u6539\u7684\u5907\u5FD8\u7F16\u53F7\uFF08memos_list \u7ED3\u679C\u4E2D\u7684 #id\uFF09"
          },
          text: {
            type: "string",
            description: "\u65B0\u6807\u9898\uFF08\u53EF\u9009\uFF1B\u53BB\u9996\u5C3E\u7A7A\u767D\u540E\u4E0D\u80FD\u4E3A\u7A7A\uFF0C\u6700\u591A 2000 \u5B57\uFF09"
          },
          notes: {
            type: "string",
            description: "\u65B0\u5907\u6CE8\uFF08\u53EF\u9009\uFF1B\u4F20\u7A7A\u5B57\u7B26\u4E32\u6E05\u9664\u5907\u6CE8\uFF09"
          },
          dueDate: {
            type: "string",
            description: "\u65B0\u5230\u671F\u65F6\u95F4\uFF0CISO \u683C\u5F0F\uFF08\u53EF\u9009\uFF1B\u4F20\u7A7A\u5B57\u7B26\u4E32\u6E05\u9664\u5230\u671F\uFF09"
          },
          priority: {
            type: "string",
            enum: ["\u65E0", "\u4F4E", "\u4E2D", "\u9AD8"],
            description: "\u65B0\u4F18\u5148\u7EA7\uFF08\u53EF\u9009\uFF1B\u4F20\u300C\u65E0\u300D\u6E05\u9664\u4F18\u5148\u7EA7\uFF09"
          }
        }
      },
      async execute(args = {}) {
        const input = args ?? {};
        await syncBeforeTool();
        const before = await api.get(input.id);
        const outcome = await api.update(input.id, {
          text: input.text,
          notes: input.notes,
          dueDate: input.dueDate,
          priority: input.priority
        });
        const clearedDue = before !== null && before.dueDate !== void 0 && outcome.item.dueDate === void 0;
        pushUpdate(outcome.item, clearedDue);
        return textResult(
          `\u5DF2\u66F4\u65B0\u5907\u5FD8 #${outcome.item.id}\uFF08\u6539\u4E86\uFF1A${outcome.changed.join("\u3001")}\uFF09\uFF1A${describeMemo(outcome.item)}${syncSuffix()}`
        );
      }
    })
  );
  disposers.push(
    ctx.tools.register({
      name: "memos_delete",
      description: "\u6309\u7F16\u53F7\u5220\u9664\u4E00\u6761\u5907\u5FD8\uFF1A\u672C\u673A\u4E0E macOS\u300C\u63D0\u9192\u4E8B\u9879\u300D\u91CC\u7684\u5BF9\u5E94\u63D0\u9192\u4E00\u5E76\u5220\u9664\uFF0C\u5E76\u8BB0\u5F55\u5220\u9664\u6807\u8BB0\u2014\u2014\u4E4B\u540E\u5BF9\u8D26\u4E0D\u4F1A\u628A\u5B83\u91CD\u5EFA\u51FA\u6765\uFF1B\u5728\u63D0\u9192\u4E8B\u9879 App \u91CC\u624B\u52A8\u5220\u63D0\u9192\u6548\u679C\u76F8\u540C\u3002\u5220\u9664\u4E0D\u53EF\u64A4\u9500\uFF0C\u8BF7\u786E\u8BA4\u540E\u518D\u8C03\u7528\u3002",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["id"],
        properties: {
          id: {
            type: "integer",
            minimum: 1,
            description: "\u8981\u5220\u9664\u7684\u5907\u5FD8\u7F16\u53F7\uFF08memos_list \u7ED3\u679C\u4E2D\u7684 #id\uFF09"
          }
        }
      },
      async execute(args = {}) {
        const input = args ?? {};
        await syncBeforeTool();
        const item = await api.remove(input.id);
        pushRemove(item);
        return textResult(`\u5DF2\u5220\u9664\u5907\u5FD8 #${item.id}\uFF1A${item.text}${deleteSuffix()}`);
      }
    })
  );
  disposers.push(
    ctx.tools.register({
      name: "memos_lists",
      description: "\u5217\u51FA macOS\u300C\u63D0\u9192\u4E8B\u9879\u300DApp \u91CC\u7684\u5168\u90E8\u5217\u8868\u540D\u3002\u521B\u5EFA\u5907\u5FD8\u65F6\u60F3\u6307\u5B9A list \u53C2\u6570\uFF0C\u5148\u7528\u8FD9\u4E2A\u5DE5\u5177\u770B\u6709\u54EA\u4E9B\u5217\u8868\u3002",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {},
        required: []
      },
      async execute() {
        if (ctx.host.isWeb) throw new MemoError("\u5F53\u524D\u73AF\u5883\u65E0\u6CD5\u8BBF\u95EE\u7CFB\u7EDF\u63D0\u9192\u4E8B\u9879");
        const names = await appleListNames();
        if (names.length === 0) {
          throw new MemoError("\u6682\u65F6\u8FDE\u4E0D\u4E0A\u7CFB\u7EDF\u63D0\u9192\u4E8B\u9879\uFF0C\u8BF7\u7A0D\u540E\u518D\u8BD5\uFF1B\u82E5\u4ECE\u672A\u5F39\u51FA\u300C\u81EA\u52A8\u5316\u300D\u6388\u6743\uFF0C\u8BF7\u5728\u7CFB\u7EDF\u8BBE\u7F6E\u91CC\u5141\u8BB8 LawyerCopilot \u63A7\u5236\u63D0\u9192\u4E8B\u9879");
        }
        return textResult(
          [
            `\u63D0\u9192\u4E8B\u9879\u5171 ${names.length} \u4E2A\u5217\u8868\uFF1A`,
            ...names.map((name) => `- ${name}${name === APPLE_LIST_NAME ? "\uFF08\u5907\u5FD8\u9ED8\u8BA4\u5217\u8868\uFF09" : ""}`)
          ].join("\n")
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
  if (typeof ctx.ui.registerPanelTab === "function") {
    disposers.push(
      ctx.ui.registerPanelTab({
        key: "lawyer-memos",
        label: () => "\u5907\u5FD8",
        component: createMemosNotebook(ctx, createNotesApi(ctx.bridge), createMemosPanelTab(ctx, api))
      })
    );
  }
  return () => {
    for (const dispose of disposers.splice(0)) dispose();
  };
}
export {
  activate as default
};
