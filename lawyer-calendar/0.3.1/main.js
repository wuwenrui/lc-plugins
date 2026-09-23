// src/jxa.ts
function js(value) {
  return JSON.stringify(value);
}
function jsMinuteArray(minutes) {
  return `[${minutes.map((m) => Math.trunc(Math.abs(m))).join(", ")}]`;
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
    '  let color = "";',
    '  try { color = String(c.color()); } catch (e) { color = ""; }',
    "  rows.push({ name: c.name(), writable: c.writable() === true, color: color });",
    "}",
    "return JSON.stringify({ ok: true, calendars: rows });"
  ].join("\n");
  return wrapper(body);
}
function listEventsScript(input) {
  const light = input.light === true;
  const body = [
    `const WANTED = ${input.calendar === null ? "null" : js(input.calendar)};`,
    `const FROM_MS = ${Math.trunc(input.fromMs)};`,
    `const TO_MS = ${Math.trunc(input.toMs)};`,
    `const MAX_ROWS = ${Math.trunc(input.maxRows)};`,
    `const LIGHT = ${light ? "true" : "false"};`,
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
    // v0.3.1 两阶段：先把全部日历的 whose 查询做完，再统一读属性。
    // 真机实测（11 日历 13 事件 42 天窗）：交错读属性 23–25s → 两阶段 9.2s
    //（whose 7s + properties 1.7s）；读属性打断 Calendar.app 的查询批处理会拖慢后续 whose。
    "const collected = [];",
    "for (const cal of picked) {",
    "  const cname = cal.name();",
    "  const evts = cal.events.whose({ _and: [{ startDate: { _lessThan: to } }, { endDate: { _greaterThan: from } }] })();",
    "  for (const ev of evts) collected.push([ev, cname]);",
    "}",
    "const events = [];",
    "for (const pair of collected) {",
    "  const ev = pair[0];",
    "  const cname = pair[1];",
    // v0.3.1：properties() 单次 AppleEvent 读全部常规字段（uid/summary/起止/全天/地点/备注/recurrence），
    // 替代逐属性调用（真机实测 15.3s → 4.4s；AppleEvent 往返是瓶颈而非字段数）。
    "    const p = ev.properties();",
    "    const startMs = p.startDate.getTime();",
    "    let alarmCount = 0;",
    "    const alarmTimes = [];",
    "    if (!LIGHT) {",
    "      const groups = [ev.displayAlarms(), ev.soundAlarms(), ev.mailAlarms(), ev.openFileAlarms()];",
    "      for (const group of groups) {",
    "        alarmCount += group.length;",
    "        for (const a of group) {",
    "          let t = null;",
    "          try {",
    "            const iv = a.triggerInterval();",
    '            if (typeof iv === "number") t = startMs + iv * 60000;',
    "          } catch (e1) {}",
    "          if (t === null) {",
    "            try {",
    "              const d = a.triggerDate();",
    '              if (d && typeof d.getTime === "function") t = d.getTime();',
    "            } catch (e2) {}",
    "          }",
    "          if (t !== null) alarmTimes.push(t);",
    "        }",
    "      }",
    "    }",
    '    const location = p.location === null || p.location === undefined ? "" : String(p.location);',
    '    const notes = p.description === null || p.description === undefined ? "" : String(p.description);',
    "    const r = p.recurrence;",
    '    const isRecurring = !(r === null || r === undefined || r === "");',
    "    alarmTimes.sort(function (a, b) { return a - b; });",
    "    events.push({",
    "      calendar: cname,",
    "      uid: String(p.uid),",
    "      title: p.summary,",
    "      startMs: startMs,",
    "      endMs: p.endDate.getTime(),",
    "      allDay: p.alldayEvent === true,",
    "      hasAlarm: alarmCount > 0,",
    "      alarmTimes: alarmTimes,",
    "      location: location,",
    "      notes: notes,",
    "      isRecurring: isRecurring,",
    "    });",
    "}",
    "events.sort(function (a, b) { return a.startMs - b.startMs || (a.calendar < b.calendar ? -1 : 1); });",
    "const truncated = events.length > MAX_ROWS;",
    "return JSON.stringify({ ok: true, total: events.length, truncated: truncated, events: truncated ? events.slice(0, MAX_ROWS) : events });"
  ].join("\n");
  return wrapper(body);
}
function eventDetailScript(input) {
  const body = [
    `const UID = ${js(input.uid)};`,
    'const app = Application("Calendar");',
    "let target = null;",
    "let targetCal = null;",
    "for (const cal of app.calendars()) {",
    "  const hits = cal.events.whose({ uid: UID })();",
    "  if (hits.length > 0) { target = hits[0]; targetCal = cal; break; }",
    "}",
    "if (target === null) {",
    '  return JSON.stringify({ ok: false, code: "no-event", error: "\u672A\u627E\u5230 uid \u4E3A " + UID + " \u7684\u65E5\u7A0B\uFF08\u53EF\u80FD\u5DF2\u88AB\u5220\u9664\uFF0C\u6216\u4E0D\u5728\u672C\u673A\u65E5\u5386\u4E2D\uFF09" });',
    "}",
    "const p = target.properties();",
    "const startMs = p.startDate.getTime();",
    "let alarmCount = 0;",
    "const alarmTimes = [];",
    "const groups = [target.displayAlarms(), target.soundAlarms(), target.mailAlarms(), target.openFileAlarms()];",
    "for (const group of groups) {",
    "  alarmCount += group.length;",
    "  for (const a of group) {",
    "    let t = null;",
    "    try {",
    "      const iv = a.triggerInterval();",
    '      if (typeof iv === "number") t = startMs + iv * 60000;',
    "    } catch (e1) {}",
    "    if (t === null) {",
    "      try {",
    "        const d = a.triggerDate();",
    '        if (d && typeof d.getTime === "function") t = d.getTime();',
    "      } catch (e2) {}",
    "    }",
    "    if (t !== null) alarmTimes.push(t);",
    "  }",
    "}",
    "alarmTimes.sort(function (a, b) { return a - b; });",
    "return JSON.stringify({",
    "  ok: true,",
    "  event: {",
    "    calendar: targetCal.name(),",
    "    uid: String(p.uid),",
    "    title: p.summary,",
    "    startMs: startMs,",
    "    endMs: p.endDate.getTime(),",
    "    allDay: p.alldayEvent === true,",
    "    hasAlarm: alarmCount > 0,",
    "    alarmTimes: alarmTimes,",
    '    location: p.location === null || p.location === undefined ? "" : String(p.location),',
    '    notes: p.description === null || p.description === undefined ? "" : String(p.description),',
    '    isRecurring: !(p.recurrence === null || p.recurrence === undefined || p.recurrence === ""),',
    "  },",
    "});"
  ].join("\n");
  return wrapper(body);
}
function createEventScript(input) {
  const body = [
    `const CAL = ${js(input.calendar)};`,
    `const TITLE = ${js(input.title)};`,
    `const NOTES = ${input.notes === void 0 ? "null" : js(input.notes)};`,
    `const LOCATION = ${input.location === void 0 ? "null" : js(input.location)};`,
    `const ALLDAY = ${input.allDay ? "true" : "false"};`,
    `const START = new Date(${Math.trunc(input.startMs)});`,
    `const END = new Date(${Math.trunc(input.endMs)});`,
    `const ALARMS = ${jsMinuteArray(input.alarmMinutes)};`,
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
    "if (ALLDAY) props.alldayEvent = true;",
    "if (NOTES !== null) props.description = NOTES;",
    "if (LOCATION !== null) props.location = LOCATION;",
    "const ev = app.Event(props);",
    "cal.events.push(ev);",
    "for (const m of ALARMS) ev.displayAlarms.push(app.DisplayAlarm({ triggerInterval: -m }));",
    "return JSON.stringify({",
    "  ok: true,",
    "  calendar: cal.name(),",
    "  uid: String(ev.uid()),",
    "  title: ev.summary(),",
    "  startMs: ev.startDate().getTime(),",
    "  endMs: ev.endDate().getTime(),",
    "  allDay: ev.alldayEvent() === true,",
    '  location: LOCATION === null ? "" : String(ev.location() || ""),',
    "  alarmCount: ev.displayAlarms().length,",
    "});"
  ].join("\n");
  return wrapper(body);
}
function updateEventScript(input) {
  const body = [
    `const UID = ${js(input.uid)};`,
    `const NEW_TITLE = ${input.title === void 0 ? "null" : js(input.title)};`,
    `const NEW_NOTES = ${input.notes === void 0 ? "null" : js(input.notes)};`,
    `const NEW_LOCATION = ${input.location === void 0 ? "null" : js(input.location)};`,
    `const NEW_START = ${input.startMs === void 0 ? "null" : String(Math.trunc(input.startMs))};`,
    `const NEW_END = ${input.endMs === void 0 ? "null" : String(Math.trunc(input.endMs))};`,
    `const NEW_ALARMS = ${input.alarmMinutes === void 0 ? "null" : jsMinuteArray(input.alarmMinutes)};`,
    'const app = Application("Calendar");',
    "let target = null;",
    "let targetCal = null;",
    "for (const cal of app.calendars()) {",
    "  const hits = cal.events.whose({ uid: UID })();",
    "  if (hits.length > 0) { target = hits[0]; targetCal = cal; break; }",
    "}",
    "if (target === null) {",
    '  return JSON.stringify({ ok: false, code: "no-event", error: "\u672A\u627E\u5230 uid \u4E3A " + UID + " \u7684\u65E5\u7A0B\uFF08\u53EF\u80FD\u5DF2\u88AB\u5220\u9664\uFF0C\u6216\u4E0D\u5728\u672C\u673A\u65E5\u5386\u4E2D\uFF09" });',
    "}",
    "if (NEW_TITLE !== null) target.summary = NEW_TITLE;",
    "if (NEW_NOTES !== null) target.description = NEW_NOTES;",
    "if (NEW_LOCATION !== null) target.location = NEW_LOCATION;",
    "if (NEW_START !== null) target.startDate = new Date(NEW_START);",
    "if (NEW_END !== null) target.endDate = new Date(NEW_END);",
    "let recreated = false;",
    "let current = target;",
    "if (NEW_ALARMS !== null) {",
    "  const existing = target.displayAlarms();",
    "  if (NEW_ALARMS.length >= existing.length) {",
    "    for (let i = 0; i < existing.length; i++) existing[i].triggerInterval = -NEW_ALARMS[i];",
    "    for (let i = existing.length; i < NEW_ALARMS.length; i++) {",
    "      target.displayAlarms.push(app.DisplayAlarm({ triggerInterval: -NEW_ALARMS[i] }));",
    "    }",
    "  } else {",
    "    const title = NEW_TITLE !== null ? NEW_TITLE : target.summary();",
    "    const startMs = NEW_START !== null ? NEW_START : target.startDate().getTime();",
    "    const endMs = NEW_END !== null ? NEW_END : target.endDate().getTime();",
    '    let notes = "";',
    '    try { notes = String(target.description() || ""); } catch (e1) { notes = ""; }',
    "    if (NEW_NOTES !== null) notes = NEW_NOTES;",
    '    let location = "";',
    '    try { location = String(target.location() || ""); } catch (e2) { location = ""; }',
    "    if (NEW_LOCATION !== null) location = NEW_LOCATION;",
    "    const isAllDay = target.alldayEvent() === true;",
    "    app.delete(target);",
    "    const props = { summary: title, startDate: new Date(startMs), endDate: new Date(endMs) };",
    "    if (isAllDay) props.alldayEvent = true;",
    '    if (notes !== "") props.description = notes;',
    '    if (location !== "") props.location = location;',
    "    const ev = app.Event(props);",
    "    targetCal.events.push(ev);",
    "    for (const m of NEW_ALARMS) ev.displayAlarms.push(app.DisplayAlarm({ triggerInterval: -m }));",
    "    current = ev;",
    "    recreated = true;",
    "  }",
    "}",
    "return JSON.stringify({",
    "  ok: true,",
    "  uid: String(current.uid()),",
    "  recreated: recreated,",
    "  calendar: targetCal.name(),",
    "  title: current.summary(),",
    "  startMs: current.startDate().getTime(),",
    "  endMs: current.endDate().getTime(),",
    "  allDay: current.alldayEvent() === true,",
    '  location: String(current.location() || ""),',
    '  notes: String(current.description() || ""),',
    "  alarmCount: current.displayAlarms().length,",
    "});"
  ].join("\n");
  return wrapper(body);
}
function deleteEventScript(input) {
  const body = [
    `const UID = ${js(input.uid)};`,
    `const CONFIRM = ${input.confirm ? "true" : "false"};`,
    "if (CONFIRM !== true) {",
    '  return JSON.stringify({ ok: false, code: "confirm-required", error: "\u5220\u9664\u65E5\u7A0B\u9700\u8981\u660E\u786E\u786E\u8BA4\uFF1A\u8BF7\u8BA9\u5F8B\u5E08\u786E\u8BA4\u540E\u4EE5 confirm=true \u91CD\u8BD5" });',
    "}",
    'const app = Application("Calendar");',
    "let target = null;",
    "let targetCal = null;",
    "for (const cal of app.calendars()) {",
    "  const hits = cal.events.whose({ uid: UID })();",
    "  if (hits.length > 0) { target = hits[0]; targetCal = cal; break; }",
    "}",
    "if (target === null) {",
    '  return JSON.stringify({ ok: false, code: "no-event", error: "\u672A\u627E\u5230 uid \u4E3A " + UID + " \u7684\u65E5\u7A0B\uFF08\u53EF\u80FD\u5DF2\u88AB\u5220\u9664\uFF0C\u6216\u4E0D\u5728\u672C\u673A\u65E5\u5386\u4E2D\uFF09" });',
    "}",
    "const title = target.summary();",
    "const startMs = target.startDate().getTime();",
    "const endMs = target.endDate().getTime();",
    "const calendar = targetCal.name();",
    "app.delete(target);",
    "let remaining = 0;",
    "for (const cal of app.calendars()) remaining += cal.events.whose({ uid: UID })().length;",
    "return JSON.stringify({ ok: true, uid: UID, calendar: calendar, title: title, startMs: startMs, endMs: endMs, deleted: 1, remaining: remaining });"
  ].join("\n");
  return wrapper(body);
}
function createReminderScript(input) {
  const body = [
    `const LIST = ${js(input.listName ?? "\u5F8B\u5E08\u63D0\u9192")};`,
    `const TITLE = ${js(input.title)};`,
    `const NOTES = ${input.notes === void 0 ? "null" : js(input.notes)};`,
    `const DUE_MS = ${input.dueMs === void 0 ? "null" : String(Math.trunc(input.dueMs))};`,
    'const app = Application("Reminders");',
    "let found = app.lists.whose({ name: LIST });",
    "if (found.length === 0) {",
    "  app.lists.push(app.List({ name: LIST }));",
    "  found = app.lists.whose({ name: LIST });",
    "}",
    "if (found.length === 0) {",
    '  return JSON.stringify({ ok: false, code: "no-list", error: "\u65E0\u6CD5\u5728\u63D0\u9192\u4E8B\u9879\u4E2D\u521B\u5EFA\u5217\u8868\u300A" + LIST + "\u300B" });',
    "}",
    "const list = found[0];",
    "const props = { name: TITLE };",
    "if (NOTES !== null) props.body = NOTES;",
    // dueDate 只控制显示与排序，不触发通知；remindMeDate 才是「提醒我」时刻（触发系统通知）。
    // v0.3.1 前只写 dueDate：列表里到期不响铃（真机验证 remindMeDate 读回为 null）。
    "if (DUE_MS !== null) {",
    "  props.dueDate = new Date(DUE_MS);",
    "  props.remindMeDate = new Date(DUE_MS);",
    "}",
    "const rem = app.Reminder(props);",
    "list.reminders.push(rem);",
    "let dueMs = null;",
    'try { const d = rem.dueDate(); if (d && typeof d.getTime === "function") dueMs = d.getTime(); } catch (e) {}',
    "let remindMs = null;",
    'try { const d2 = rem.remindMeDate(); if (d2 && typeof d2.getTime === "function") remindMs = d2.getTime(); } catch (e2) {}',
    "return JSON.stringify({",
    "  ok: true,",
    "  id: String(rem.id()),",
    "  title: rem.name(),",
    "  list: list.name(),",
    "  dueMs: dueMs,",
    "  remindMs: remindMs,",
    "});"
  ].join("\n");
  return wrapper(body);
}

// src/logic.ts
var MAX_DRAFTS = 100;
var MAX_TITLE_LENGTH = 200;
var MAX_NOTES_LENGTH = 2e3;
var MAX_LOCATION_LENGTH = 200;
var MAX_CALENDAR_NAME_LENGTH = 100;
var DEFAULT_ALARM_MINUTES = 15;
var MAX_ALARM_COUNT = 5;
var MAX_ALARM_MINUTES = 10080;
var MAX_EVENT_REGISTRY = 200;
var BEIJING_OFFSET_MS = 8 * 36e5;
var MIN_DAYS = 1;
var MAX_DAYS = 90;
var DEFAULT_DAYS = 7;
var MAX_EVENT_ROWS = 200;
var DAY_MS = 864e5;
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
var DRAFT_FIELDS = ["id", "title", "start", "end", "notes", "calendar", "location", "allDay", "alarmMinutes", "createdAt"];
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
    const startMs = fromBeijingNaive(entry.start);
    const endMs = fromBeijingNaive(entry.end);
    if (endMs < startMs || endMs === startMs && entry.allDay !== true) {
      throw new CalendarError(`\u8349\u7A3F #${entry.id} \u7684\u7ED3\u675F\u65F6\u95F4\u65E9\u4E8E\u5F00\u59CB\u65F6\u95F4`, "store");
    }
    if (entry.notes !== void 0 && (typeof entry.notes !== "string" || entry.notes.length > MAX_NOTES_LENGTH)) {
      throw new CalendarError(`\u8349\u7A3F #${entry.id} \u7684\u5907\u6CE8\u4E0D\u5408\u6CD5`, "store");
    }
    if (entry.calendar !== void 0 && (typeof entry.calendar !== "string" || !entry.calendar.trim() || entry.calendar.length > MAX_CALENDAR_NAME_LENGTH)) {
      throw new CalendarError(`\u8349\u7A3F #${entry.id} \u7684\u76EE\u6807\u65E5\u5386\u540D\u4E0D\u5408\u6CD5`, "store");
    }
    if (entry.location !== void 0 && (typeof entry.location !== "string" || entry.location.length > MAX_LOCATION_LENGTH)) {
      throw new CalendarError(`\u8349\u7A3F #${entry.id} \u7684\u5730\u70B9\u4E0D\u5408\u6CD5`, "store");
    }
    if (entry.allDay !== void 0 && entry.allDay !== true) {
      throw new CalendarError(`\u8349\u7A3F #${entry.id} \u7684 allDay \u53EA\u80FD\u662F true`, "store");
    }
    if (entry.alarmMinutes !== void 0) {
      try {
        normalizeAlarmMinutes(entry.alarmMinutes);
      } catch {
        throw new CalendarError(`\u8349\u7A3F #${entry.id} \u7684\u63D0\u9192\u5206\u949F\u6570\u4E0D\u5408\u6CD5`, "store");
      }
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
function normalizeLocation(value) {
  if (value === void 0 || value === null) return void 0;
  if (typeof value !== "string") throw new CalendarError("location \u5FC5\u987B\u662F\u5B57\u7B26\u4E32\uFF08\u5730\u70B9\uFF09", "args");
  const location = value.trim();
  if (!location) return void 0;
  if (location.length > MAX_LOCATION_LENGTH) throw new CalendarError(`\u5730\u70B9\u4E0D\u80FD\u8D85\u8FC7 ${MAX_LOCATION_LENGTH} \u5B57`, "args");
  return location;
}
function normalizeAlarmMinutes(value) {
  const list = Array.isArray(value) ? value : [value];
  const minutes = [];
  for (const entry of list) {
    let num;
    if (typeof entry === "number") num = entry;
    else if (typeof entry === "string" && /^-?\d+(\.\d+)?$/.test(entry.trim())) num = Number(entry.trim());
    else throw new CalendarError("alarmMinutes \u5FC5\u987B\u662F\u6574\u6570\u6570\u7EC4\uFF08\u63D0\u524D\u63D0\u9192\u7684\u5206\u949F\u6570\uFF0C\u5982 [10, 30]\uFF09", "args");
    if (!Number.isInteger(num) || Math.abs(num) > MAX_ALARM_MINUTES) {
      throw new CalendarError(`alarmMinutes \u6BCF\u9879\u5FC5\u987B\u662F 0\u2013${MAX_ALARM_MINUTES} \u7684\u6574\u6570\uFF08\u5206\u949F\uFF09`, "args");
    }
    const normalized = Math.abs(num);
    if (!minutes.includes(normalized)) minutes.push(normalized);
  }
  if (minutes.length > MAX_ALARM_COUNT) {
    throw new CalendarError(`\u4E00\u4E2A\u65E5\u7A0B\u6700\u591A\u8BBE ${MAX_ALARM_COUNT} \u4E2A\u63D0\u9192`, "args");
  }
  return minutes.sort((a, b) => a - b);
}
function normalizeUid(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new CalendarError("uid \u5FC5\u586B\uFF1A\u8981\u64CD\u4F5C\u7684\u65E5\u7A0B uid\uFF08\u6765\u81EA calendar_list \u7684 uid \u5B57\u6BB5\uFF09", "args");
  }
  const uid = value.trim();
  if (uid.length > 200) throw new CalendarError("uid \u8FC7\u957F\uFF08\u4E0D\u662F\u6709\u6548\u7684\u65E5\u5386 uid\uFF09", "args");
  return uid;
}
function createDraft(state, input, now = /* @__PURE__ */ new Date()) {
  const title = normalizeTitle(input?.title);
  let allDay = false;
  const rawAllDay = input?.allDay;
  if (rawAllDay !== void 0 && rawAllDay !== null && rawAllDay !== "" && rawAllDay !== false) {
    if (rawAllDay !== true) throw new CalendarError("allDay \u5FC5\u987B\u662F\u5E03\u5C14\u503C\uFF08true = \u5168\u5929\u65E5\u7A0B\uFF0C\u53EA\u6309\u65E5\u671F\uFF09", "args");
    allDay = true;
  }
  const parsedStartMs = parseEventTime(input?.start, "start\uFF08\u5F00\u59CB\u65F6\u95F4\uFF09");
  const parsedEndMs = parseEventTime(input?.end, "end\uFF08\u7ED3\u675F\u65F6\u95F4\uFF09");
  let start;
  let end;
  if (allDay) {
    const startDay = toBeijingNaive(parsedStartMs).slice(0, 10);
    const endDay = toBeijingNaive(parsedEndMs).slice(0, 10);
    if (fromBeijingNaive(`${endDay}T00:00:00`) < fromBeijingNaive(`${startDay}T00:00:00`)) {
      throw new CalendarError("\u5168\u5929\u65E5\u7A0B\u7684\u7ED3\u675F\u65E5\u671F\u4E0D\u80FD\u65E9\u4E8E\u5F00\u59CB\u65E5\u671F", "args");
    }
    start = `${startDay}T00:00:00`;
    end = `${endDay}T00:00:00`;
  } else {
    if (parsedEndMs <= parsedStartMs) throw new CalendarError("\u7ED3\u675F\u65F6\u95F4\u5FC5\u987B\u665A\u4E8E\u5F00\u59CB\u65F6\u95F4", "args");
    start = toBeijingNaive(parsedStartMs);
    end = toBeijingNaive(parsedEndMs);
  }
  const notes = normalizeNotes(input?.notes);
  const calendar = normalizeCalendarName(input?.calendar);
  const location = normalizeLocation(input?.location);
  const alarmMinutes = input?.alarmMinutes === void 0 || input?.alarmMinutes === null ? void 0 : normalizeAlarmMinutes(input?.alarmMinutes);
  if (state.items.length >= MAX_DRAFTS) throw new CalendarError(`\u5F85\u786E\u8BA4\u8349\u7A3F\u6700\u591A ${MAX_DRAFTS} \u6761\uFF0C\u8BF7\u5148\u786E\u8BA4\u6216\u4E22\u5F03\u73B0\u6709\u8349\u7A3F`, "args");
  const item = {
    id: state.nextId,
    title,
    start,
    end,
    createdAt: now.toISOString()
  };
  if (notes !== void 0) item.notes = notes;
  if (calendar !== void 0) item.calendar = calendar;
  if (location !== void 0) item.location = location;
  if (allDay) item.allDay = true;
  if (alarmMinutes !== void 0) item.alarmMinutes = [...alarmMinutes];
  return { state: { nextId: state.nextId + 1, items: [...state.items, item] }, item: cloneDraft(item) };
}
function draftEventRange(item) {
  const startMs = fromBeijingNaive(item.start);
  const endMs = fromBeijingNaive(item.end);
  if (item.allDay === true) return { startMs, endMs: Math.max(endMs, startMs) + DAY_MS };
  return { startMs, endMs };
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
function truncateText(text, max = 60) {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}\u2026`;
}
function formatAlarmTrigger(alarmMs, eventStartMs) {
  const a = partsOf(alarmMs);
  const s = partsOf(eventStartMs);
  const sameDay = a.y === s.y && a.mo === s.mo && a.d === s.d;
  return sameDay ? formatTime(alarmMs) : `${pad2(a.mo)}-${pad2(a.d)} ${formatTime(alarmMs)}`;
}
function renderEvent(event) {
  const s = partsOf(event.startMs);
  const when = event.allDay ? `${pad2(s.mo)}-${pad2(s.d)}\uFF08${s.weekday}\uFF09\u5168\u5929` : formatRange(event.startMs, event.endMs);
  const parts = [
    `- ${when} \xB7 ${event.title}`,
    event.location ? `\u5730\u70B9\uFF1A${event.location}` : "",
    `\u65E5\u5386\u300A${event.calendar}\u300B`,
    event.alarmTimes.length > 0 ? `\u63D0\u9192 ${event.alarmTimes.map((ms) => formatAlarmTrigger(ms, event.startMs)).join("\u3001")}` : event.hasAlarm ? "\u6709\u63D0\u9192" : "\u65E0\u63D0\u9192",
    event.isRecurring ? "\u91CD\u590D\u65E5\u7A0B" : "",
    event.notes ? `\u5907\u6CE8\uFF1A${truncateText(event.notes)}` : "",
    event.uid ? `uid\uFF1A${event.uid}` : ""
  ];
  return parts.filter(Boolean).join(" \xB7 ");
}
function renderEventList(input) {
  const window = `${formatDateTime(input.fromMs)} \uFF5E ${formatDateTime(input.toMs)}`;
  if (!input.total) return `\u672A\u6765 ${input.days} \u5929\uFF08${window}\uFF0C\u5317\u4EAC\u65F6\u95F4\uFF09\u6CA1\u6709\u65E5\u7A0B\u3002`;
  const lines = [
    `\u672A\u6765 ${input.days} \u5929\uFF08${window}\uFF0C\u5317\u4EAC\u65F6\u95F4\uFF0C\u542B\u8FDB\u884C\u4E2D/\u8DE8\u7A97\u65E5\u7A0B\uFF09\u5171 ${input.total} \u6761\u65E5\u7A0B\uFF1A`,
    ...input.events.map(renderEvent)
  ];
  if (input.truncated) {
    lines.push(`\uFF08\u65E5\u7A0B\u8F83\u591A\uFF0C\u4EC5\u663E\u793A\u524D ${input.events.length} \u6761\uFF1B\u53EF\u7528 calendar \u53C2\u6570\u6307\u5B9A\u5355\u4E2A\u65E5\u5386\u7F29\u5C0F\u8303\u56F4\uFF09`);
  }
  lines.push("\uFF08\u6BCF\u6761\u65E5\u7A0B\u7684 uid \u53EF\u7528\u4E8E calendar_update \u4FEE\u6539\u6807\u9898/\u65F6\u95F4/\u5730\u70B9/\u5907\u6CE8/\u63D0\u9192\uFF0C\u6216 calendar_delete \u5220\u9664\u2014\u2014\u5220\u9664\u5FC5\u987B\u5F8B\u5E08\u786E\u8BA4\u540E\u4EE5 confirm=true \u6267\u884C\uFF09");
  return lines.join("\n");
}
function formatDraftWhen(item) {
  const startMs = fromBeijingNaive(item.start);
  const endMs = fromBeijingNaive(item.end);
  if (item.allDay === true) {
    const s = partsOf(startMs);
    const sameDay = toBeijingNaive(startMs).slice(0, 10) === toBeijingNaive(endMs).slice(0, 10);
    if (sameDay) return `${pad2(s.mo)}-${pad2(s.d)}\uFF08${s.weekday}\uFF09\u5168\u5929`;
    return `${pad2(s.mo)}-${pad2(s.d)}\uFF08${s.weekday}\uFF09\uFF5E${formatDate(endMs)} \u5168\u5929`;
  }
  return formatRange(startMs, endMs);
}
function formatDraftAlarms(item) {
  if (item.alarmMinutes === void 0) return `\u63D0\u524D ${DEFAULT_ALARM_MINUTES} \u5206\u949F\u63D0\u9192\uFF08\u9ED8\u8BA4\uFF09`;
  if (item.alarmMinutes.length === 0) return "\u4E0D\u8BBE\u63D0\u9192";
  return `\u63D0\u524D ${item.alarmMinutes.join("\u3001")} \u5206\u949F\u63D0\u9192`;
}
function renderDraftLine(item) {
  const target = item.calendar ? `\u5199\u5165\u65E5\u5386\u300A${item.calendar}\u300B` : "\u5199\u5165\u9ED8\u8BA4\u65E5\u5386\uFF08\u4E2A\u4EBA/\u7B2C\u4E00\u4E2A\u672C\u5730\u65E5\u5386\uFF09";
  const parts = [
    `#${item.id} ${item.title}`,
    formatDraftWhen(item),
    target,
    item.location ? `\u5730\u70B9\uFF1A${item.location}` : "",
    formatDraftAlarms(item),
    item.notes ? `\u5907\u6CE8\uFF1A${item.notes}` : ""
  ];
  return `- ${parts.filter(Boolean).join(" \xB7 ")}`;
}
function renderDraftList(items) {
  if (!items.length) return "\u5F53\u524D\u6CA1\u6709\u5F85\u786E\u8BA4\u7684\u65E5\u7A0B\u8349\u7A3F\u3002\u8BA9 AI \u7528 calendar_propose \u8D77\u8349\uFF0C\u786E\u8BA4\u540E\u624D\u4F1A\u5199\u5165\u65E5\u5386\u3002";
  return [
    `\u5F53\u524D\u6709 ${items.length} \u6761\u5F85\u786E\u8BA4\u8349\u7A3F\uFF08\u5C1A\u672A\u5199\u5165\u65E5\u5386\uFF0C\u5F8B\u5E08\u786E\u8BA4\u540E\u624D\u4F1A\u6DFB\u52A0\uFF09\uFF1A`,
    ...items.map(renderDraftLine)
  ].join("\n");
}
function renderDraftCreated(item) {
  const target = item.calendar ? `\u65E5\u5386\u300A${item.calendar}\u300B` : "\u9ED8\u8BA4\u65E5\u5386\uFF08\u4E2A\u4EBA/\u7B2C\u4E00\u4E2A\u672C\u5730\u65E5\u5386\uFF09";
  const extras = [
    `${formatDraftWhen(item)}\uFF0C\u5317\u4EAC\u65F6\u95F4`,
    formatDraftAlarms(item),
    item.location ? `\u5730\u70B9\uFF1A${item.location}` : ""
  ].filter(Boolean).join("\uFF0C");
  return [
    `\u5DF2\u751F\u6210\u5F85\u786E\u8BA4\u8349\u7A3F #${item.id}\uFF1A${item.title}\uFF08${extras}\uFF09\uFF0C\u8BA1\u5212\u5199\u5165${target}\u3002`,
    '\u8FD9\u53EA\u662F\u8349\u7A3F\uFF0C\u8FD8\u6CA1\u6709\u5199\u5165\u65E5\u5386.app\u2014\u2014\u8BF7\u5F8B\u5E08\u6838\u5BF9\u65F6\u95F4\u540E\u786E\u8BA4\uFF1A\u56DE\u590D"\u786E\u8BA4\u8349\u7A3F ' + item.id + '"\uFF08calendar_confirm draft_id=' + item.id + "\uFF09\uFF0C\u6216\u5728\u8BBE\u7F6E\u9875\u300C\u5F8B\u5E08\u65E5\u5386\u300D/\u53F3\u4FA7\u300C\u65E5\u5386\u300D\u9762\u677F\u4E2D\u70B9\u51FB\u786E\u8BA4\uFF1B\u5982\u9700\u4FEE\u6539\uFF0C\u8BA9 AI \u91CD\u65B0\u8D77\u8349\u5E76\u4E22\u5F03\u672C\u6761\u3002"
  ].join("\n");
}
function renderConfirmed(item, calendarName, uid = "", alarmMinutes = [DEFAULT_ALARM_MINUTES]) {
  const alarmText = alarmMinutes.length === 0 ? "\u672A\u8BBE\u63D0\u9192" : `\u5DF2\u8BBE\u63D0\u524D ${alarmMinutes.join("\u3001")} \u5206\u949F\u63D0\u9192`;
  const uidText = uid ? `\uFF08uid\uFF1A${uid}\uFF0C\u540E\u7EED\u53EF\u7528 calendar_update \u4FEE\u6539\u3001calendar_delete \u5220\u9664\uFF09` : "";
  return `\u5DF2\u6DFB\u52A0\u5230\u65E5\u5386\u300A${calendarName}\u300B\uFF1A${item.title}\uFF08${formatDraftWhen(item)}\uFF0C\u5317\u4EAC\u65F6\u95F4\uFF0C${alarmText}\uFF09${uidText}\u53EF\u5728\u65E5\u5386.app \u6216 iPhone \u65E5\u5386\u4E2D\u67E5\u770B\u3002`;
}
function renderUpdated(result, changed) {
  const when = result.allDay ? `${formatRange(result.startMs, result.endMs)} \u5168\u5929` : formatRange(result.startMs, result.endMs);
  const changedText = changed.length ? `\uFF08\u5DF2\u6539\uFF1A${changed.join("\u3001")}\uFF09` : "";
  const recreatedText = result.recreated ? "\u3002\u6CE8\u610F\uFF1A\u63D0\u9192\u6570\u91CF\u51CF\u5C11\u65E0\u6CD5\u539F\u4F4D\u4FEE\u6539\uFF0C\u65E5\u7A0B\u5DF2\u6309\u65B0\u5B57\u6BB5\u91CD\u5EFA\uFF0C\u65E7 uid \u5DF2\u5931\u6548" : "";
  return `\u5DF2\u66F4\u65B0\u65E5\u5386\u300A${result.calendar}\u300B\u7684\u65E5\u7A0B\uFF1A${result.title}\uFF08${when}\uFF0C\u5317\u4EAC\u65F6\u95F4\uFF0C\u63D0\u9192 ${result.alarmCount} \u4E2A\uFF09${changedText}${recreatedText}\u3002uid\uFF1A${result.uid}`;
}
function renderDeleted(result) {
  return `\u5DF2\u4ECE\u65E5\u5386\u300A${result.calendar}\u300B\u5220\u9664\u65E5\u7A0B\uFF1A${result.title}\uFF08${formatRange(result.startMs, result.endMs)}\uFF0C\u5317\u4EAC\u65F6\u95F4\uFF09\u3002`;
}
function emptyRegistry() {
  return { items: [] };
}
var REGISTRY_STAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
function parseRegistry(value) {
  if (!isRecord(value) || !Array.isArray(value.items)) return emptyRegistry();
  const seen = /* @__PURE__ */ new Set();
  const items = [];
  for (const entry of value.items) {
    if (!isRecord(entry)) continue;
    const uid = typeof entry.uid === "string" ? entry.uid.trim() : "";
    const title = typeof entry.title === "string" ? entry.title : "";
    const start = typeof entry.start === "string" ? entry.start : "";
    const end = typeof entry.end === "string" ? entry.end : "";
    const calendar = typeof entry.calendar === "string" ? entry.calendar : "";
    const createdAt = typeof entry.createdAt === "string" ? entry.createdAt : "";
    if (!uid || !title || !REGISTRY_STAMP_RE.test(start) || !REGISTRY_STAMP_RE.test(end) || !calendar || !Number.isFinite(Date.parse(createdAt))) continue;
    if (seen.has(uid)) continue;
    seen.add(uid);
    items.push({ uid, title, start, end, calendar, createdAt });
  }
  return { items: items.slice(0, MAX_EVENT_REGISTRY) };
}
function registryUpsert(registry, entry) {
  const rest = registry.items.filter((row) => row.uid !== entry.uid);
  return { items: [entry, ...rest].slice(0, MAX_EVENT_REGISTRY) };
}
function registryRemove(registry, uid) {
  return { items: registry.items.filter((row) => row.uid !== uid) };
}

// src/apple.ts
var OSASCRIPT_TIMEOUT_MS = 3e4;
var OPEN_TIMEOUT_MS = 15e3;
var DEFAULT_QUEUE_MAX_WAIT_MS = 2e4;
var DELETE_CONFIRM_REQUIRED_MESSAGE = "\u5220\u9664\u65E5\u7A0B\u9700\u8981\u660E\u786E\u786E\u8BA4\uFF1A\u8BF7\u8BA9\u5F8B\u5E08\u786E\u8BA4\u540E\u4EE5 confirm=true \u91CD\u8BD5";
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
    if (code === "no-event") throw new CalendarError(`${message}\u3002\u53EF\u5148\u7528 calendar_list \u67E5\u6700\u65B0\u65E5\u7A0B\u4E0E uid\u3002`, "calendar");
    if (code === "confirm-required") throw new CalendarError(message, "args");
    if (isAutomationDenied(message)) throw automationHint(op, message);
    throw new CalendarError(`\u65E5\u5386.app \u64CD\u4F5C\u5931\u8D25\uFF08${op}\uFF09\uFF1A${message}`, "calendar");
  }
  return payload;
}
function remindersAutomationHint(op, detail) {
  return new CalendarError(
    `\u65E0\u6CD5\u8BBF\u95EE macOS\u300C\u63D0\u9192\u4E8B\u9879\u300DApp\uFF08${op}\u5931\u8D25\uFF09\uFF1A\u8BF7\u5728 \u7CFB\u7EDF\u8BBE\u7F6E \u2192 \u9690\u79C1\u4E0E\u5B89\u5168\u6027 \u2192 \u81EA\u52A8\u5316 \u4E2D\uFF0C\u5141\u8BB8 LawyerCopilot \u63A7\u5236\u300C\u63D0\u9192\u4E8B\u9879\u300D\uFF0C\u7136\u540E\u91CD\u8BD5\u3002\u82E5\u5217\u8868\u91CC\u6CA1\u6709\u8BE5\u9879\uFF0C\u5148\u91CD\u542F LawyerCopilot \u5E76\u5728\u5F39\u7A97\u4E2D\u70B9\u300C\u597D\u300D\u3002\uFF08\u539F\u59CB\u9519\u8BEF\uFF1A${detail || "\u65E0\u8F93\u51FA"}\uFF09`,
    "bridge"
  );
}
async function runRemindersJxa(bridge, op, script) {
  const result = await execRun(bridge, "osascript", ["-l", "JavaScript", "-e", script], OSASCRIPT_TIMEOUT_MS);
  const output = (result.stdout ?? "").trim();
  if (result.code !== 0 || !output) {
    const detail = firstLine(result.stderr || result.stdout);
    if (result.code !== 0 && isAutomationDenied(detail)) throw remindersAutomationHint(op, detail);
    throw new CalendarError(`\u63D0\u9192\u4E8B\u9879.app \u64CD\u4F5C\u5931\u8D25\uFF08${op}\uFF0C\u9000\u51FA\u7801 ${result.code}\uFF09\uFF1A${detail || "\u65E0\u8F93\u51FA"}`, "calendar");
  }
  let payload;
  try {
    payload = JSON.parse(output);
  } catch {
    const detail = firstLine(result.stderr || output);
    if (isAutomationDenied(detail)) throw remindersAutomationHint(op, detail);
    throw new CalendarError(`\u63D0\u9192\u4E8B\u9879.app \u8FD4\u56DE\u4E86\u65E0\u6CD5\u89E3\u6790\u7684\u7ED3\u679C\uFF08${op}\uFF09\uFF1A${detail}`, "calendar");
  }
  if (!isRecord2(payload)) throw new CalendarError(`\u63D0\u9192\u4E8B\u9879.app \u8FD4\u56DE\u4E86\u65E0\u6CD5\u89E3\u6790\u7684\u7ED3\u679C\uFF08${op}\uFF09`, "calendar");
  if (payload.ok !== true) {
    const message = typeof payload.error === "string" && payload.error.trim() ? payload.error.trim() : "\u672A\u77E5\u9519\u8BEF";
    if (isAutomationDenied(message)) throw remindersAutomationHint(op, message);
    throw new CalendarError(`\u63D0\u9192\u4E8B\u9879.app \u64CD\u4F5C\u5931\u8D25\uFF08${op}\uFF09\uFF1A${message}`, "calendar");
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
function asNumberArray(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((entry) => typeof entry === "number" && Number.isFinite(entry));
}
function parseEventRow(entry) {
  if (!isRecord2(entry)) return null;
  const startMs = asNumber(entry.startMs);
  const endMs = asNumber(entry.endMs);
  const title = asString(entry.title);
  const calendar = asString(entry.calendar);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || !title || !calendar) return null;
  return {
    calendar,
    uid: asString(entry.uid).trim(),
    title,
    startMs,
    endMs,
    allDay: asBoolean(entry.allDay),
    hasAlarm: asBoolean(entry.hasAlarm),
    alarmTimes: asNumberArray(entry.alarmTimes),
    location: asString(entry.location).trim(),
    notes: asString(entry.notes),
    isRecurring: asBoolean(entry.isRecurring)
  };
}
function normalizeCalendarColor(raw) {
  const parts = raw.split(",").map((part) => Number(part.trim()));
  if (parts.length < 3 || parts.some((part) => !Number.isFinite(part) || part < 0 || part > 1)) return "";
  const hex = parts.slice(0, 3).map((part) => Math.round(part * 255).toString(16).padStart(2, "0")).join("");
  return `#${hex.toUpperCase()}`;
}
function createAppleCalendar(bridge, options = {}) {
  const queueMaxWaitMs = options.queueMaxWaitMs ?? DEFAULT_QUEUE_MAX_WAIT_MS;
  let chain = Promise.resolve();
  function enqueue(op, task) {
    const queuedAt = Date.now();
    const run = chain.then(async () => {
      const waitedMs = Date.now() - queuedAt;
      if (waitedMs > queueMaxWaitMs) {
        throw new CalendarError(
          `\u65E5\u5386.app \u64CD\u4F5C\uFF08${op}\uFF09\u6392\u961F\u7B49\u5F85 ${(waitedMs / 1e3).toFixed(1)} \u79D2\uFF0C\u8D85\u8FC7 ${(queueMaxWaitMs / 1e3).toFixed(1)} \u79D2\u4E0A\u9650\uFF0C\u5DF2\u88AB\u53D6\u6D88\uFF1A\u672C\u6B21\u64CD\u4F5C\u672A\u6267\u884C\u3002\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002`,
          "bridge"
        );
      }
      return task();
    });
    chain = run.then(
      () => void 0,
      () => void 0
    );
    return run;
  }
  return {
    async listCalendars() {
      const payload = await enqueue("\u8BFB\u53D6\u65E5\u5386\u5217\u8868", () => runJxa(bridge, "\u8BFB\u53D6\u65E5\u5386\u5217\u8868", listCalendarsScript()));
      const calendars = payload.calendars;
      if (!Array.isArray(calendars)) throw new CalendarError("\u65E5\u5386.app \u8FD4\u56DE\u7684\u65E5\u5386\u5217\u8868\u683C\u5F0F\u4E0D\u6B63\u786E", "calendar");
      return calendars.filter(isRecord2).map((row) => ({
        name: asString(row.name),
        writable: asBoolean(row.writable),
        color: normalizeCalendarColor(asString(row.color))
      })).filter((row) => row.name !== "");
    },
    async listEvents(input) {
      const payload = await enqueue(
        "\u67E5\u8BE2\u65E5\u7A0B",
        () => runJxa(
          bridge,
          "\u67E5\u8BE2\u65E5\u7A0B",
          listEventsScript({
            calendar: input.calendar,
            fromMs: input.fromMs,
            toMs: input.toMs,
            maxRows: input.maxRows,
            light: input.light === true
          })
        )
      );
      const events = payload.events;
      if (!Array.isArray(events)) throw new CalendarError("\u65E5\u5386.app \u8FD4\u56DE\u7684\u65E5\u7A0B\u5217\u8868\u683C\u5F0F\u4E0D\u6B63\u786E", "calendar");
      const rows = [];
      for (const entry of events) {
        const row = parseEventRow(entry);
        if (row !== null) rows.push(row);
      }
      return {
        total: asNumber(payload.total) || rows.length,
        truncated: asBoolean(payload.truncated),
        events: rows,
        alarmsRead: input.light !== true
      };
    },
    async eventDetail(uid) {
      const payload = await enqueue("\u8BFB\u53D6\u65E5\u7A0B\u8BE6\u60C5", () => runJxa(bridge, "\u8BFB\u53D6\u65E5\u7A0B\u8BE6\u60C5", eventDetailScript({ uid })));
      const row = parseEventRow(payload.event);
      if (row === null) throw new CalendarError("\u65E5\u5386.app \u8FD4\u56DE\u7684\u65E5\u7A0B\u8BE6\u60C5\u683C\u5F0F\u4E0D\u6B63\u786E", "calendar");
      return row;
    },
    async createEvent(input) {
      const payload = await enqueue(
        "\u5199\u5165\u65E5\u7A0B",
        () => runJxa(
          bridge,
          "\u5199\u5165\u65E5\u7A0B",
          createEventScript({
            calendar: input.calendar,
            title: input.title,
            notes: input.notes,
            location: input.location,
            startMs: input.startMs,
            endMs: input.endMs,
            allDay: input.allDay,
            alarmMinutes: input.alarmMinutes
          })
        )
      );
      const startMs = asNumber(payload.startMs);
      const endMs = asNumber(payload.endMs);
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
        throw new CalendarError("\u65E5\u7A0B\u5DF2\u5199\u5165\uFF0C\u4F46\u65E5\u5386.app \u672A\u8FD4\u56DE\u53EF\u6821\u9A8C\u7684\u65F6\u95F4\uFF1B\u8BF7\u5230\u65E5\u5386.app \u6838\u5BF9\u3002", "calendar");
      }
      return {
        calendar: asString(payload.calendar, input.calendar),
        uid: asString(payload.uid).trim(),
        title: asString(payload.title, input.title),
        startMs,
        endMs,
        allDay: asBoolean(payload.allDay),
        location: asString(payload.location),
        alarmCount: asNumber(payload.alarmCount)
      };
    },
    async updateEvent(input) {
      const payload = await enqueue(
        "\u4FEE\u6539\u65E5\u7A0B",
        () => runJxa(
          bridge,
          "\u4FEE\u6539\u65E5\u7A0B",
          updateEventScript({
            uid: input.uid,
            title: input.title,
            notes: input.notes,
            location: input.location,
            startMs: input.startMs,
            endMs: input.endMs,
            alarmMinutes: input.alarmMinutes
          })
        )
      );
      const startMs = asNumber(payload.startMs);
      const endMs = asNumber(payload.endMs);
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
        throw new CalendarError("\u65E5\u7A0B\u5DF2\u4FEE\u6539\uFF0C\u4F46\u65E5\u5386.app \u672A\u8FD4\u56DE\u53EF\u6821\u9A8C\u7684\u65F6\u95F4\uFF1B\u8BF7\u5230\u65E5\u5386.app \u6838\u5BF9\u3002", "calendar");
      }
      return {
        uid: asString(payload.uid).trim(),
        recreated: asBoolean(payload.recreated),
        calendar: asString(payload.calendar),
        title: asString(payload.title),
        startMs,
        endMs,
        allDay: asBoolean(payload.allDay),
        location: asString(payload.location),
        notes: asString(payload.notes),
        alarmCount: asNumber(payload.alarmCount)
      };
    },
    async deleteEvent(input) {
      if (input.confirm !== true) throw new CalendarError(DELETE_CONFIRM_REQUIRED_MESSAGE, "args");
      const payload = await enqueue(
        "\u5220\u9664\u65E5\u7A0B",
        () => runJxa(
          bridge,
          "\u5220\u9664\u65E5\u7A0B",
          deleteEventScript({ uid: input.uid, confirm: true })
        )
      );
      return {
        uid: asString(payload.uid).trim(),
        calendar: asString(payload.calendar),
        title: asString(payload.title),
        startMs: asNumber(payload.startMs),
        endMs: asNumber(payload.endMs),
        deleted: asNumber(payload.deleted),
        remaining: asNumber(payload.remaining)
      };
    },
    async createReminder(input) {
      const payload = await runRemindersJxa(
        bridge,
        "\u521B\u5EFA\u63D0\u9192\u4E8B\u9879",
        createReminderScript({ title: input.title, notes: input.notes, dueMs: input.dueMs })
      );
      const id = asString(payload.id).trim();
      if (id === "") {
        throw new CalendarError("\u63D0\u9192\u4E8B\u9879\u5DF2\u63D0\u4EA4\uFF0C\u4F46\u65E0\u6CD5\u9A8C\u8BC1\u5199\u5165\u7ED3\u679C\uFF08\u672A\u8FD4\u56DE id\uFF09\uFF1A\u8BF7\u5230\u7CFB\u7EDF\u300C\u63D0\u9192\u4E8B\u9879\u300DApp \u6838\u5BF9\u540E\u518D\u91CD\u8BD5\u3002", "calendar");
      }
      const dueMs = asNumber(payload.dueMs);
      const remindMs = asNumber(payload.remindMs);
      if (input.dueMs !== void 0) {
        if (!Number.isFinite(dueMs)) {
          throw new CalendarError("\u63D0\u9192\u4E8B\u9879\u5DF2\u63D0\u4EA4\uFF0C\u4F46\u8BFB\u56DE\u7684\u5230\u671F\u65F6\u95F4\u4E3A\u7A7A\uFF1A\u5199\u5165\u53EF\u80FD\u672A\u751F\u6548\uFF0C\u8BF7\u5230\u7CFB\u7EDF\u300C\u63D0\u9192\u4E8B\u9879\u300DApp \u6838\u5BF9\u540E\u518D\u91CD\u8BD5\u3002", "calendar");
        }
        if (Math.abs(dueMs - input.dueMs) > 2e3) {
          throw new CalendarError(
            `\u63D0\u9192\u4E8B\u9879\u5DF2\u63D0\u4EA4\uFF0C\u4F46\u5230\u671F\u65F6\u95F4\u4E0E\u8BF7\u6C42\u504F\u5DEE\u8FC7\u5927\uFF08\u8BF7\u6C42 ${new Date(input.dueMs).toISOString()}\uFF0C\u5B9E\u9645 ${new Date(dueMs).toISOString()}\uFF09\uFF1A\u8BF7\u5230\u7CFB\u7EDF\u300C\u63D0\u9192\u4E8B\u9879\u300DApp \u6838\u5BF9\u540E\u518D\u91CD\u8BD5\u3002`,
            "calendar"
          );
        }
        if (!Number.isFinite(remindMs)) {
          throw new CalendarError("\u63D0\u9192\u4E8B\u9879\u5DF2\u63D0\u4EA4\uFF0C\u4F46\u8BFB\u56DE\u7684\u63D0\u9192\u65F6\u523B\uFF08remindMeDate\uFF09\u4E3A\u7A7A\uFF1A\u5230\u671F\u4E0D\u4F1A\u89E6\u53D1\u901A\u77E5\uFF0C\u8BF7\u5230\u7CFB\u7EDF\u300C\u63D0\u9192\u4E8B\u9879\u300DApp \u6838\u5BF9\u540E\u518D\u91CD\u8BD5\u3002", "calendar");
        }
        if (Math.abs(remindMs - input.dueMs) > 2e3) {
          throw new CalendarError(
            `\u63D0\u9192\u4E8B\u9879\u5DF2\u63D0\u4EA4\uFF0C\u4F46\u63D0\u9192\u65F6\u523B\u4E0E\u8BF7\u6C42\u504F\u5DEE\u8FC7\u5927\uFF08\u901A\u77E5\u4F1A\u5728\u9519\u8BEF\u7684\u65F6\u95F4\u54CD\uFF09\uFF1A\u8BF7\u5230\u7CFB\u7EDF\u300C\u63D0\u9192\u4E8B\u9879\u300DApp \u6838\u5BF9\u540E\u518D\u91CD\u8BD5\u3002`,
            "calendar"
          );
        }
      }
      return {
        id,
        title: asString(payload.title, input.title),
        list: asString(payload.list).trim(),
        dueMs: Number.isFinite(dueMs) ? dueMs : null,
        remindMs: Number.isFinite(remindMs) ? remindMs : null
      };
    }
  };
}

// src/month-logic.ts
function monthAnchorOf(ms) {
  const t = beijingWallClockParts(ms);
  return Date.UTC(t.y, t.mo - 1, 1) - 8 * 36e5;
}
function shiftMonth(anchorMs, delta) {
  const t = beijingWallClockParts(anchorMs);
  const iso = new Date(Date.UTC(t.y, t.mo - 1 + delta, 1)).toISOString();
  return Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, 1) - 8 * 36e5;
}
function monthTitle(anchorMs) {
  const t = beijingWallClockParts(anchorMs);
  return `${t.y}\u5E74${t.mo}\u6708`;
}
var WEEKDAY_NAMES = ["\u5468\u65E5", "\u5468\u4E00", "\u5468\u4E8C", "\u5468\u4E09", "\u5468\u56DB", "\u5468\u4E94", "\u5468\u516D"];
function weekdayIndexOf(dayStartMs) {
  const t = beijingWallClockParts(dayStartMs);
  return new Date(Date.UTC(t.y, t.mo - 1, t.d)).getUTCDay();
}
function fullDayLabel(dayStartMs) {
  const t = beijingWallClockParts(dayStartMs);
  return `${t.y}\u5E74${t.mo}\u6708${t.d}\u65E5 ${WEEKDAY_NAMES[weekdayIndexOf(dayStartMs)]}`;
}
function monthGrid(anchorMs, nowMs, events) {
  const today = beijingDayStart(nowMs);
  const firstOffset = weekdayIndexOf(anchorMs);
  const start = anchorMs - firstOffset * DAY_MS;
  const cells = [];
  for (let i = 0; i < 42; i++) {
    const dayStartMs = start + i * DAY_MS;
    const t = beijingWallClockParts(dayStartMs);
    cells.push({
      dayStartMs,
      day: t.d,
      inMonth: dayStartMs >= anchorMs && dayStartMs < shiftMonth(anchorMs, 1),
      isToday: dayStartMs === today,
      eventCount: eventsOnDay(events, dayStartMs).length
    });
  }
  return { anchorMs, title: monthTitle(anchorMs), cells };
}
function eventsOnDay(events, dayStartMs) {
  const dayEnd = dayStartMs + DAY_MS;
  return [...events].filter((event) => eventOverlapsWindow(event, dayStartMs, dayEnd)).sort((a, b) => a.startMs - b.startMs);
}
function aiArrangeDraft(dayStartMs) {
  return `\u8BF7\u5E2E\u6211\u5B89\u6392 ${fullDayLabel(dayStartMs)} \u8FD9\u4E00\u5929\u7684\u63D0\u9192\u4E8B\u9879\uFF1A`;
}
function reminderDraftCheck(input, dayStartMs) {
  const title = input.title.trim();
  if (title === "") return { ok: false, error: "\u8BF7\u586B\u5199\u63D0\u9192\u5185\u5BB9" };
  if (title.length > 200) return { ok: false, error: "\u63D0\u9192\u5185\u5BB9\u592A\u957F\uFF08\u6700\u591A 200 \u5B57\uFF09" };
  const time = input.time.trim();
  if (time === "") return { ok: true, dueMs: dayStartMs + 9 * 36e5 };
  const match = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (match === null) return { ok: false, error: "\u63D0\u9192\u65F6\u95F4\u7684\u683C\u5F0F\u5E94\u4E3A HH:mm\uFF0C\u4F8B\u5982 09:30" };
  const hh = Number(match[1]);
  const mi = Number(match[2]);
  if (hh > 23 || mi > 59) return { ok: false, error: "\u63D0\u9192\u65F6\u95F4\u4E0D\u771F\u5B9E\uFF08\u5C0F\u65F6 0\u201323\uFF0C\u5206\u949F 0\u201359\uFF09" };
  return { ok: true, dueMs: dayStartMs + (hh * 60 + mi) * 6e4 };
}

// src/panel.ts
function beijingWallClockParts(ms) {
  const iso = new Date(ms + 8 * 36e5).toISOString();
  return {
    y: Number(iso.slice(0, 4)),
    mo: Number(iso.slice(5, 7)),
    d: Number(iso.slice(8, 10)),
    hh: Number(iso.slice(11, 13)),
    mi: Number(iso.slice(14, 16))
  };
}
function beijingDayStart(ms) {
  const t = beijingWallClockParts(ms);
  return Date.UTC(t.y, t.mo - 1, t.d) - 8 * 36e5;
}
function eventOverlapsWindow(event, fromMs, toMs) {
  return event.startMs < toMs && event.endMs > fromMs;
}
var WEEKDAY_NAMES2 = ["\u5468\u65E5", "\u5468\u4E00", "\u5468\u4E8C", "\u5468\u4E09", "\u5468\u56DB", "\u5468\u4E94", "\u5468\u516D"];
function weekdayOf(dayStartMs) {
  const t = beijingWallClockParts(dayStartMs);
  return WEEKDAY_NAMES2[new Date(Date.UTC(t.y, t.mo - 1, t.d)).getUTCDay()];
}
var pad22 = (value) => String(value).padStart(2, "0");
function formatDayLabel(dayStartMs, nowMs) {
  const t = beijingWallClockParts(dayStartMs);
  const now = beijingWallClockParts(nowMs);
  const base = t.y === now.y ? `${t.mo}\u6708${t.d}\u65E5 ${weekdayOf(dayStartMs)}` : `${t.y}\u5E74${t.mo}\u6708${t.d}\u65E5 ${weekdayOf(dayStartMs)}`;
  const today = beijingDayStart(nowMs);
  if (dayStartMs === today) return `\u4ECA\u5929 \xB7 ${base}`;
  if (dayStartMs === today + DAY_MS) return `\u660E\u5929 \xB7 ${base}`;
  return base;
}
function isMultiDayEvent(event) {
  return beijingDayStart(event.endMs - 1) !== beijingDayStart(event.startMs);
}
function formatShortDate(ms) {
  const t = beijingWallClockParts(ms);
  return `${pad22(t.mo)}-${pad22(t.d)}`;
}
function formatShortDateWithYear(ms) {
  const t = beijingWallClockParts(ms);
  return `${t.y}-${pad22(t.mo)}-${pad22(t.d)}`;
}
function formatClock(ms) {
  const t = beijingWallClockParts(ms);
  return `${pad22(t.hh)}:${pad22(t.mi)}`;
}
function eventTimeColumn(event) {
  if (event.allDay) return "\u5168\u5929";
  if (isMultiDayEvent(event)) return "\u8DE8\u5929";
  return formatClock(event.startMs);
}
function eventWhenText(event) {
  if (event.allDay) return "\u5168\u5929";
  if (isMultiDayEvent(event)) {
    const startY = beijingWallClockParts(event.startMs).y;
    const endY = beijingWallClockParts(event.endMs).y;
    if (startY !== endY) {
      return `${formatShortDateWithYear(event.startMs)} ${formatClock(event.startMs)} \u81F3 ${formatShortDateWithYear(event.endMs)} ${formatClock(event.endMs)}`;
    }
    return `${formatShortDate(event.startMs)} ${formatClock(event.startMs)} \u81F3 ${formatShortDate(event.endMs)} ${formatClock(event.endMs)}`;
  }
  return `${formatClock(event.startMs)}\u2013${formatClock(event.endMs)}`;
}
function alarmTimesText(event) {
  if (event.alarmTimes.length === 0) return event.hasAlarm ? "\u5DF2\u8BBE\u63D0\u9192" : "\u65E0\u63D0\u9192";
  return event.alarmTimes.map((t) => formatClock(t)).join("\u3001");
}
function detailAlarmText(event, detail) {
  if (detail === null || detail.uid !== event.uid) return "\u8BFB\u53D6\u4E2D\u2026";
  if (detail.status === "loading") return "\u8BFB\u53D6\u4E2D\u2026";
  if (detail.status === "error") return `\u8BFB\u53D6\u5931\u8D25\uFF08${detail.error ?? "\u672A\u77E5\u9519\u8BEF"}\uFF09`;
  return alarmTimesText(detail.event ?? event);
}
function draftCardLines(item) {
  const lines = [formatDraftWhen(item)];
  if (item.location) lines.push(`\u5730\u70B9\uFF1A${item.location}`);
  lines.push(formatDraftAlarms(item));
  if (item.notes) lines.push(`\u5907\u6CE8\uFF1A${item.notes}`);
  return lines;
}
var ICONS = {
  refresh: ["M3 12a9 9 0 0 1 15-6.7L21 8", "M21 3v5h-5", "M21 12a9 9 0 0 1-15 6.7L3 16", "M3 21v-5h5"],
  calendar: ["M8 2v4", "M16 2v4", "M3 10h18", "M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z"],
  pin: ["M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z", "M12 12a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z"],
  bell: ["M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9", "M10.3 21a1.94 1.94 0 0 0 3.4 0"],
  x: ["M18 6 6 18", "m6 6 12 12"],
  check: ["M20 6 9 17l-5-5"],
  left: ["M15 18l-6-6 6-6"],
  right: ["M9 18l6-6-6-6"],
  plus: ["M12 5v14", "M5 12h14"]
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
var FALLBACK_DOTS = ["#2563EB", "#7C3AED", "#0D9488", "#DB2777", "#EA580C", "#4F46E5", "#16A34A"];
function calendarDotColor(calendars, name) {
  const found = calendars.find((cal) => cal.name === name);
  if (found?.color) return found.color;
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) % 1000003;
  return FALLBACK_DOTS[hash % FALLBACK_DOTS.length];
}
var PILL_PAD = { paddingTop: "4px", paddingBottom: "4px" };
function monthWindow(anchorMs) {
  const cells = monthGrid(anchorMs, Date.now(), []).cells;
  return { fromMs: cells[0].dayStartMs, toMs: cells[cells.length - 1].dayStartMs + DAY_MS };
}
var WEEKDAY_HEADERS = ["\u65E5", "\u4E00", "\u4E8C", "\u4E09", "\u56DB", "\u4E94", "\u516D"];
function createCalendarPanelTab(ctx, api) {
  const { createElement: el, useState, useEffect } = ctx.react;
  return function CalendarPanelTab() {
    const nowMs = Date.now();
    const [loadSeqRef] = useState(() => ({ generation: 0 }));
    const [detailSeqRef] = useState(() => ({ generation: 0 }));
    const [anchorMs, setAnchorMs] = useState(() => monthAnchorOf(nowMs));
    const [selectedDayMs, setSelectedDayMs] = useState(() => beijingDayStart(nowMs));
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    const [partial, setPartial] = useState(false);
    const [calendars, setCalendars] = useState([]);
    const [activeCalendar, setActiveCalendar] = useState("");
    const [events, setEvents] = useState([]);
    const [drafts, setDrafts] = useState([]);
    const [busy, setBusy] = useState(false);
    const [detailKey, setDetailKey] = useState("");
    const [reminderOpen, setReminderOpen] = useState(false);
    const [reminderTitle, setReminderTitle] = useState("");
    const [reminderTime, setReminderTime] = useState("09:00");
    const [reminderError, setReminderError] = useState("");
    const [reminderBusy, setReminderBusy] = useState(false);
    const [detail, setDetail] = useState(null);
    async function loadMonth(nextAnchor) {
      const seq = ++loadSeqRef.generation;
      setLoading(true);
      setError("");
      setPartial(false);
      setEvents([]);
      try {
        const win = monthWindow(nextAnchor);
        const [range, draftItems] = await Promise.all([api.eventsInRange(win.fromMs, win.toMs), api.drafts()]);
        if (seq !== loadSeqRef.generation) return;
        setEvents(range.events);
        setPartial(range.truncated === true);
        setError(range.error ?? "");
        setDrafts(draftItems);
        setLoading(false);
        const calendarsOut = await api.calendars();
        if (seq !== loadSeqRef.generation) return;
        setCalendars(calendarsOut.calendars);
        setError((prev) => prev !== "" ? prev : calendarsOut.error ?? "");
      } catch (cause) {
        if (seq !== loadSeqRef.generation) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (seq === loadSeqRef.generation) setLoading(false);
      }
    }
    async function fetchDetail(uid) {
      const seq = ++detailSeqRef.generation;
      setDetail({ uid, status: "loading" });
      try {
        const event = await api.eventDetail(uid);
        if (seq !== detailSeqRef.generation) return;
        setDetail({ uid, status: "ok", event });
      } catch (cause) {
        if (seq !== detailSeqRef.generation) return;
        setDetail({ uid, status: "error", error: cause instanceof Error ? cause.message : String(cause) });
      }
    }
    useEffect(() => {
      void loadMonth(anchorMs);
    }, []);
    async function run(action) {
      setBusy(true);
      setNotice("");
      setError("");
      try {
        await action();
        await loadMonth(anchorMs);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    }
    function gotoMonth(delta) {
      const next = shiftMonth(anchorMs, delta);
      setAnchorMs(next);
      const todayAnchor = monthAnchorOf(Date.now());
      setSelectedDayMs(next === todayAnchor ? beijingDayStart(Date.now()) : next);
      setDetailKey("");
      void loadMonth(next);
    }
    function gotoToday() {
      const todayAnchor = monthAnchorOf(Date.now());
      setAnchorMs(todayAnchor);
      setSelectedDayMs(beijingDayStart(Date.now()));
      setDetailKey("");
      void loadMonth(todayAnchor);
    }
    async function submitReminder() {
      setReminderError("");
      const check = reminderDraftCheck({ title: reminderTitle, time: reminderTime }, selectedDayMs);
      if (!check.ok) {
        setReminderError(check.error);
        return;
      }
      setReminderBusy(true);
      try {
        const result = await api.createReminder({
          title: reminderTitle.trim(),
          notes: `\u7531\u65E5\u5386\u9762\u677F\u521B\u5EFA\uFF08${fullDayLabel(selectedDayMs)}\uFF09`,
          dueMs: check.dueMs
        });
        const t = beijingWallClockParts(check.dueMs);
        setNotice(`\u5DF2\u521B\u5EFA\u63D0\u9192\u300C${result.title}\u300D\uFF08${t.mo}\u6708${t.d}\u65E5 ${pad22(t.hh)}:${pad22(t.mi)}\uFF09\uFF0C\u53EF\u5728\u7CFB\u7EDF\u300C\u63D0\u9192\u4E8B\u9879\u300DApp \u67E5\u770B\u3002`);
        setReminderOpen(false);
        setReminderTitle("");
        setReminderTime("09:00");
      } catch (cause) {
        setReminderError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setReminderBusy(false);
      }
    }
    function arrangeWithAi() {
      if (typeof ctx.composer?.setDraft !== "function") {
        setError("\u5F53\u524D\u5BBF\u4E3B\u4E0D\u652F\u6301\u5199\u5165\u8F93\u5165\u6846\u8349\u7A3F\uFF1A\u8BF7\u5347\u7EA7 LawyerCopilot \u540E\u91CD\u8BD5\u3002");
        return;
      }
      try {
        ctx.composer.setDraft(aiArrangeDraft(selectedDayMs));
        setNotice("\u5DF2\u628A\u6240\u9009\u65E5\u671F\u653E\u5165\u8F93\u5165\u6846\uFF1A\u8865\u5145\u8981\u5B89\u6392\u7684\u4E8B\uFF0CAI \u4F1A\u7528\u300C\u5F8B\u5E08\u5907\u5FD8\u5F55\u300D\u5DE5\u5177\u521B\u5EFA\u63D0\u9192\u3002");
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    }
    const visible = activeCalendar === "" ? events : events.filter((event) => event.calendar === activeCalendar);
    const grid = monthGrid(anchorMs, Date.now(), visible);
    const dayEvents = eventsOnDay(visible, selectedDayMs);
    const todayStart = beijingDayStart(Date.now());
    const noEventsLine = dayEvents.length === 0 ? partial ? "\u672A\u5728\u5DF2\u8BFB\u53D6\u7684\u90E8\u5206\u65E5\u7A0B\u4E2D\u627E\u5230\u5B89\u6392" : "\u65E0\u5B89\u6392" : `${dayEvents.length} \u573A\u5B89\u6392`;
    const subtitle = loading ? "\u6B63\u5728\u8BFB\u53D6\u65E5\u5386\u2026" : error !== "" ? "\u672A\u80FD\u5B8C\u6574\u8BFB\u53D6\u65E5\u5386\uFF0C\u8BF7\u5237\u65B0\u91CD\u8BD5" : `${formatDayLabel(selectedDayMs, Date.now())} \xB7 ${noEventsLine}`;
    return el(
      "div",
      { className: "flex h-full min-h-0 flex-col" },
      // ———————— 标题行：日历 + 副行 + 刷新 ————————
      el(
        "div",
        { className: "flex items-center gap-2 px-3", style: { paddingTop: "12px" } },
        el(
          "div",
          { className: "min-w-0" },
          el("div", { className: "text-title-3-semibold text-text-primary" }, "\u65E5\u5386"),
          el("div", { className: "truncate text-caption-2-medium text-text-tertiary" }, subtitle)
        ),
        el("div", { className: "flex-1" }),
        el("button", {
          title: "\u5237\u65B0",
          className: "flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-foreground-icon-secondary transition-colors hover:bg-button-ghost-hover disabled:opacity-40",
          disabled: loading || busy,
          onClick: () => {
            void loadMonth(anchorMs);
          }
        }, icon(el, "refresh", { size: 15 }))
      ),
      // ———————— 月历导航：‹ 2026年9月 › + 今天 ————————
      el(
        "div",
        { className: "flex items-center gap-1.5 px-3 pb-1", style: { paddingTop: "10px" } },
        el("button", {
          title: "\u4E0A\u4E2A\u6708",
          className: "flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-foreground-icon-secondary transition-colors hover:bg-button-ghost-hover disabled:opacity-40",
          disabled: loading,
          onClick: () => gotoMonth(-1)
        }, icon(el, "left", { size: 14 })),
        el("span", { className: "min-w-0 flex-1 truncate text-center text-body-2-medium text-text-primary" }, grid.title),
        el("button", {
          title: "\u4E0B\u4E2A\u6708",
          className: "flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-foreground-icon-secondary transition-colors hover:bg-button-ghost-hover disabled:opacity-40",
          disabled: loading,
          onClick: () => gotoMonth(1)
        }, icon(el, "right", { size: 14 })),
        el("button", {
          className: "shrink-0 rounded-full px-3 text-caption-2-medium text-text-secondary transition-colors hover:bg-background-secondary-hover hover:text-text-primary",
          style: PILL_PAD,
          disabled: loading,
          onClick: () => gotoToday()
        }, "\u4ECA\u5929")
      ),
      // ———————— 星期表头 ————————
      el(
        "div",
        { className: "px-2", style: { paddingTop: "8px", display: "grid", gridTemplateColumns: "repeat(7, minmax(0, 1fr))" } },
        ...WEEKDAY_HEADERS.map(
          (label) => el("span", { key: label, className: "text-center text-caption-2-medium text-text-tertiary" }, label)
        )
      ),
      // ———————— 月历网格：42 格 ————————
      el(
        "div",
        { className: "gap-0.5 px-2", style: { paddingTop: "4px", display: "grid", gridTemplateColumns: "repeat(7, minmax(0, 1fr))" } },
        ...grid.cells.map((cell) => {
          const isSelected = cell.dayStartMs === selectedDayMs;
          const cellDots = eventsOnDay(visible, cell.dayStartMs).map((event) => calendarDotColor(calendars, event.calendar)).slice(0, 3);
          const numberClass = cell.isToday ? "text-caption-1-medium text-white" : isSelected ? "text-caption-1-medium text-status-blue-text" : cell.inMonth ? "text-caption-1-medium text-text-primary" : "text-caption-1-medium text-text-tertiary";
          const bgClass = cell.isToday ? "bg-blue-600" : isSelected ? "bg-pill-tab-blue-selected-background" : "transition-colors hover:bg-background-secondary-hover";
          return el(
            "button",
            {
              key: cell.dayStartMs,
              type: "button",
              className: `flex flex-col items-center ${bgClass}`,
              style: { borderRadius: "10px", paddingTop: "4px", paddingBottom: "3px" },
              onClick: () => {
                setSelectedDayMs(cell.dayStartMs);
                setDetailKey("");
                setReminderOpen(false);
              }
            },
            el("span", {
              className: `flex items-center justify-center ${numberClass}`,
              style: { width: "24px", height: "24px", borderRadius: "12px" }
            }, String(cell.day)),
            el(
              "span",
              { className: "flex items-center justify-center gap-0.5", style: { height: "8px" } },
              ...cellDots.map(
                (color, index) => el("span", {
                  key: index,
                  className: cell.isToday ? "rounded-full" : "rounded-full",
                  style: { width: "4px", height: "4px", backgroundColor: cell.isToday ? "#ffffff" : color }
                })
              )
            )
          );
        })
      ),
      // ———————— 日历筛选胶囊（横滑） ————————
      el(
        "div",
        { className: "flex gap-1.5 overflow-x-auto px-3 pb-1", style: { paddingTop: "10px" } },
        el("button", {
          key: "__all__",
          className: `shrink-0 rounded-full px-3 text-caption-1-medium transition-colors ${activeCalendar === "" ? "bg-pill-tab-blue-selected-background text-status-blue-text" : "text-text-secondary hover:bg-background-secondary-hover"}`,
          style: PILL_PAD,
          onClick: () => setActiveCalendar("")
        }, "\u5168\u90E8"),
        ...calendars.map(
          (cal) => el("button", {
            key: cal.name,
            title: cal.name,
            className: `shrink-0 rounded-full px-3 text-caption-1-medium transition-colors ${activeCalendar === cal.name ? "bg-pill-tab-blue-selected-background text-status-blue-text" : "text-text-secondary hover:bg-background-secondary-hover"}`,
            style: PILL_PAD,
            onClick: () => setActiveCalendar(cal.name)
          }, cal.name)
        )
      ),
      // ———————— 状态提示 ————————
      error === "" ? null : el("div", {
        className: "rounded-lg bg-background-tertiary-error px-3 py-2 text-caption-1-regular text-text-error-primary",
        style: { margin: "8px 12px 0" }
      }, error),
      notice === "" ? null : el("div", {
        className: "rounded-lg bg-background-secondary-default px-3 py-2 text-caption-1-regular text-text-primary",
        style: { margin: "8px 12px 0" }
      }, notice),
      // 截断如实提示：窗口内日程超过上限时不能假装列表完整
      partial && !loading ? el("div", {
        className: "rounded-lg bg-background-secondary-default px-3 py-2 text-caption-1-regular text-text-secondary",
        style: { margin: "8px 12px 0" }
      }, "\u65E5\u7A0B\u8F83\u591A\uFF0C\u4EC5\u52A0\u8F7D\u4E86\u524D 200 \u6761\uFF0C\u6570\u636E\u672A\u5B8C\u6574\uFF1A\u53EF\u5230\u65E5\u5386.app \u67E5\u770B\u5168\u90E8\u3002") : null,
      // ———————— 主体：选中日日程列表 ————————
      el(
        "div",
        { className: "min-h-0 flex-1 overflow-y-auto", style: { padding: "0 8px" } },
        el(
          "div",
          { className: "flex flex-col" },
          // 日期头 + 操作行（创建提醒 / AI 安排）
          el(
            "div",
            {
              className: "flex flex-wrap items-center gap-1.5 px-3 pb-1",
              style: { paddingTop: "10px" }
            },
            el("span", {
              className: `text-caption-2-medium ${selectedDayMs === todayStart ? "text-status-blue-text" : "text-text-tertiary"}`
            }, formatDayLabel(selectedDayMs, Date.now())),
            el("div", { className: "flex-1" }),
            el("button", {
              type: "button",
              className: "flex items-center gap-1 rounded-full px-3 text-caption-2-medium text-text-secondary transition-colors hover:bg-background-secondary-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50",
              style: { ...PILL_PAD, border: "1px solid var(--color-border-button-default)" },
              disabled: busy || reminderBusy,
              onClick: () => {
                setReminderOpen(!reminderOpen);
                setReminderError("");
              }
            }, icon(el, "plus", { size: 11 }), "\u521B\u5EFA\u63D0\u9192"),
            el("button", {
              type: "button",
              className: "flex items-center gap-1 rounded-full px-3 text-caption-2-medium text-status-blue-text transition-colors hover:bg-background-secondary-hover disabled:cursor-not-allowed disabled:opacity-50",
              style: { ...PILL_PAD, border: "1px solid var(--color-border-button-default)" },
              disabled: busy || reminderBusy,
              onClick: () => arrangeWithAi()
            }, "\u8BA9 AI \u5B89\u6392")
          ),
          // 创建提醒表单（④）
          reminderOpen ? el(
            "div",
            {
              className: "flex flex-col gap-2 rounded-xl bg-background-secondary-default p-2.5",
              style: { margin: "4px 4px 0", border: "1px solid var(--color-separator-border)" }
            },
            el("span", { className: "text-caption-1-medium text-text-primary" }, `\u521B\u5EFA\u63D0\u9192 \xB7 ${fullDayLabel(selectedDayMs)}`),
            el("input", {
              className: "w-full rounded-md border border-border-button-default bg-background-full px-3 py-2 text-caption-1-regular text-text-primary outline-none disabled:opacity-50",
              placeholder: "\u63D0\u9192\u5185\u5BB9\uFF0C\u4F8B\u5982\uFF1A\u63D0\u4EA4\u8BC1\u636E\u6750\u6599",
              value: reminderTitle,
              disabled: reminderBusy,
              onChange: (event) => setReminderTitle(event.target.value)
            }),
            el(
              "div",
              { className: "flex items-center gap-2" },
              el("span", { className: "shrink-0 text-caption-1-regular text-text-tertiary" }, "\u63D0\u9192\u65F6\u95F4"),
              el("input", {
                className: "w-24 rounded-md border border-border-button-default bg-background-full px-3 py-2 text-caption-1-regular text-text-primary outline-none disabled:opacity-50",
                placeholder: "09:00",
                value: reminderTime,
                disabled: reminderBusy,
                onChange: (event) => setReminderTime(event.target.value)
              }),
              el("span", { className: "min-w-0 flex-1 truncate text-caption-2-medium text-text-tertiary" }, "\u7559\u7A7A\u5219\u9ED8\u8BA4\u5F53\u5929 09:00")
            ),
            reminderError === "" ? null : el("span", { className: "text-caption-2-medium text-text-error-primary" }, reminderError),
            el(
              "div",
              { className: "flex items-center gap-2" },
              el("button", {
                type: "button",
                className: "flex items-center gap-1.5 rounded-md bg-accent-500 px-3 py-2 text-caption-1-medium text-white shadow-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                disabled: reminderBusy,
                onClick: () => {
                  void submitReminder();
                }
              }, reminderBusy ? "\u521B\u5EFA\u4E2D\u2026" : "\u521B\u5EFA\u63D0\u9192"),
              el("button", {
                type: "button",
                className: "rounded-md border border-border-button-default px-3 py-2 text-caption-1-medium text-text-secondary transition-colors hover:bg-button-ghost-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50",
                disabled: reminderBusy,
                onClick: () => {
                  setReminderOpen(false);
                  setReminderError("");
                }
              }, "\u53D6\u6D88"),
              el("span", { className: "min-w-0 flex-1 truncate text-caption-2-medium text-text-tertiary" }, "\u5199\u5165\u7CFB\u7EDF\u300C\u63D0\u9192\u4E8B\u9879\u300DApp")
            )
          ) : null,
          // 日程列表
          loading || error !== "" ? el(
            "p",
            { className: "px-3 py-2 text-caption-1-regular text-text-tertiary" },
            loading ? "\u6B63\u5728\u8BFB\u53D6\u65E5\u7A0B\uFF0C\u8BF7\u7A0D\u5019\u2026" : "\u8BFB\u53D6\u5931\u8D25\uFF0C\u6682\u65F6\u65E0\u6CD5\u5224\u65AD\u8FD9\u4E00\u5929\u662F\u5426\u6709\u5B89\u6392\u3002"
          ) : dayEvents.length === 0 ? partial ? el(
            "div",
            { className: "flex flex-col items-center text-center", style: { padding: "32px 24px 0" } },
            el("div", {
              className: "flex items-center justify-center rounded-full bg-background-quaternary-default text-foreground-icon-tertiary",
              style: { width: "44px", height: "44px" }
            }, icon(el, "calendar", { size: 20 })),
            el("div", { className: "text-body-2-medium text-text-primary", style: { marginTop: "10px" } }, "\u5DF2\u8BFB\u53D6\u7684\u90E8\u5206\u65E5\u7A0B\u4E2D\u6CA1\u6709\u8FD9\u4E00\u5929\u7684\u5B89\u6392"),
            el("div", { className: "mt-1 text-caption-1-regular text-text-tertiary" }, "\u672C\u6708\u65E5\u7A0B\u8F83\u591A\uFF08\u8D85\u8FC7 200 \u6761\uFF09\uFF0C\u5F53\u524D\u4EC5\u52A0\u8F7D\u4E86\u90E8\u5206\uFF1B\u5B8C\u6574\u5B89\u6392\u8BF7\u5230\u65E5\u5386.app \u67E5\u770B\u3002")
          ) : el(
            "div",
            { className: "flex flex-col items-center text-center", style: { padding: "32px 24px 0" } },
            el("div", {
              className: "flex items-center justify-center rounded-full bg-background-quaternary-default text-foreground-icon-tertiary",
              style: { width: "44px", height: "44px" }
            }, icon(el, "calendar", { size: 20 })),
            el("div", { className: "text-body-2-medium text-text-primary", style: { marginTop: "10px" } }, "\u8FD9\u4E00\u5929\u6CA1\u6709\u65E5\u7A0B"),
            el("div", { className: "mt-1 text-caption-1-regular text-text-tertiary" }, "\u53EF\u8BA9 AI \u8D77\u8349\u65E5\u7A0B\uFF08\u786E\u8BA4\u540E\u5199\u5165\uFF09\uFF0C\u6216\u70B9\u300C\u521B\u5EFA\u63D0\u9192\u300D\u76F4\u63A5\u52A0\u4E00\u6761\u63D0\u9192\u4E8B\u9879\u3002")
          ) : el(
            "div",
            null,
            ...dayEvents.map((event, index) => {
              const key = `${event.uid || event.startMs}-${event.startMs}`;
              const expanded = detailKey === key;
              const hasDetail = detail !== null && detail.uid === event.uid && detail.status === "ok";
              const alarmIconOn = hasDetail ? (detail?.event?.alarmTimes.length ?? 0) > 0 || (detail?.event?.hasAlarm ?? false) : event.alarmTimes.length > 0 || event.hasAlarm;
              return el(
                "div",
                { key: `${key}-${index}` },
                el(
                  "div",
                  {
                    className: "flex cursor-pointer items-start gap-2 rounded-xl py-2 transition-colors hover:bg-background-secondary-hover",
                    style: { paddingInline: "8px" },
                    onClick: () => {
                      setDetailKey(expanded ? "" : key);
                      if (!expanded && event.uid !== "") void fetchDetail(event.uid);
                    }
                  },
                  // 时间列
                  el("span", {
                    className: `shrink-0 text-caption-1-medium ${selectedDayMs === todayStart ? "text-status-blue-text" : "text-text-secondary"}`,
                    style: { width: "44px", paddingTop: "2px" }
                  }, eventTimeColumn(event)),
                  // 日历色点
                  el("span", {
                    className: "shrink-0 rounded-full",
                    style: {
                      width: "6px",
                      height: "6px",
                      marginTop: "8px",
                      background: calendarDotColor(calendars, event.calendar)
                    }
                  }),
                  // 内容
                  el(
                    "div",
                    { className: "min-w-0 flex-1" },
                    el("div", { className: "truncate text-body-2-medium text-text-primary" }, event.title),
                    el(
                      "div",
                      { className: "mt-1 flex items-center gap-1.5 text-caption-2-medium text-text-tertiary" },
                      event.location ? el(
                        "span",
                        { className: "flex min-w-0 items-center gap-1" },
                        icon(el, "pin", { size: 11, className: "shrink-0" }),
                        el("span", { className: "truncate" }, event.location)
                      ) : null,
                      el("span", { className: "shrink-0" }, `${eventWhenText(event)} \xB7 ${event.calendar}`)
                    )
                  ),
                  // 提醒图标
                  alarmIconOn ? el(
                    "span",
                    { className: "shrink-0 text-foreground-icon-tertiary", title: "\u5DF2\u8BBE\u63D0\u9192", style: { paddingTop: "4px" } },
                    icon(el, "bell", { size: 13 })
                  ) : null
                ),
                // 展开详情（②：时间/地点/备注，来自日历.app 真实数据）
                expanded ? el(
                  "div",
                  {
                    className: "flex flex-col gap-1.5 rounded-xl bg-background-secondary-default p-2.5",
                    style: { margin: "0 8px 8px", border: "1px solid var(--color-separator-border)" }
                  },
                  el(
                    "div",
                    { className: "flex items-center gap-2" },
                    el("span", {
                      className: "shrink-0 rounded-full",
                      style: { width: "6px", height: "6px", background: calendarDotColor(calendars, event.calendar) }
                    }),
                    el("span", { className: "truncate text-body-2-medium text-text-primary" }, event.title)
                  ),
                  el("span", { className: "text-caption-1-regular text-text-secondary" }, `\u65F6\u95F4\uFF1A${eventWhenText(event)}`),
                  event.location === "" ? null : el("span", { className: "text-caption-1-regular text-text-secondary" }, `\u5730\u70B9\uFF1A${event.location}`),
                  el("span", { className: "text-caption-1-regular text-text-secondary" }, `\u65E5\u5386\uFF1A${event.calendar}`),
                  el("span", { className: "text-caption-1-regular text-text-secondary" }, `\u63D0\u9192\uFF1A${detailAlarmText(event, detail)}`),
                  event.isRecurring ? el("span", { className: "text-caption-1-regular text-text-secondary" }, "\u91CD\u590D\u65E5\u7A0B\uFF08\u4FEE\u6539/\u5220\u9664\u4F1A\u4F5C\u7528\u4E8E\u6574\u4E2A\u7CFB\u5217\uFF09") : null,
                  event.notes === "" ? null : el("span", {
                    className: "text-caption-1-regular text-text-secondary",
                    style: { whiteSpace: "pre-wrap", wordBreak: "break-all" }
                  }, `\u5907\u6CE8\uFF1A${event.notes}`)
                ) : null
              );
            })
          )
        )
      ),
      // ———————— 底部草稿箱：有待确认草稿时显示 ————————
      drafts.length === 0 ? null : el(
        "div",
        { className: "sticky bottom-0 z-10 bg-background-full p-2.5", style: { borderTop: "1px solid var(--color-separator-border)" } },
        el(
          "div",
          { className: "flex items-center gap-1.5", style: { marginBottom: "8px" } },
          icon(el, "calendar", { size: 13 }),
          el("span", { className: "text-caption-1-medium text-text-primary" }, `\u5F85\u786E\u8BA4\u8349\u7A3F \xB7 ${drafts.length} \u6761`),
          el("span", { className: "text-caption-2-medium text-text-tertiary" }, "\uFF08\u786E\u8BA4\u540E\u624D\u5199\u5165\u65E5\u5386\uFF09")
        ),
        el(
          "div",
          { className: "flex max-h-56 flex-col gap-2 overflow-y-auto" },
          ...drafts.map(
            (item) => el(
              "div",
              {
                key: item.id,
                className: "flex flex-col gap-2 rounded-xl bg-background-secondary-default p-2.5",
                style: { border: "1px solid var(--color-separator-border)" }
              },
              el(
                "div",
                { className: "min-w-0" },
                el("div", { className: "truncate text-body-2-medium text-text-primary" }, item.title),
                ...draftCardLines(item).map(
                  (line, index) => el("div", { key: index, className: "truncate text-caption-2-medium text-text-tertiary" }, line)
                )
              ),
              el(
                "div",
                { className: "flex items-center gap-2" },
                el("button", {
                  type: "button",
                  className: "flex items-center gap-1 rounded-full bg-accent-500 px-3 text-caption-2-medium text-white shadow-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                  style: { paddingTop: "6px", paddingBottom: "6px" },
                  disabled: busy,
                  onClick: () => {
                    void run(async () => {
                      setNotice(await api.confirm(item.id));
                    });
                  }
                }, icon(el, "check", { size: 12 }), "\u5199\u5165\u65E5\u5386"),
                el("button", {
                  type: "button",
                  className: "flex items-center gap-1 rounded-full px-3 text-caption-2-medium text-text-secondary transition-colors hover:bg-button-ghost-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50",
                  style: { paddingTop: "6px", paddingBottom: "6px", border: "1px solid var(--color-border-button-default)" },
                  disabled: busy,
                  onClick: () => {
                    void run(async () => {
                      await api.discard(item.id);
                      setNotice(`\u5DF2\u4E22\u5F03\u8349\u7A3F\u300C${item.title}\u300D`);
                    });
                  }
                }, icon(el, "x", { size: 12 }), "\u4E22\u5F03"),
                item.calendar ? el("span", { className: "ml-auto truncate text-caption-2-medium text-text-tertiary" }, `\u5199\u5165\u300A${item.calendar}\u300B`) : null
              )
            )
          )
        )
      )
    );
  };
}

// src/index.ts
var STORAGE_KEY = "drafts";
var REGISTRY_KEY = "events";
var DAY_MS2 = 864e5;
function activate(ctx) {
  const disposers = [];
  const apple = createAppleCalendar(ctx.bridge);
  let state = emptyState();
  let registry = emptyRegistry();
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
    stateLoaded ??= Promise.all([ctx.storage.get(STORAGE_KEY), ctx.storage.get(REGISTRY_KEY)]).then(([draftRaw, registryRaw]) => {
      state = parseState(draftRaw);
      registry = parseRegistry(registryRaw);
    }).catch((error) => {
      stateLoaded = null;
      throw error;
    });
    return stateLoaded;
  }
  async function readDrafts(fn) {
    return enqueue(async () => {
      await ensureLoaded();
      return fn(state);
    });
  }
  async function mutateDrafts(fn) {
    return enqueue(async () => {
      await ensureLoaded();
      const outcome = fn(state);
      await ctx.storage.set(STORAGE_KEY, outcome.state);
      state = outcome.state;
      return outcome.result;
    });
  }
  async function mutateRegistry(fn) {
    await enqueue(async () => {
      await ensureLoaded();
      const next = fn(registry);
      await ctx.storage.set(REGISTRY_KEY, next);
      registry = next;
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
      description: "\u67E5\u770B macOS \u65E5\u5386.app \u7684\u771F\u5B9E\u65E5\u7A0B\uFF1A\u5217\u51FA\u672A\u6765 N \u5929\uFF08\u9ED8\u8BA4 7 \u5929\uFF09\u5185\u4E0E\u8BE5\u65F6\u95F4\u7A97\u76F8\u4EA4\u7684\u65E5\u7A0B\uFF08\u8FDB\u884C\u4E2D\u3001\u8DE8\u7A97\u7684\u4E5F\u53EF\u89C1\uFF09\uFF0C\u542B\u6807\u9898\u3001\u8D77\u6B62\u65F6\u95F4\u3001\u5730\u70B9\u3001\u5907\u6CE8\u3001\u6240\u5C5E\u65E5\u5386\u3001\u63D0\u9192\u89E6\u53D1\u65F6\u523B\u3001\u662F\u5426\u91CD\u590D\u3001uid\uFF0C\u65F6\u95F4\u4E3A\u5317\u4EAC\u65F6\u95F4\u3002\u53EA\u8BFB\uFF0C\u4E0D\u4FEE\u6539\u4EFB\u4F55\u65E5\u7A0B\u3002\u8FD4\u56DE\u7684 uid \u53EF\u914D\u5408 calendar_update \u4FEE\u6539\u6216 calendar_delete \u5220\u9664\u3002",
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
            toMs: nowMs + days * DAY_MS2,
            maxRows: MAX_EVENT_ROWS
          });
          return textResult(
            renderEventList({
              days,
              fromMs: nowMs,
              toMs: nowMs + days * DAY_MS2,
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
      description: "\u8D77\u8349\u4E00\u6761\u65E5\u7A0B\uFF08\u5982\u5F00\u5EAD\u3001\u4F1A\u89C1\u3001\u671F\u9650\uFF09\u3002\u53EA\u751F\u6210\u5F85\u786E\u8BA4\u8349\u7A3F\uFF0C\u4E0D\u4F1A\u5199\u5165\u65E5\u5386.app\uFF1B\u8FD4\u56DE\u8349\u7A3F\u7F16\u53F7\uFF0C\u7B49\u5F8B\u5E08\u786E\u8BA4\uFF08calendar_confirm\uFF09\u540E\u624D\u771F\u6B63\u6DFB\u52A0\u3002\u652F\u6301\u5730\u70B9\u3001\u5168\u5929\u65E5\u7A0B\uFF08allDay=true \u65F6\u53EA\u6309\u65E5\u671F\uFF09\u548C\u591A\u4E2A\u63D0\u524D\u63D0\u9192\uFF08alarmMinutes \u6574\u6570\u6570\u7EC4\uFF0C\u7F3A\u7701 [15]\uFF09\u3002",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["title", "start", "end"],
        properties: {
          title: { type: "string", description: "\u65E5\u7A0B\u6807\u9898\uFF08\u5FC5\u586B\uFF0C\u2264200 \u5B57\uFF0C\u5982\u300CXX\u6848 \u5F00\u5EAD\u300D\uFF09" },
          start: { type: "string", description: "\u5F00\u59CB\u65F6\u95F4\uFF08\u5FC5\u586B\uFF0C\u5317\u4EAC\u65F6\u95F4 YYYY-MM-DDTHH:mm:ss\uFF0C\u5982 2026-03-02T09:30:00\uFF1B\u5168\u5929\u65E5\u7A0B\u53EF\u53EA\u7ED9\u65E5\u671F\uFF09" },
          end: { type: "string", description: "\u7ED3\u675F\u65F6\u95F4\uFF08\u5FC5\u586B\uFF0C\u5FC5\u987B\u4E0D\u65E9\u4E8E\u5F00\u59CB\u65F6\u95F4\uFF0C\u683C\u5F0F\u540C\u4E0A\uFF1B\u5168\u5929\u65E5\u7A0B\u53EF\u53EA\u7ED9\u65E5\u671F\uFF09" },
          notes: { type: "string", description: "\u5907\u6CE8/\u8BAE\u7A0B\uFF08\u53EF\u9009\uFF0C\u5199\u5165\u65E5\u7A0B\u63CF\u8FF0\uFF09" },
          location: { type: "string", description: "\u5730\u70B9\uFF08\u53EF\u9009\uFF0C\u2264200 \u5B57\uFF0C\u5982\u300C\u5317\u4EAC\u5E02\u7B2C\u4E09\u4E2D\u7EA7\u4EBA\u6C11\u6CD5\u9662 \u7B2C\u5341\u6CD5\u5EAD\u300D\uFF09" },
          allDay: { type: "boolean", description: "\u662F\u5426\u5168\u5929\u65E5\u7A0B\uFF08\u53EF\u9009\uFF1Btrue \u65F6 start/end \u53EA\u6309\u65E5\u671F\uFF09" },
          alarmMinutes: {
            type: "array",
            items: { type: "integer", minimum: 0, maximum: 10080 },
            description: "\u63D0\u524D\u63D0\u9192\u7684\u5206\u949F\u6570\u6570\u7EC4\uFF08\u53EF\u9009\uFF0C\u6700\u591A 5 \u4E2A\uFF0C\u5982 [10, 30]\uFF1B\u7A7A\u6570\u7EC4 = \u4E0D\u8BBE\u63D0\u9192\uFF1B\u7F3A\u7701 [15]\uFF09"
          },
          calendar: { type: "string", description: "\u76EE\u6807\u65E5\u5386\u540D\uFF08\u53EF\u9009\uFF0C\u9ED8\u8BA4\u300C\u4E2A\u4EBA\u300D\u6216\u7B2C\u4E00\u4E2A\u672C\u5730\u53EF\u5199\u65E5\u5386\uFF09" }
        }
      },
      async execute(args = {}) {
        return guarded(async () => {
          const item = await mutateDrafts((current) => {
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
      description: "\u5F8B\u5E08\u786E\u8BA4\u540E\u628A\u8349\u7A3F\u5199\u5165 macOS \u65E5\u5386.app\uFF08\u6309\u8349\u7A3F\u7684\u5730\u70B9/\u5168\u5929/\u63D0\u9192\u8BBE\u7F6E\uFF0C\u7F3A\u7701\u63D0\u524D 15 \u5206\u949F\u63D0\u9192\uFF09\uFF0C\u5199\u5165\u6210\u529F\u540E\u8349\u7A3F\u81EA\u52A8\u79FB\u9664\uFF0C\u8FD4\u56DE\u65B0\u65E5\u7A0B\u7684 uid\uFF08\u767B\u8BB0\u5907\u67E5\uFF0C\u53EF\u7528\u4E8E\u540E\u7EED\u4FEE\u6539/\u5220\u9664\uFF09\u3002draft_id \u6765\u81EA calendar_propose / calendar_drafts \u8FD4\u56DE\u7684\u7F16\u53F7\u3002",
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
        return guarded(async () => textResult(renderDraftList(await readDrafts((current) => listDrafts(current)))));
      }
    })
  );
  disposers.push(
    ctx.tools.register({
      name: "calendar_update",
      description: "\u6309 uid \u4FEE\u6539\u65E5\u5386.app \u91CC\u7684\u5DF2\u6709\u65E5\u7A0B\uFF08uid \u6765\u81EA calendar_list\uFF09\u3002\u53EF\u6539 title/start/end/location/notes/alarmMinutes\uFF0C\u81F3\u5C11\u7ED9\u4E00\u4E2A\u5B57\u6BB5\u3002\u6CE8\u610F\uFF1A\u63D0\u9192\u6570\u91CF\u51CF\u5C11\u65F6 Calendar.app \u65E0\u6CD5\u539F\u4F4D\u5220\u9664\u63D0\u9192\uFF0C\u65E5\u7A0B\u4F1A\u6309\u65B0\u5B57\u6BB5\u91CD\u5EFA\uFF08uid \u53D8\u5316\uFF0C\u8FD4\u56DE\u7ED3\u679C\u4F1A\u6CE8\u660E\uFF09\u3002",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["uid"],
        properties: {
          uid: { type: "string", description: "\u8981\u4FEE\u6539\u7684\u65E5\u7A0B uid\uFF08calendar_list \u8FD4\u56DE\u7684 uid \u539F\u6837\u56DE\u4F20\uFF09" },
          title: { type: "string", description: "\u65B0\u6807\u9898\uFF08\u53EF\u9009\uFF09" },
          start: { type: "string", description: "\u65B0\u5F00\u59CB\u65F6\u95F4\uFF08\u53EF\u9009\uFF0C\u5317\u4EAC\u65F6\u95F4 YYYY-MM-DDTHH:mm:ss\uFF09" },
          end: { type: "string", description: "\u65B0\u7ED3\u675F\u65F6\u95F4\uFF08\u53EF\u9009\uFF0C\u987B\u665A\u4E8E\u5F00\u59CB\u65F6\u95F4\uFF09" },
          location: { type: "string", description: '\u65B0\u5730\u70B9\uFF08\u53EF\u9009\uFF0C\u7A7A\u4E32 "" = \u6E05\u7A7A\u5730\u70B9\uFF09' },
          notes: { type: "string", description: '\u65B0\u5907\u6CE8\uFF08\u53EF\u9009\uFF0C\u7A7A\u4E32 "" = \u6E05\u7A7A\u5907\u6CE8\uFF09' },
          alarmMinutes: {
            type: "array",
            items: { type: "integer", minimum: 0, maximum: 10080 },
            description: "\u65B0\u7684\u63D0\u9192\u5206\u949F\u6570\u6570\u7EC4\uFF08\u53EF\u9009\uFF1B\u7A7A\u6570\u7EC4 = \u6E05\u7A7A\u63D0\u9192\uFF0C\u4F1A\u89E6\u53D1\u91CD\u5EFA\uFF09"
          }
        }
      },
      async execute(args = {}) {
        return guarded(async () => {
          const input = args ?? {};
          const uid = normalizeUid(input.uid);
          const changed = [];
          let title;
          let notes;
          let location;
          let startMs;
          let endMs;
          let alarmMinutes;
          if (input.title !== void 0) {
            title = typeof input.title === "string" ? input.title.trim() : "";
            if (!title) throw new CalendarError("title \u8981\u6539\u6210\u975E\u7A7A\u6807\u9898\uFF0C\u6216\u53BB\u6389\u8BE5\u53C2\u6570", "args");
            changed.push("\u6807\u9898");
          }
          if (input.notes !== void 0) {
            if (typeof input.notes !== "string") throw new CalendarError("notes \u5FC5\u987B\u662F\u5B57\u7B26\u4E32\uFF08\u7A7A\u4E32 = \u6E05\u7A7A\u5907\u6CE8\uFF09", "args");
            notes = input.notes.trim();
            changed.push("\u5907\u6CE8");
          }
          if (input.location !== void 0) {
            if (typeof input.location !== "string") throw new CalendarError("location \u5FC5\u987B\u662F\u5B57\u7B26\u4E32\uFF08\u7A7A\u4E32 = \u6E05\u7A7A\u5730\u70B9\uFF09", "args");
            location = input.location.trim();
            changed.push("\u5730\u70B9");
          }
          if (input.start !== void 0) {
            startMs = parseEventTime(input.start, "start\uFF08\u65B0\u5F00\u59CB\u65F6\u95F4\uFF09");
            changed.push("\u5F00\u59CB\u65F6\u95F4");
          }
          if (input.end !== void 0) {
            endMs = parseEventTime(input.end, "end\uFF08\u65B0\u7ED3\u675F\u65F6\u95F4\uFF09");
            changed.push("\u7ED3\u675F\u65F6\u95F4");
          }
          if (startMs !== void 0 && endMs !== void 0 && endMs <= startMs) {
            throw new CalendarError("\u7ED3\u675F\u65F6\u95F4\u5FC5\u987B\u665A\u4E8E\u5F00\u59CB\u65F6\u95F4", "args");
          }
          if (input.alarmMinutes !== void 0) {
            alarmMinutes = normalizeAlarmMinutes(input.alarmMinutes);
            changed.push("\u63D0\u9192");
          }
          if (changed.length === 0) {
            throw new CalendarError("\u81F3\u5C11\u7ED9\u51FA\u4E00\u4E2A\u8981\u4FEE\u6539\u7684\u5B57\u6BB5\uFF08title/start/end/location/notes/alarmMinutes\uFF09", "args");
          }
          const result = await apple.updateEvent({ uid, title, notes, location, startMs, endMs, alarmMinutes });
          await mutateRegistry((current) => {
            const next = registryRemove(current, uid);
            const entry = {
              uid: result.uid,
              title: result.title,
              start: toBeijingNaive(result.startMs),
              end: toBeijingNaive(result.endMs),
              calendar: result.calendar,
              createdAt: (/* @__PURE__ */ new Date()).toISOString()
            };
            return registryUpsert(next, entry);
          });
          return textResult(renderUpdated(result, changed));
        });
      }
    })
  );
  disposers.push(
    ctx.tools.register({
      name: "calendar_delete",
      description: "\u3010\u5220\u9664\u65E5\u7A0B \xB7 \u5FC5\u987B\u5F8B\u5E08\u786E\u8BA4\u3011\u6309 uid \u5220\u9664\u65E5\u5386.app \u91CC\u7684\u65E5\u7A0B\uFF08uid \u6765\u81EA calendar_list\uFF09\u3002\u5220\u9664\u4E0D\u53EF\u6062\u590D\uFF0C\u5FC5\u987B\u663E\u5F0F\u4F20 confirm=true\u2014\u2014\u5373\u4F7F\u7528\u6237\u5728\u5BF9\u8BDD\u91CC\u8BF4\u8FC7\u300C\u5220\u6389\u5427\u300D\uFF0C\u4E5F\u8981\u5148\u5411\u5F8B\u5E08\u590D\u8FF0\u8981\u5220\u7684\u65E5\u7A0B\uFF08\u6807\u9898/\u65F6\u95F4\uFF09\u5E76\u53D6\u5F97\u786E\u8BA4\u540E\uFF0C\u4EE5 confirm=true \u91CD\u8BD5\u3002",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["uid", "confirm"],
        properties: {
          uid: { type: "string", description: "\u8981\u5220\u9664\u7684\u65E5\u7A0B uid\uFF08calendar_list \u8FD4\u56DE\u7684 uid \u539F\u6837\u56DE\u4F20\uFF09" },
          confirm: { type: "boolean", description: "\u5FC5\u987B\u4E3A true\uFF1A\u8868\u793A\u5F8B\u5E08\u5DF2\u660E\u786E\u786E\u8BA4\u5220\u9664\u8FD9\u6761\u65E5\u7A0B" }
        }
      },
      async execute(args = {}) {
        return guarded(async () => {
          const input = args ?? {};
          if (input.confirm !== true) {
            throw new CalendarError(DELETE_CONFIRM_REQUIRED_MESSAGE, "args");
          }
          const uid = normalizeUid(input.uid);
          const result = await apple.deleteEvent({ uid, confirm: true });
          await mutateRegistry((current) => registryRemove(current, uid));
          return textResult(renderDeleted(result));
        });
      }
    })
  );
  async function confirmDraft(rawId) {
    const draft = await readDrafts((current) => findDraft(current, rawId));
    const calendars = await apple.listCalendars();
    const target = resolveTargetCalendar(calendars, draft.calendar);
    const range = draftEventRange(draft);
    const alarmMinutes = draft.alarmMinutes ?? [DEFAULT_ALARM_MINUTES];
    const created = await apple.createEvent({
      calendar: target.name,
      title: draft.title,
      notes: draft.notes,
      location: draft.location,
      startMs: range.startMs,
      endMs: range.endMs,
      allDay: draft.allDay === true,
      alarmMinutes
    });
    const entry = {
      uid: created.uid,
      title: draft.title,
      start: draft.start,
      end: draft.end,
      calendar: created.calendar,
      createdAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    await mutateRegistry((current) => registryUpsert(current, entry));
    await mutateDrafts((current) => {
      const outcome = removeDraft(current, draft.id);
      return { state: outcome.state, result: outcome.removed };
    });
    return textResult(renderConfirmed(draft, created.calendar, created.uid, alarmMinutes));
  }
  const api = {
    drafts: () => readDrafts((current) => listDrafts(current)),
    discard: (id) => mutateDrafts((current) => {
      const outcome = removeDraft(current, id);
      return { state: outcome.state, result: outcome.removed };
    }),
    confirm: (id) => confirmDraft(id).then((result) => result.content.map((part) => part.text).join("\n")),
    calendars: async () => {
      try {
        return { calendars: await apple.listCalendars() };
      } catch (cause) {
        return { calendars: [], error: cause instanceof Error ? cause.message : String(cause) };
      }
    },
    upcoming: async () => {
      const nowMs = Date.now();
      const toMs = nowMs + DEFAULT_DAYS * DAY_MS2;
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
    },
    eventsInRange: async (fromMs, toMs) => {
      try {
        const outcome = await apple.listEvents({ calendar: null, fromMs, toMs, maxRows: MAX_EVENT_ROWS, light: true });
        return { events: outcome.events, truncated: outcome.truncated };
      } catch (cause) {
        return { events: [], error: cause instanceof Error ? cause.message : String(cause) };
      }
    },
    eventDetail: (uid) => apple.eventDetail(uid),
    createReminder: (input) => apple.createReminder(input)
  };
  disposers.push(
    ctx.ui.registerSettingsSection({
      key: "lawyer-calendar",
      label: () => "\u5F8B\u5E08\u65E5\u5386",
      component: createSettingsPanel(ctx, api)
    })
  );
  if (typeof ctx.ui.registerPanelTab === "function") {
    disposers.push(
      ctx.ui.registerPanelTab({
        key: "lawyer-calendar",
        label: () => "\u65E5\u5386",
        component: createCalendarPanelTab(ctx, api)
      })
    );
  }
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
        const [calendarsOut, upcoming, draftItems] = await Promise.all([api.calendars(), api.upcoming(), api.drafts()]);
        const writableCount = calendarsOut.calendars.filter((cal) => cal.writable).length;
        setStatus(
          calendarsOut.error ? { ok: false, writableCount: 0, error: calendarsOut.error } : { ok: true, writableCount }
        );
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
    const SMALL_PAD = { paddingTop: "6px", paddingBottom: "6px" };
    return createElement(
      "div",
      { className: "flex flex-col gap-3", style: { padding: "16px" } },
      createElement(
        "div",
        { className: "flex items-center justify-between gap-2" },
        createElement(
          "span",
          {
            className: `text-body-2-medium ${status && !status.ok ? "text-text-error-primary" : "text-text-primary"}`
          },
          statusLine
        ),
        createElement(
          "button",
          {
            type: "button",
            className: "rounded-md px-3 text-caption-2-medium text-text-secondary transition-colors hover:bg-button-ghost-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50",
            style: { paddingTop: "6px", paddingBottom: "6px", border: "1px solid var(--color-border-button-default)" },
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
        { className: "rounded-md bg-background-tertiary-error px-3 py-2 text-caption-1-regular text-text-error-primary" },
        status.error
      ) : null,
      error ? createElement(
        "div",
        { className: "rounded-md bg-background-tertiary-error px-3 py-2 text-body-2-regular text-text-error-primary" },
        `\u64CD\u4F5C\u5931\u8D25\uFF1A${error}`
      ) : null,
      notice ? createElement(
        "div",
        { className: "rounded-md bg-background-secondary-default px-3 py-2 text-body-2-regular text-state-success-text" },
        notice
      ) : null,
      createElement(
        "section",
        { className: "flex flex-col gap-2" },
        createElement(
          "h3",
          { className: "text-body-2-medium text-text-primary" },
          window ? `\u8FD1 7 \u5929\u65E5\u7A0B\uFF08${formatDateTime(window.fromMs)} \uFF5E ${formatDateTime(window.toMs)}\uFF0C\u5317\u4EAC\u65F6\u95F4\uFF09` : "\u8FD1 7 \u5929\u65E5\u7A0B"
        ),
        eventsError ? createElement("p", { className: "text-caption-1-regular text-text-error-primary" }, `\u65E0\u6CD5\u8BFB\u53D6\u65E5\u7A0B\uFF1A${eventsError}`) : events.length === 0 ? createElement(
          "p",
          { className: "text-center text-body-2-regular text-text-tertiary", style: { padding: "24px 0" } },
          "\u672A\u6765 7 \u5929\u6CA1\u6709\u65E5\u7A0B\u3002"
        ) : createElement(
          "ul",
          { className: "flex flex-col divide-y divide-separator-border rounded-md", style: { border: "1px solid var(--color-separator-border)" } },
          events.map(
            (event, index) => createElement(
              "li",
              { key: `${event.uid || event.startMs}-${index}`, className: "flex flex-col gap-1.5 px-3 py-2" },
              createElement("span", { className: "text-body-2-regular text-text-primary" }, event.title),
              createElement(
                "span",
                { className: "text-caption-2-medium text-text-tertiary" },
                `${formatDraftWhen({
                  start: toBeijingNaive(event.startMs),
                  end: toBeijingNaive(event.endMs),
                  allDay: event.allDay
                })} \xB7 \u65E5\u5386\u300A${event.calendar}\u300B \xB7 ${event.alarmTimes.length > 0 || event.hasAlarm ? "\u6709\u63D0\u9192" : "\u65E0\u63D0\u9192"}${event.location ? ` \xB7 ${event.location}` : ""}`
              )
            )
          )
        )
      ),
      createElement(
        "section",
        { className: "flex flex-col gap-2" },
        createElement("h3", { className: "text-body-2-medium text-text-primary" }, "\u5F85\u786E\u8BA4\u8349\u7A3F\uFF08\u786E\u8BA4\u540E\u624D\u5199\u5165\u65E5\u5386\uFF09"),
        drafts.length === 0 ? createElement(
          "p",
          { className: "text-center text-body-2-regular text-text-tertiary", style: { padding: "24px 0" } },
          "\u6682\u65E0\u8349\u7A3F\u3002\u5728\u5BF9\u8BDD\u91CC\u8BA9 AI \u5E2E\u4F60\u5B89\u6392\u65E5\u7A0B\uFF0C\u4F1A\u5148\u51FA\u73B0\u5728\u8FD9\u91CC\u3002"
        ) : createElement(
          "ul",
          { className: "flex flex-col divide-y divide-separator-border rounded-md", style: { border: "1px solid var(--color-separator-border)" } },
          drafts.map(
            (item) => createElement(
              "li",
              { key: item.id, className: "flex items-start gap-3 px-3 py-2" },
              createElement(
                "div",
                { className: "min-w-0 flex-1" },
                createElement("p", { className: "text-body-2-regular text-text-primary" }, `#${item.id} ${item.title}`),
                createElement(
                  "p",
                  { className: "text-caption-2-medium text-text-tertiary" },
                  `${formatDraftWhen(item)} \xB7 ${item.calendar ? `\u5199\u5165\u65E5\u5386\u300A${item.calendar}\u300B` : "\u5199\u5165\u9ED8\u8BA4\u65E5\u5386"}${item.location ? ` \xB7 ${item.location}` : ""}`
                )
              ),
              createElement(
                "button",
                {
                  type: "button",
                  className: "rounded-md bg-blue-600 px-3 text-caption-2-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50",
                  style: SMALL_PAD,
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
                  className: "rounded-md px-3 text-caption-2-medium text-text-secondary transition-colors hover:bg-button-ghost-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50",
                  style: { paddingTop: "6px", paddingBottom: "6px", border: "1px solid var(--color-border-button-default)" },
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
