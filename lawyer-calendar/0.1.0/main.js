// src/jxa.ts
function js(value) {
  return JSON.stringify(value);
}
function wrapper(body) {
  return [
    "(function () {",
    "  try {",
    ...body.split("\n").map((line) => `    ${line}`),
    "  } catch (e) {",
    "    return JSON.stringify({ ok: false, error: String(e && e.message ? e.message : e) });",
    "  }",
    "})()"
  ].join("\n");
}
function listCalendarsScript() {
  const body = [
    'const app = Application("Calendar");',
    "const cals = app.calendars();",
    "const rows = [];",
    "for (const c of cals) {",
    "  rows.push({ name: c.name(), writable: c.writable() === true });",
    "}",
    "return JSON.stringify({ ok: true, calendars: rows });"
  ].join("\n");
  return wrapper(body);
}
function listEventsScript(input) {
  const body = [
    `const WANTED = ${input.calendar === null ? "null" : js(input.calendar)};`,
    `const FROM_MS = ${Math.trunc(input.fromMs)};`,
    `const TO_MS = ${Math.trunc(input.toMs)};`,
    `const MAX_ROWS = ${Math.trunc(input.maxRows)};`,
    'const app = Application("Calendar");',
    "const from = new Date(FROM_MS);",
    "const to = new Date(TO_MS);",
    "const cals = app.calendars();",
    "const picked = [];",
    "const names = [];",
    "for (const c of cals) {",
    "  const name = c.name();",
    "  names.push(name);",
    "  if (WANTED === null || name === WANTED) picked.push(c);",
    "}",
    "if (WANTED !== null && picked.length === 0) {",
    '  return JSON.stringify({ ok: false, code: "no-calendar", error: "\u672A\u627E\u5230\u540D\u4E3A\u300A" + WANTED + "\u300B\u7684\u65E5\u5386", available: names });',
    "}",
    "const events = [];",
    "for (const cal of picked) {",
    "  const cname = cal.name();",
    "  const evts = cal.events.whose({ _and: [{ startDate: { _greaterThan: from } }, { startDate: { _lessThan: to } }] })();",
    "  for (const ev of evts) {",
    "    const alarmCount = ev.displayAlarms().length + ev.soundAlarms().length + ev.mailAlarms().length + ev.openFileAlarms().length;",
    "    events.push({",
    "      calendar: cname,",
    "      title: ev.summary(),",
    "      startMs: ev.startDate().getTime(),",
    "      endMs: ev.endDate().getTime(),",
    "      allDay: ev.alldayEvent() === true,",
    "      hasAlarm: alarmCount > 0,",
    "    });",
    "  }",
    "}",
    "events.sort(function (a, b) { return a.startMs - b.startMs || (a.calendar < b.calendar ? -1 : 1); });",
    "const truncated = events.length > MAX_ROWS;",
    "return JSON.stringify({ ok: true, total: events.length, truncated: truncated, events: truncated ? events.slice(0, MAX_ROWS) : events });"
  ].join("\n");
  return wrapper(body);
}
function createEventScript(input) {
  const body = [
    `const CAL = ${js(input.calendar)};`,
    `const TITLE = ${js(input.title)};`,
    `const NOTES = ${input.notes === void 0 ? "null" : js(input.notes)};`,
    `const START = new Date(${Math.trunc(input.startMs)});`,
    `const END = new Date(${Math.trunc(input.endMs)});`,
    `const ALARM = ${Math.trunc(-Math.abs(input.alarmMinutes))};`,
    'const app = Application("Calendar");',
    "const matched = app.calendars.whose({ name: CAL })();",
    "if (matched.length === 0) {",
    "  const names = [];",
    "  for (const c of app.calendars()) names.push(c.name());",
    '  return JSON.stringify({ ok: false, code: "no-calendar", error: "\u672A\u627E\u5230\u540D\u4E3A\u300A" + CAL + "\u300B\u7684\u65E5\u5386", available: names });',
    "}",
    "const cal = matched[0];",
    "if (cal.writable() !== true) {",
    '  return JSON.stringify({ ok: false, code: "read-only", error: "\u65E5\u5386\u300A" + CAL + "\u300B\u662F\u8BA2\u9605/\u53EA\u8BFB\u65E5\u5386\uFF0C\u4E0D\u80FD\u5199\u5165" });',
    "}",
    "const props = { summary: TITLE, startDate: START, endDate: END };",
    "if (NOTES !== null) props.description = NOTES;",
    "const ev = app.Event(props);",
    "cal.events.push(ev);",
    "ev.displayAlarms.push(app.DisplayAlarm({ triggerInterval: ALARM }));",
    "const alarmCount = ev.displayAlarms().length;",
    "return JSON.stringify({",
    "  ok: true,",
    "  calendar: cal.name(),",
    "  uid: String(ev.uid()),",
    "  title: ev.summary(),",
    "  startMs: ev.startDate().getTime(),",
    "  endMs: ev.endDate().getTime(),",
    "  alarmCount: alarmCount,",
    "});"
  ].join("\n");
  return wrapper(body);
}

// src/logic.ts
var MAX_DRAFTS = 100;
var MAX_TITLE_LENGTH = 200;
var MAX_NOTES_LENGTH = 2e3;
var MAX_CALENDAR_NAME_LENGTH = 100;
var DEFAULT_ALARM_MINUTES = 15;
var BEIJING_OFFSET_MS = 8 * 36e5;
var MIN_DAYS = 1;
var MAX_DAYS = 90;
var DEFAULT_DAYS = 7;
var MAX_EVENT_ROWS = 200;
var CalendarError = class extends Error {
  kind;
  constructor(message, kind = "args") {
    super(message);
    this.name = "CalendarError";
    this.kind = kind;
  }
};
var NAIVE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?$/;
function beijingWallClock(ms) {
  const iso = new Date(ms + BEIJING_OFFSET_MS).toISOString();
  return {
    y: Number(iso.slice(0, 4)),
    mo: Number(iso.slice(5, 7)),
    d: Number(iso.slice(8, 10)),
    hh: Number(iso.slice(11, 13)),
    mi: Number(iso.slice(14, 16)),
    ss: Number(iso.slice(17, 19))
  };
}
var pad2 = (value) => String(value).padStart(2, "0");
function toBeijingNaive(ms) {
  const t = beijingWallClock(ms);
  return `${t.y}-${pad2(t.mo)}-${pad2(t.d)}T${pad2(t.hh)}:${pad2(t.mi)}:${pad2(t.ss)}`;
}
function fromBeijingNaive(value) {
  const match = NAIVE_RE.exec(value);
  if (!match) throw new CalendarError(`\u65F6\u95F4\u683C\u5F0F\u4E0D\u6B63\u786E\uFF1A${value}`, "args");
  const [, y, mo, d, hh = "00", mi = "00", ss = "00"] = match;
  if (Number(hh) > 23 || Number(mi) > 59 || Number(ss) > 59) {
    throw new CalendarError(`\u65F6\u95F4\u683C\u5F0F\u4E0D\u6B63\u786E\uFF1A${value}`, "args");
  }
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(hh), Number(mi), Number(ss)) - BEIJING_OFFSET_MS;
  if (toBeijingNaive(ms) !== `${y}-${mo}-${d}T${pad2(Number(hh))}:${pad2(Number(mi))}:${pad2(Number(ss))}`) {
    throw new CalendarError(`\u65E5\u671F\u4E0D\u5B58\u5728\uFF1A${value}`, "args");
  }
  return ms;
}
function parseEventTime(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new CalendarError(`${label} \u5FC5\u586B\uFF0C\u8BF7\u7528\u5317\u4EAC\u65F6\u95F4\u683C\u5F0F YYYY-MM-DDTHH:mm:ss`, "args");
  }
  const raw = value.trim();
  if (NAIVE_RE.test(raw)) return fromBeijingNaive(raw);
  const parsed = Date.parse(raw);
  if (Number.isFinite(parsed)) return parsed;
  throw new CalendarError(
    `${label} \u65E0\u6CD5\u8BC6\u522B\uFF1A${raw}\uFF08\u652F\u6301\u5317\u4EAC\u65F6\u95F4 YYYY-MM-DDTHH:mm:ss\uFF0C\u6216\u5E26 Z / +08:00 \u7684 ISO \u65F6\u95F4\uFF09`,
    "args"
  );
}
var WEEKDAYS = ["\u5468\u65E5", "\u5468\u4E00", "\u5468\u4E8C", "\u5468\u4E09", "\u5468\u56DB", "\u5468\u4E94", "\u5468\u516D"];
function partsOf(ms) {
  const t = beijingWallClock(ms);
  const weekday = WEEKDAYS[new Date(Date.UTC(t.y, t.mo - 1, t.d)).getUTCDay()];
  return { ...t, weekday };
}
function formatDateTime(ms) {
  const t = partsOf(ms);
  return `${t.y}-${pad2(t.mo)}-${pad2(t.d)} ${pad2(t.hh)}:${pad2(t.mi)}`;
}
function formatDate(ms) {
  const t = partsOf(ms);
  return `${t.y}-${pad2(t.mo)}-${pad2(t.d)}`;
}
function formatTime(ms) {
  const t = partsOf(ms);
  return `${pad2(t.hh)}:${pad2(t.mi)}`;
}
function formatRange(startMs, endMs) {
  const s = partsOf(startMs);
  const e = partsOf(endMs);
  const sameDay = s.y === e.y && s.mo === e.mo && s.d === e.d;
  const startDate = `${pad2(s.mo)}-${pad2(s.d)}\uFF08${s.weekday}\uFF09`;
  if (sameDay) return `${startDate} ${formatTime(startMs)}\uFF5E${formatTime(endMs)}`;
  return `${startDate} ${formatTime(startMs)} \uFF5E ${formatDate(endMs)} ${formatTime(endMs)}`;
}
function normalizeDays(value) {
  if (value === void 0 || value === null || value === "") return DEFAULT_DAYS;
  let num;
  if (typeof value === "number") num = value;
  else if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value.trim())) num = Number(value.trim());
  else throw new CalendarError("days \u5FC5\u987B\u662F 1\u201390 \u7684\u6574\u6570\uFF08\u5929\u6570\uFF09", "args");
  if (!Number.isInteger(num) || num < MIN_DAYS || num > MAX_DAYS) {
    throw new CalendarError(`days \u5FC5\u987B\u662F ${MIN_DAYS}\u2013${MAX_DAYS} \u7684\u6574\u6570\uFF08\u5929\u6570\uFF09`, "args");
  }
  return num;
}
function normalizeDraftId(value) {
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) value = Number(value.trim());
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  throw new CalendarError("draft_id \u5FC5\u987B\u662F\u6B63\u6574\u6570\uFF08calendar_drafts \u8FD4\u56DE\u7684\u8349\u7A3F\u7F16\u53F7\uFF09", "args");
}
function pickDefaultCalendar(calendars) {
  const writable = calendars.filter((cal) => cal.writable);
  if (!writable.length) {
    throw new CalendarError(
      "\u65E5\u5386.app \u4E2D\u6CA1\u6709\u53EF\u5199\u5165\u7684\u65E5\u5386\uFF08\u8BA2\u9605\u65E5\u5386\u5982\u300C\u751F\u65E5 / \u4E2D\u56FD\u5927\u9646\u8282\u5047\u65E5 / Siri\u5EFA\u8BAE\u300D\u53EA\u8BFB\uFF09\u3002\u8BF7\u5728\u65E5\u5386.app \u4E2D\u786E\u8BA4\u5B58\u5728\u672C\u5730\u6216 iCloud \u65E5\u5386\u3002",
      "calendar"
    );
  }
  return writable.find((cal) => cal.name === "\u4E2A\u4EBA") ?? writable[0];
}
function resolveTargetCalendar(calendars, requested) {
  if (requested === void 0 || requested === "") return pickDefaultCalendar(calendars);
  const found = calendars.find((cal) => cal.name === requested);
  if (!found) {
    const names = calendars.filter((cal) => cal.writable).map((cal) => `\u300A${cal.name}\u300B`);
    throw new CalendarError(
      `\u6CA1\u6709\u627E\u5230\u540D\u4E3A\u300A${requested}\u300B\u7684\u65E5\u5386\u3002\u53EF\u7528\u65E5\u5386\uFF1A${names.length ? names.join("\u3001") : "\uFF08\u65E0\u53EF\u5199\u65E5\u5386\uFF09"}`,
      "calendar"
    );
  }
  if (!found.writable) {
    throw new CalendarError(`\u65E5\u5386\u300A${requested}\u300B\u662F\u8BA2\u9605/\u53EA\u8BFB\u65E5\u5386\uFF0C\u4E0D\u80FD\u5199\u5165\u65E5\u7A0B\u3002\u8BF7\u6362\u4E00\u4E2A\u65E5\u5386\uFF0C\u6216\u8BA9 AI \u91CD\u65B0\u8D77\u8349\u3002`, "calendar");
  }
  return found;
}
function emptyState() {
  return { nextId: 1, items: [] };
}
function cloneDraft(item) {
  return { ...item };
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
var DRAFT_FIELDS = ["id", "title", "start", "end", "notes", "calendar", "createdAt"];
function validateState(value) {
  if (!isRecord(value)) throw new CalendarError("\u8349\u7A3F\u6570\u636E\u4E0D\u662F\u5BF9\u8C61", "store");
  const { nextId, items } = value;
  if (typeof nextId !== "number" || !Number.isSafeInteger(nextId) || nextId < 1) {
    throw new CalendarError("\u8349\u7A3F\u6570\u636E nextId \u4E0D\u5408\u6CD5", "store");
  }
  if (!Array.isArray(items) || items.length > MAX_DRAFTS) throw new CalendarError("\u8349\u7A3F\u6570\u636E items \u4E0D\u5408\u6CD5\u6216\u8D85\u8FC7\u4E0A\u9650", "store");
  const seen = /* @__PURE__ */ new Set();
  for (const entry of items) {
    if (!isRecord(entry)) throw new CalendarError("\u8349\u7A3F\u6761\u76EE\u4E0D\u662F\u5BF9\u8C61", "store");
    const keys = Object.keys(entry);
    if (keys.some((key) => !DRAFT_FIELDS.includes(key))) {
      throw new CalendarError(`\u8349\u7A3F\u6761\u76EE\u5305\u542B\u4E0D\u652F\u6301\u7684\u5B57\u6BB5\uFF1A${keys.join(", ")}`, "store");
    }
    if (typeof entry.id !== "number" || !Number.isSafeInteger(entry.id) || entry.id < 1 || seen.has(entry.id)) {
      throw new CalendarError(`\u8349\u7A3F\u6761\u76EE id \u4E0D\u5408\u6CD5\u6216\u91CD\u590D`, "store");
    }
    seen.add(entry.id);
    if (entry.id >= nextId) throw new CalendarError("\u8349\u7A3F\u6761\u76EE id \u4E0D\u5C0F\u4E8E nextId", "store");
    if (typeof entry.title !== "string" || !entry.title.trim() || entry.title.length > MAX_TITLE_LENGTH) {
      throw new CalendarError(`\u8349\u7A3F #${entry.id} \u7684\u6807\u9898\u4E3A\u7A7A\u6216\u8D85\u8FC7 ${MAX_TITLE_LENGTH} \u5B57`, "store");
    }
    for (const key of ["start", "end"]) {
      const stamp = entry[key];
      if (typeof stamp !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(stamp)) {
        throw new CalendarError(`\u8349\u7A3F #${entry.id} \u7684 ${key} \u4E0D\u662F\u5317\u4EAC\u65F6\u95F4\u683C\u5F0F`, "store");
      }
    }
    if (fromBeijingNaive(entry.start) >= fromBeijingNaive(entry.end)) {
      throw new CalendarError(`\u8349\u7A3F #${entry.id} \u7684\u7ED3\u675F\u65F6\u95F4\u4E0D\u665A\u4E8E\u5F00\u59CB\u65F6\u95F4`, "store");
    }
    if (entry.notes !== void 0 && (typeof entry.notes !== "string" || entry.notes.length > MAX_NOTES_LENGTH)) {
      throw new CalendarError(`\u8349\u7A3F #${entry.id} \u7684\u5907\u6CE8\u4E0D\u5408\u6CD5`, "store");
    }
    if (entry.calendar !== void 0 && (typeof entry.calendar !== "string" || !entry.calendar.trim() || entry.calendar.length > MAX_CALENDAR_NAME_LENGTH)) {
      throw new CalendarError(`\u8349\u7A3F #${entry.id} \u7684\u76EE\u6807\u65E5\u5386\u540D\u4E0D\u5408\u6CD5`, "store");
    }
    if (typeof entry.createdAt !== "string" || !Number.isFinite(Date.parse(entry.createdAt))) {
      throw new CalendarError(`\u8349\u7A3F #${entry.id} \u7684 createdAt \u4E0D\u662F\u6709\u6548\u65F6\u95F4`, "store");
    }
  }
  return { nextId, items: items.map(cloneDraft) };
}
function parseState(value) {
  if (value === void 0 || value === null) return emptyState();
  try {
    return validateState(value);
  } catch {
    return emptyState();
  }
}
function normalizeTitle(value) {
  if (typeof value !== "string" || !value.trim()) throw new CalendarError("title \u5FC5\u586B\uFF1A\u65E5\u7A0B\u6807\u9898\u4E0D\u80FD\u4E3A\u7A7A", "args");
  const title = value.trim();
  if (title.length > MAX_TITLE_LENGTH) throw new CalendarError(`\u65E5\u7A0B\u6807\u9898\u4E0D\u80FD\u8D85\u8FC7 ${MAX_TITLE_LENGTH} \u5B57`, "args");
  return title;
}
function normalizeNotes(value) {
  if (value === void 0 || value === null) return void 0;
  if (typeof value !== "string") throw new CalendarError("notes \u5FC5\u987B\u662F\u5B57\u7B26\u4E32", "args");
  const notes = value.trim();
  if (!notes) return void 0;
  if (notes.length > MAX_NOTES_LENGTH) throw new CalendarError(`\u5907\u6CE8\u4E0D\u80FD\u8D85\u8FC7 ${MAX_NOTES_LENGTH} \u5B57`, "args");
  return notes;
}
function normalizeCalendarName(value) {
  if (value === void 0 || value === null || value === "") return void 0;
  if (typeof value !== "string") throw new CalendarError("calendar \u5FC5\u987B\u662F\u5B57\u7B26\u4E32\uFF08\u65E5\u5386\u540D\u79F0\uFF09", "args");
  const name = value.trim();
  if (!name) return void 0;
  if (name.length > MAX_CALENDAR_NAME_LENGTH) throw new CalendarError("\u65E5\u5386\u540D\u79F0\u8FC7\u957F", "args");
  return name;
}
function createDraft(state, input, now = /* @__PURE__ */ new Date()) {
  const title = normalizeTitle(input?.title);
  const startMs = parseEventTime(input?.start, "start\uFF08\u5F00\u59CB\u65F6\u95F4\uFF09");
  const endMs = parseEventTime(input?.end, "end\uFF08\u7ED3\u675F\u65F6\u95F4\uFF09");
  if (endMs <= startMs) throw new CalendarError("\u7ED3\u675F\u65F6\u95F4\u5FC5\u987B\u665A\u4E8E\u5F00\u59CB\u65F6\u95F4", "args");
  const notes = normalizeNotes(input?.notes);
  const calendar = normalizeCalendarName(input?.calendar);
  if (state.items.length >= MAX_DRAFTS) throw new CalendarError(`\u5F85\u786E\u8BA4\u8349\u7A3F\u6700\u591A ${MAX_DRAFTS} \u6761\uFF0C\u8BF7\u5148\u786E\u8BA4\u6216\u4E22\u5F03\u73B0\u6709\u8349\u7A3F`, "args");
  const item = {
    id: state.nextId,
    title,
    start: toBeijingNaive(startMs),
    end: toBeijingNaive(endMs),
    createdAt: now.toISOString()
  };
  if (notes !== void 0) item.notes = notes;
  if (calendar !== void 0) item.calendar = calendar;
  return { state: { nextId: state.nextId + 1, items: [...state.items, item] }, item: cloneDraft(item) };
}
function findDraft(state, rawId) {
  const id = normalizeDraftId(rawId);
  const existing = state.items.find((item) => item.id === id);
  if (!existing) throw new CalendarError(`\u8349\u7A3F #${id} \u4E0D\u5B58\u5728\uFF0C\u53EF\u7528 calendar_drafts \u67E5\u770B\u5F53\u524D\u5F85\u786E\u8BA4\u8349\u7A3F`, "args");
  return cloneDraft(existing);
}
function removeDraft(state, rawId) {
  const id = normalizeDraftId(rawId);
  const removed = state.items.find((item) => item.id === id);
  if (!removed) throw new CalendarError(`\u8349\u7A3F #${id} \u4E0D\u5B58\u5728\uFF0C\u53EF\u7528 calendar_drafts \u67E5\u770B\u5F53\u524D\u5F85\u786E\u8BA4\u8349\u7A3F`, "args");
  return { state: { nextId: state.nextId, items: state.items.filter((item) => item.id !== id) }, removed: cloneDraft(removed) };
}
function listDrafts(state) {
  return [...state.items].sort((a, b) => a.id - b.id).map(cloneDraft);
}
function renderEvent(event) {
  const s = partsOf(event.startMs);
  const when = event.allDay ? `${pad2(s.mo)}-${pad2(s.d)}\uFF08${s.weekday}\uFF09\u5168\u5929` : formatRange(event.startMs, event.endMs);
  return `- ${when} \xB7 ${event.title} \xB7 \u65E5\u5386\u300A${event.calendar}\u300B \xB7 ${event.hasAlarm ? "\u6709\u63D0\u9192" : "\u65E0\u63D0\u9192"}`;
}
function renderEventList(input) {
  const window = `${formatDateTime(input.fromMs)} \uFF5E ${formatDateTime(input.toMs)}`;
  if (!input.total) return `\u672A\u6765 ${input.days} \u5929\uFF08${window}\uFF0C\u5317\u4EAC\u65F6\u95F4\uFF09\u6CA1\u6709\u65E5\u7A0B\u3002`;
  const lines = [
    `\u672A\u6765 ${input.days} \u5929\uFF08${window}\uFF0C\u5317\u4EAC\u65F6\u95F4\uFF09\u5171 ${input.total} \u6761\u65E5\u7A0B\uFF1A`,
    ...input.events.map(renderEvent)
  ];
  if (input.truncated) {
    lines.push(`\uFF08\u65E5\u7A0B\u8F83\u591A\uFF0C\u4EC5\u663E\u793A\u524D ${input.events.length} \u6761\uFF1B\u53EF\u7528 calendar \u53C2\u6570\u6307\u5B9A\u5355\u4E2A\u65E5\u5386\u7F29\u5C0F\u8303\u56F4\uFF09`);
  }
  return lines.join("\n");
}
function renderDraftLine(item) {
  const range = formatRange(fromBeijingNaive(item.start), fromBeijingNaive(item.end));
  const target = item.calendar ? `\u5199\u5165\u65E5\u5386\u300A${item.calendar}\u300B` : "\u5199\u5165\u9ED8\u8BA4\u65E5\u5386\uFF08\u4E2A\u4EBA/\u7B2C\u4E00\u4E2A\u672C\u5730\u65E5\u5386\uFF09";
  const notes = item.notes ? ` \xB7 \u5907\u6CE8\uFF1A${item.notes}` : "";
  return `- #${item.id} ${item.title} \xB7 ${range} \xB7 ${target}${notes}`;
}
function renderDraftList(items) {
  if (!items.length) return "\u5F53\u524D\u6CA1\u6709\u5F85\u786E\u8BA4\u7684\u65E5\u7A0B\u8349\u7A3F\u3002\u8BA9 AI \u7528 calendar_propose \u8D77\u8349\uFF0C\u786E\u8BA4\u540E\u624D\u4F1A\u5199\u5165\u65E5\u5386\u3002";
  return [
    `\u5F53\u524D\u6709 ${items.length} \u6761\u5F85\u786E\u8BA4\u8349\u7A3F\uFF08\u5C1A\u672A\u5199\u5165\u65E5\u5386\uFF0C\u5F8B\u5E08\u786E\u8BA4\u540E\u624D\u4F1A\u6DFB\u52A0\uFF09\uFF1A`,
    ...items.map(renderDraftLine)
  ].join("\n");
}
function renderDraftCreated(item) {
  const range = formatRange(fromBeijingNaive(item.start), fromBeijingNaive(item.end));
  const target = item.calendar ? `\u65E5\u5386\u300A${item.calendar}\u300B` : "\u9ED8\u8BA4\u65E5\u5386\uFF08\u4E2A\u4EBA/\u7B2C\u4E00\u4E2A\u672C\u5730\u65E5\u5386\uFF09";
  return [
    `\u5DF2\u751F\u6210\u5F85\u786E\u8BA4\u8349\u7A3F #${item.id}\uFF1A${item.title}\uFF08${range}\uFF0C\u5317\u4EAC\u65F6\u95F4\uFF09\uFF0C\u8BA1\u5212\u5199\u5165${target}\u3002`,
    '\u8FD9\u53EA\u662F\u8349\u7A3F\uFF0C\u8FD8\u6CA1\u6709\u5199\u5165\u65E5\u5386.app\u2014\u2014\u8BF7\u5F8B\u5E08\u6838\u5BF9\u65F6\u95F4\u540E\u786E\u8BA4\uFF1A\u56DE\u590D"\u786E\u8BA4\u8349\u7A3F ' + item.id + '"\uFF08calendar_confirm draft_id=' + item.id + "\uFF09\uFF0C\u6216\u5728\u8BBE\u7F6E\u9875\u300C\u5F8B\u5E08\u65E5\u5386\u300D\u4E2D\u70B9\u51FB\u786E\u8BA4\uFF1B\u5982\u9700\u4FEE\u6539\uFF0C\u8BA9 AI \u91CD\u65B0\u8D77\u8349\u5E76\u4E22\u5F03\u672C\u6761\u3002"
  ].join("\n");
}
function renderConfirmed(item, calendarName, alarmMinutes = DEFAULT_ALARM_MINUTES) {
  const range = formatRange(fromBeijingNaive(item.start), fromBeijingNaive(item.end));
  return `\u5DF2\u6DFB\u52A0\u5230\u65E5\u5386\u300A${calendarName}\u300B\uFF1A${item.title}\uFF08${range}\uFF0C\u5317\u4EAC\u65F6\u95F4\uFF0C\u5DF2\u8BBE ${alarmMinutes} \u5206\u949F\u524D\u63D0\u9192\uFF09\u3002\u53EF\u5728\u65E5\u5386.app \u6216 iPhone \u65E5\u5386\u4E2D\u67E5\u770B\u3002`;
}

// src/apple.ts
var OSASCRIPT_TIMEOUT_MS = 3e4;
var OPEN_TIMEOUT_MS = 15e3;
function isRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function firstLine(text, max = 300) {
  const line = text.split("\n").find((entry) => entry.trim()) ?? "";
  return line.trim().slice(0, max);
}
function isAutomationDenied(detail) {
  return detail.includes("-1743") || detail.includes("-25211") || /not authorized/i.test(detail) || /not allowed/i.test(detail) || detail.includes("\u4E0D\u5141\u8BB8") || detail.includes("\u672A\u6388\u6743");
}
function automationHint(op, detail) {
  return new CalendarError(
    `\u65E0\u6CD5\u8BBF\u95EE macOS\u300C\u65E5\u5386\u300DApp\uFF08${op}\u5931\u8D25\uFF09\uFF1A\u8BF7\u5728 \u7CFB\u7EDF\u8BBE\u7F6E \u2192 \u9690\u79C1\u4E0E\u5B89\u5168\u6027 \u2192 \u81EA\u52A8\u5316 \u4E2D\uFF0C\u5141\u8BB8 LawyerCopilot \u63A7\u5236\u300C\u65E5\u5386\u300D\uFF0C\u7136\u540E\u91CD\u8BD5\u3002\u82E5\u5217\u8868\u91CC\u6CA1\u6709\u8BE5\u9879\uFF0C\u5148\u91CD\u542F LawyerCopilot \u5E76\u5728\u5F39\u7A97\u4E2D\u70B9\u300C\u597D\u300D\u3002\uFF08\u539F\u59CB\u9519\u8BEF\uFF1A${detail || "\u65E0\u8F93\u51FA"}\uFF09`,
    "bridge"
  );
}
async function execRun(bridge, bin, args, timeoutMs) {
  let raw;
  try {
    raw = await bridge.invoke("plugin_exec_run", { bin, args, timeoutMs });
  } catch (cause) {
    throw new CalendarError(
      `\u65E0\u6CD5\u6267\u884C\u7CFB\u7EDF\u547D\u4EE4 ${bin}\uFF08${cause instanceof Error ? cause.message : String(cause)}\uFF09\u3002\u8BF7\u786E\u8BA4\u63D2\u4EF6\u7248\u672C\u4E0D\u4F4E\u4E8E manifest \u8981\u6C42\uFF0C\u4E14\u5DF2\u6388\u4E88 osascript / open \u6267\u884C\u6743\u9650\u3002`,
      "bridge"
    );
  }
  if (!isRecord2(raw)) throw new CalendarError(`\u7CFB\u7EDF\u547D\u4EE4 ${bin} \u8FD4\u56DE\u683C\u5F0F\u4E0D\u6B63\u786E`, "bridge");
  return {
    code: typeof raw.code === "number" ? raw.code : -1,
    stdout: typeof raw.stdout === "string" ? raw.stdout : "",
    stderr: typeof raw.stderr === "string" ? raw.stderr : ""
  };
}
async function ensureCalendarRunning(bridge) {
  try {
    await execRun(bridge, "open", ["-a", "Calendar", "-g"], OPEN_TIMEOUT_MS);
  } catch {
  }
}
async function runJxa(bridge, op, script) {
  await ensureCalendarRunning(bridge);
  const result = await execRun(bridge, "osascript", ["-l", "JavaScript", "-e", script], OSASCRIPT_TIMEOUT_MS);
  const output = (result.stdout ?? "").trim();
  if (result.code !== 0 || !output) {
    const detail = firstLine(result.stderr || result.stdout);
    if (result.code !== 0 && isAutomationDenied(detail)) throw automationHint(op, detail);
    throw new CalendarError(`\u65E5\u5386.app \u64CD\u4F5C\u5931\u8D25\uFF08${op}\uFF0C\u9000\u51FA\u7801 ${result.code}\uFF09\uFF1A${detail || "\u65E0\u8F93\u51FA"}`, "calendar");
  }
  let payload;
  try {
    payload = JSON.parse(output);
  } catch {
    const detail = firstLine(result.stderr || output);
    if (isAutomationDenied(detail)) throw automationHint(op, detail);
    throw new CalendarError(`\u65E5\u5386.app \u8FD4\u56DE\u4E86\u65E0\u6CD5\u89E3\u6790\u7684\u7ED3\u679C\uFF08${op}\uFF09\uFF1A${detail}`, "calendar");
  }
  if (!isRecord2(payload)) throw new CalendarError(`\u65E5\u5386.app \u8FD4\u56DE\u4E86\u65E0\u6CD5\u89E3\u6790\u7684\u7ED3\u679C\uFF08${op}\uFF09`, "calendar");
  if (payload.ok !== true) {
    const message = typeof payload.error === "string" && payload.error.trim() ? payload.error.trim() : "\u672A\u77E5\u9519\u8BEF";
    const code = typeof payload.code === "string" ? payload.code : "";
    if (code === "no-calendar") throw new CalendarError(`${message}\u3002\u8BF7\u5230\u65E5\u5386.app \u6838\u5BF9\u65E5\u5386\u540D\u79F0\u3002`, "calendar");
    if (code === "read-only") throw new CalendarError(`${message}\u3002\u9ED8\u8BA4\u5199\u5165\u4F1A\u81EA\u52A8\u8DF3\u8FC7\u8BA2\u9605\u65E5\u5386\uFF0C\u53EF\u6362\u7528\u672C\u5730/iCloud \u65E5\u5386\u3002`, "calendar");
    if (isAutomationDenied(message)) throw automationHint(op, message);
    throw new CalendarError(`\u65E5\u5386.app \u64CD\u4F5C\u5931\u8D25\uFF08${op}\uFF09\uFF1A${message}`, "calendar");
  }
  return payload;
}
function asString(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}
function asNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : Number.NaN;
}
function asBoolean(value) {
  return value === true;
}
function createAppleCalendar(bridge) {
  return {
    async listCalendars() {
      const payload = await runJxa(bridge, "\u8BFB\u53D6\u65E5\u5386\u5217\u8868", listCalendarsScript());
      const calendars = payload.calendars;
      if (!Array.isArray(calendars)) throw new CalendarError("\u65E5\u5386.app \u8FD4\u56DE\u7684\u65E5\u5386\u5217\u8868\u683C\u5F0F\u4E0D\u6B63\u786E", "calendar");
      return calendars.filter(isRecord2).map((row) => ({ name: asString(row.name), writable: asBoolean(row.writable) })).filter((row) => row.name !== "");
    },
    async listEvents(input) {
      const payload = await runJxa(
        bridge,
        "\u67E5\u8BE2\u65E5\u7A0B",
        listEventsScript({ calendar: input.calendar, fromMs: input.fromMs, toMs: input.toMs, maxRows: input.maxRows })
      );
      const events = payload.events;
      if (!Array.isArray(events)) throw new CalendarError("\u65E5\u5386.app \u8FD4\u56DE\u7684\u65E5\u7A0B\u5217\u8868\u683C\u5F0F\u4E0D\u6B63\u786E", "calendar");
      const rows = [];
      for (const entry of events) {
        if (!isRecord2(entry)) continue;
        const startMs = asNumber(entry.startMs);
        const endMs = asNumber(entry.endMs);
        const title = asString(entry.title);
        const calendar = asString(entry.calendar);
        if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || !title || !calendar) continue;
        rows.push({ calendar, title, startMs, endMs, allDay: asBoolean(entry.allDay), hasAlarm: asBoolean(entry.hasAlarm) });
      }
      return { total: asNumber(payload.total) || rows.length, truncated: asBoolean(payload.truncated), events: rows };
    },
    async createEvent(input) {
      const payload = await runJxa(
        bridge,
        "\u5199\u5165\u65E5\u7A0B",
        createEventScript({
          calendar: input.calendar,
          title: input.title,
          notes: input.notes,
          startMs: input.startMs,
          endMs: input.endMs,
          alarmMinutes: input.alarmMinutes
        })
      );
      const startMs = asNumber(payload.startMs);
      const endMs = asNumber(payload.endMs);
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
        throw new CalendarError("\u65E5\u7A0B\u5DF2\u5199\u5165\uFF0C\u4F46\u65E5\u5386.app \u672A\u8FD4\u56DE\u53EF\u6821\u9A8C\u7684\u65F6\u95F4\uFF1B\u8BF7\u5230\u65E5\u5386.app \u6838\u5BF9\u3002", "calendar");
      }
      return {
        calendar: asString(payload.calendar, input.calendar),
        uid: asString(payload.uid),
        title: asString(payload.title, input.title),
        startMs,
        endMs,
        alarmCount: asNumber(payload.alarmCount)
      };
    }
  };
}

// src/index.ts
var STORAGE_KEY = "drafts";
var DAY_MS = 864e5;
function activate(ctx) {
  const disposers = [];
  const apple = createAppleCalendar(ctx.bridge);
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
  function textResult(text) {
    return { content: [{ type: "text", text }] };
  }
  async function guarded(run) {
    try {
      return await run();
    } catch (cause) {
      const message = cause instanceof CalendarError ? cause.message : `\u64CD\u4F5C\u5931\u8D25\uFF1A${cause instanceof Error ? cause.message : String(cause)}`;
      return { content: [{ type: "text", text: message }], isError: true };
    }
  }
  disposers.push(
    ctx.tools.register({
      name: "calendar_list",
      description: "\u67E5\u770B macOS \u65E5\u5386.app \u7684\u771F\u5B9E\u65E5\u7A0B\uFF1A\u5217\u51FA\u672A\u6765 N \u5929\uFF08\u9ED8\u8BA4 7 \u5929\uFF09\u7684\u65E5\u7A0B\uFF0C\u542B\u6807\u9898\u3001\u5F00\u59CB/\u7ED3\u675F\u65F6\u95F4\u3001\u6240\u5C5E\u65E5\u5386\u3001\u662F\u5426\u6709\u63D0\u9192\uFF0C\u65F6\u95F4\u4E3A\u5317\u4EAC\u65F6\u95F4\u3002\u53EA\u8BFB\uFF0C\u4E0D\u4FEE\u6539\u4EFB\u4F55\u65E5\u7A0B\u3002",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: [],
        properties: {
          days: { type: "integer", minimum: 1, maximum: 90, description: "\u67E5\u8BE2\u672A\u6765\u591A\u5C11\u5929\uFF0C\u9ED8\u8BA4 7\uFF081\u201390\uFF09" },
          calendar: { type: "string", description: "\u53EA\u770B\u6307\u5B9A\u65E5\u5386\uFF08\u540D\u79F0\u4E0E\u65E5\u5386.app \u4E2D\u4E00\u81F4\uFF0C\u5982\u300C\u4E2A\u4EBA\u300D\u300C\u5DE5\u4F5C\u300D\uFF09" }
        }
      },
      async execute(args = {}) {
        return guarded(async () => {
          const input = args ?? {};
          const days = normalizeDays(input.days);
          const nowMs = Date.now();
          const outcome = await apple.listEvents({
            calendar: typeof input.calendar === "string" && input.calendar.trim() ? input.calendar.trim() : null,
            fromMs: nowMs,
            toMs: nowMs + days * DAY_MS,
            maxRows: MAX_EVENT_ROWS
          });
          return textResult(
            renderEventList({
              days,
              fromMs: nowMs,
              toMs: nowMs + days * DAY_MS,
              total: outcome.total,
              truncated: outcome.truncated,
              events: outcome.events
            })
          );
        });
      }
    })
  );
  disposers.push(
    ctx.tools.register({
      name: "calendar_propose",
      description: "\u8D77\u8349\u4E00\u6761\u65E5\u7A0B\uFF08\u5982\u5F00\u5EAD\u3001\u4F1A\u89C1\u3001\u671F\u9650\uFF09\u3002\u53EA\u751F\u6210\u5F85\u786E\u8BA4\u8349\u7A3F\uFF0C\u4E0D\u4F1A\u5199\u5165\u65E5\u5386.app\uFF1B\u8FD4\u56DE\u8349\u7A3F\u7F16\u53F7\uFF0C\u7B49\u5F8B\u5E08\u786E\u8BA4\uFF08calendar_confirm\uFF09\u540E\u624D\u771F\u6B63\u6DFB\u52A0\u3002",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["title", "start", "end"],
        properties: {
          title: { type: "string", description: "\u65E5\u7A0B\u6807\u9898\uFF08\u5FC5\u586B\uFF0C\u2264200 \u5B57\uFF0C\u5982\u300CXX\u6848 \u5F00\u5EAD\u300D\uFF09" },
          start: { type: "string", description: "\u5F00\u59CB\u65F6\u95F4\uFF08\u5FC5\u586B\uFF0C\u5317\u4EAC\u65F6\u95F4 YYYY-MM-DDTHH:mm:ss\uFF0C\u5982 2026-03-02T09:30:00\uFF09" },
          end: { type: "string", description: "\u7ED3\u675F\u65F6\u95F4\uFF08\u5FC5\u586B\uFF0C\u5FC5\u987B\u665A\u4E8E\u5F00\u59CB\u65F6\u95F4\uFF0C\u683C\u5F0F\u540C\u4E0A\uFF09" },
          notes: { type: "string", description: "\u5907\u6CE8/\u8BAE\u7A0B\uFF08\u53EF\u9009\uFF0C\u5199\u5165\u65E5\u7A0B\u63CF\u8FF0\uFF09" },
          calendar: { type: "string", description: "\u76EE\u6807\u65E5\u5386\u540D\uFF08\u53EF\u9009\uFF0C\u9ED8\u8BA4\u300C\u4E2A\u4EBA\u300D\u6216\u7B2C\u4E00\u4E2A\u672C\u5730\u53EF\u5199\u65E5\u5386\uFF09" }
        }
      },
      async execute(args = {}) {
        return guarded(async () => {
          const item = await mutate((current) => {
            const outcome = createDraft(current, args ?? {});
            return { state: outcome.state, result: outcome.item };
          });
          return textResult(renderDraftCreated(item));
        });
      }
    })
  );
  disposers.push(
    ctx.tools.register({
      name: "calendar_confirm",
      description: "\u5F8B\u5E08\u786E\u8BA4\u540E\u628A\u8349\u7A3F\u5199\u5165 macOS \u65E5\u5386.app\uFF08\u81EA\u52A8\u5E26 15 \u5206\u949F\u524D\u663E\u793A\u63D0\u9192\uFF09\uFF0C\u5199\u5165\u6210\u529F\u540E\u8349\u7A3F\u81EA\u52A8\u79FB\u9664\u3002draft_id \u6765\u81EA calendar_propose / calendar_drafts \u8FD4\u56DE\u7684\u7F16\u53F7\u3002",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["draft_id"],
        properties: {
          draft_id: { type: "integer", minimum: 1, description: "\u5F85\u786E\u8BA4\u8349\u7A3F\u7F16\u53F7\uFF08#id\uFF09" }
        }
      },
      async execute(args = {}) {
        return guarded(async () => confirmDraft((args ?? {}).draft_id));
      }
    })
  );
  disposers.push(
    ctx.tools.register({
      name: "calendar_drafts",
      description: "\u5217\u51FA\u5F53\u524D\u5F85\u786E\u8BA4\u7684\u65E5\u7A0B\u8349\u7A3F\uFF08\u5C1A\u672A\u5199\u5165\u65E5\u5386.app\uFF09\u3002\u53EA\u8BFB\u3002",
      inputSchema: { type: "object", additionalProperties: false, required: [], properties: {} },
      async execute() {
        return guarded(async () => textResult(renderDraftList(await read((current) => listDrafts(current)))));
      }
    })
  );
  async function confirmDraft(rawId) {
    const draft = await read((current) => findDraft(current, rawId));
    const calendars = await apple.listCalendars();
    const target = resolveTargetCalendar(calendars, draft.calendar);
    const created = await apple.createEvent({
      calendar: target.name,
      title: draft.title,
      notes: draft.notes,
      startMs: fromBeijingNaive(draft.start),
      endMs: fromBeijingNaive(draft.end),
      alarmMinutes: DEFAULT_ALARM_MINUTES
    });
    await mutate((current) => {
      const outcome = removeDraft(current, draft.id);
      return { state: outcome.state, result: outcome.removed };
    });
    return textResult(renderConfirmed(draft, created.calendar, DEFAULT_ALARM_MINUTES));
  }
  const api = {
    drafts: () => read((current) => listDrafts(current)),
    discard: (id) => mutate((current) => {
      const outcome = removeDraft(current, id);
      return { state: outcome.state, result: outcome.removed };
    }),
    confirm: (id) => confirmDraft(id).then((result) => result.content.map((part) => part.text).join("\n")),
    status: async () => {
      try {
        const calendars = await apple.listCalendars();
        return { ok: true, writableCount: calendars.filter((cal) => cal.writable).length };
      } catch (cause) {
        return { ok: false, writableCount: 0, error: cause instanceof Error ? cause.message : String(cause) };
      }
    },
    upcoming: async () => {
      const nowMs = Date.now();
      const toMs = nowMs + DEFAULT_DAYS * DAY_MS;
      try {
        const outcome = await apple.listEvents({ calendar: null, fromMs: nowMs, toMs, maxRows: MAX_EVENT_ROWS });
        return { events: outcome.events, fromMs: nowMs, toMs };
      } catch (cause) {
        return {
          events: [],
          fromMs: nowMs,
          toMs,
          error: cause instanceof Error ? cause.message : String(cause)
        };
      }
    }
  };
  disposers.push(
    ctx.ui.registerSettingsSection({
      key: "lawyer-calendar",
      label: () => "\u5F8B\u5E08\u65E5\u5386",
      component: createSettingsPanel(ctx, api)
    })
  );
  return () => {
    for (const dispose of disposers.splice(0)) dispose();
  };
}
function createSettingsPanel(ctx, api) {
  const { createElement, useState, useEffect } = ctx.react;
  return function CalendarSettingsPanel() {
    const [status, setStatus] = useState(null);
    const [events, setEvents] = useState([]);
    const [window, setWindow] = useState(null);
    const [eventsError, setEventsError] = useState("");
    const [drafts, setDrafts] = useState([]);
    const [notice, setNotice] = useState("");
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);
    async function refresh() {
      setBusy(true);
      setError("");
      try {
        const [statusOut, upcoming, draftItems] = await Promise.all([api.status(), api.upcoming(), api.drafts()]);
        setStatus(statusOut);
        setEvents(upcoming.events);
        setWindow({ fromMs: upcoming.fromMs, toMs: upcoming.toMs });
        setEventsError(upcoming.error ?? "");
        setDrafts(draftItems);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    }
    useEffect(() => {
      void refresh();
    }, []);
    async function run(action) {
      setBusy(true);
      setError("");
      setNotice("");
      try {
        await action();
        await refresh();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    }
    const statusLine = status ? status.ok ? `\u5DF2\u8FDE\u63A5 \u65E5\u5386.app\uFF08${status.writableCount} \u4E2A\u53EF\u5199\u65E5\u5386\uFF09` : "\u65E5\u5386.app \u4E0D\u53EF\u7528" : "\u6B63\u5728\u68C0\u67E5\u65E5\u5386.app\u2026";
    return createElement(
      "div",
      { className: "flex flex-col gap-4 p-4" },
      createElement(
        "div",
        { className: "flex items-center justify-between gap-2" },
        createElement(
          "span",
          {
            className: `text-sm font-medium ${status && !status.ok ? "text-red-600" : "text-gray-800"}`
          },
          statusLine
        ),
        createElement(
          "button",
          {
            type: "button",
            className: "rounded-md border border-gray-300 px-3 py-1.5 text-xs text-gray-600 disabled:cursor-not-allowed disabled:opacity-50",
            disabled: busy,
            onClick: () => {
              void refresh();
            }
          },
          "\u5237\u65B0"
        )
      ),
      status && !status.ok && status.error ? createElement(
        "p",
        { className: "rounded-md bg-red-50 px-3 py-2 text-xs leading-5 text-red-600" },
        status.error
      ) : null,
      error ? createElement("div", { className: "rounded-md bg-red-50 px-3 py-2 text-sm text-red-600" }, `\u64CD\u4F5C\u5931\u8D25\uFF1A${error}`) : null,
      notice ? createElement("div", { className: "rounded-md bg-green-50 px-3 py-2 text-sm text-green-700" }, notice) : null,
      createElement(
        "section",
        { className: "flex flex-col gap-2" },
        createElement(
          "h3",
          { className: "text-sm font-semibold text-gray-700" },
          window ? `\u8FD1 7 \u5929\u65E5\u7A0B\uFF08${formatDateTime(window.fromMs)} \uFF5E ${formatDateTime(window.toMs)}\uFF0C\u5317\u4EAC\u65F6\u95F4\uFF09` : "\u8FD1 7 \u5929\u65E5\u7A0B"
        ),
        eventsError ? createElement("p", { className: "text-xs text-red-600" }, `\u65E0\u6CD5\u8BFB\u53D6\u65E5\u7A0B\uFF1A${eventsError}`) : events.length === 0 ? createElement("p", { className: "py-6 text-center text-sm text-gray-400" }, "\u672A\u6765 7 \u5929\u6CA1\u6709\u65E5\u7A0B\u3002") : createElement(
          "ul",
          { className: "flex flex-col divide-y divide-gray-100 rounded-md border border-gray-200" },
          events.map(
            (event, index) => createElement(
              "li",
              { key: `${event.startMs}-${event.title}-${index}`, className: "flex flex-col gap-0.5 px-3 py-2" },
              createElement("span", { className: "text-sm text-gray-800" }, event.title),
              createElement(
                "span",
                { className: "text-xs text-gray-500" },
                `${event.allDay ? "\u5168\u5929" : formatRange(event.startMs, event.endMs)} \xB7 \u65E5\u5386\u300A${event.calendar}\u300B \xB7 ${event.hasAlarm ? "\u6709\u63D0\u9192" : "\u65E0\u63D0\u9192"}`
              )
            )
          )
        )
      ),
      createElement(
        "section",
        { className: "flex flex-col gap-2" },
        createElement("h3", { className: "text-sm font-semibold text-gray-700" }, "\u5F85\u786E\u8BA4\u8349\u7A3F\uFF08\u786E\u8BA4\u540E\u624D\u5199\u5165\u65E5\u5386\uFF09"),
        drafts.length === 0 ? createElement(
          "p",
          { className: "py-6 text-center text-sm text-gray-400" },
          "\u6682\u65E0\u8349\u7A3F\u3002\u5728\u5BF9\u8BDD\u91CC\u8BA9 AI \u5E2E\u4F60\u5B89\u6392\u65E5\u7A0B\uFF0C\u4F1A\u5148\u51FA\u73B0\u5728\u8FD9\u91CC\u3002"
        ) : createElement(
          "ul",
          { className: "flex flex-col divide-y divide-gray-100 rounded-md border border-gray-200" },
          drafts.map(
            (item) => createElement(
              "li",
              { key: item.id, className: "flex items-start gap-3 px-3 py-2" },
              createElement(
                "div",
                { className: "flex-1" },
                createElement("p", { className: "text-sm text-gray-800" }, `#${item.id} ${item.title}`),
                createElement(
                  "p",
                  { className: "text-xs text-gray-500" },
                  `${formatRange(fromBeijingNaive(item.start), fromBeijingNaive(item.end))} \xB7 ${item.calendar ? `\u5199\u5165\u65E5\u5386\u300A${item.calendar}\u300B` : "\u5199\u5165\u9ED8\u8BA4\u65E5\u5386"}${item.notes ? ` \xB7 ${item.notes}` : ""}`
                )
              ),
              createElement(
                "button",
                {
                  type: "button",
                  className: "rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-50",
                  disabled: busy,
                  onClick: () => {
                    void run(async () => {
                      setNotice(await api.confirm(item.id));
                    });
                  }
                },
                "\u786E\u8BA4\u5165\u5386"
              ),
              createElement(
                "button",
                {
                  type: "button",
                  className: "rounded-md border border-gray-300 px-3 py-1.5 text-xs text-gray-600 disabled:cursor-not-allowed disabled:opacity-50",
                  disabled: busy,
                  onClick: () => {
                    void run(async () => {
                      await api.discard(item.id);
                      setNotice(`\u5DF2\u4E22\u5F03\u8349\u7A3F #${item.id}`);
                    });
                  }
                },
                "\u4E22\u5F03"
              )
            )
          )
        )
      )
    );
  };
}
export {
  activate as default
};
