// src/jxa.ts
function listCalendarNamesScript() {
  const body = [
    'const app = Application("Calendar");',
    "const names = app.calendars.name();",
    "return JSON.stringify({ ok: true, names: names });"
  ].join("\n");
  return wrapper(body);
}
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
    "events.sort(function (a, b) { return a.startMs - b.startMs || (a.calendar < b.calendar ? -1 : a.calendar > b.calendar ? 1 : 0); });",
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
function listEventsForCalendarNameScript(input) {
  const light = input.light === true;
  const body = [
    `const WANTED = ${js(input.calendarName)};`,
    `const FROM_MS = ${Math.trunc(input.fromMs)};`,
    `const TO_MS = ${Math.trunc(input.toMs)};`,
    `const MAX_ROWS = ${Math.trunc(input.maxRows)};`,
    `const LIGHT = ${light ? "true" : "false"};`,
    'const app = Application("Calendar");',
    "const from = new Date(FROM_MS);",
    "const to = new Date(TO_MS);",
    "const matched = app.calendars.whose({ name: WANTED })();",
    "if (matched.length === 0) {",
    '  return JSON.stringify({ ok: false, code: "no-calendar", error: "\u672A\u627E\u5230\u540D\u4E3A\u300A" + WANTED + "\u300B\u7684\u65E5\u5386", available: [WANTED] });',
    "}",
    "const collected = [];",
    "for (const cal of matched) {",
    "  const cname = cal.name();",
    "  const evts = cal.events.whose({ _and: [{ startDate: { _lessThan: to } }, { endDate: { _greaterThan: from } }] })();",
    "  for (const ev of evts) collected.push([ev, cname]);",
    "}",
    "const events = [];",
    "for (const pair of collected) {",
    "  const ev = pair[0];",
    "  const cname = pair[1];",
    "  const p = ev.properties();",
    "  const startMs = p.startDate.getTime();",
    "  let alarmCount = 0;",
    "  const alarmTimes = [];",
    "  if (!LIGHT) {",
    "    const groups = [ev.displayAlarms(), ev.soundAlarms(), ev.mailAlarms(), ev.openFileAlarms()];",
    "    for (const group of groups) {",
    "      alarmCount += group.length;",
    "      for (const a of group) {",
    "        let t = null;",
    "        try {",
    "          const iv = a.triggerInterval();",
    '          if (typeof iv === "number") t = startMs + iv * 60000;',
    "        } catch (e1) {}",
    "        if (t === null) {",
    "          try {",
    "            const d = a.triggerDate();",
    '            if (d && typeof d.getTime === "function") t = d.getTime();',
    "          } catch (e2) {}",
    "        }",
    "        if (t !== null) alarmTimes.push(t);",
    "      }",
    "    }",
    "  }",
    '  const location = p.location === null || p.location === undefined ? "" : String(p.location);',
    '  const notes = p.description === null || p.description === undefined ? "" : String(p.description);',
    "  const r = p.recurrence;",
    '  const isRecurring = !(r === null || r === undefined || r === "");',
    "  alarmTimes.sort(function (a, b) { return a - b; });",
    "  events.push({",
    "    calendar: cname,",
    "    uid: String(p.uid),",
    "    title: p.summary,",
    "    startMs: startMs,",
    "    endMs: p.endDate.getTime(),",
    "    allDay: p.alldayEvent === true,",
    "    hasAlarm: alarmCount > 0,",
    "    alarmTimes: alarmTimes,",
    "    location: location,",
    "    notes: notes,",
    "    isRecurring: isRecurring,",
    "  });",
    "}",
    "events.sort(function (a, b) { return a.startMs - b.startMs || (a.calendar < b.calendar ? -1 : a.calendar > b.calendar ? 1 : 0); });",
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
    'const hasRecurrence = function (value) { return !(value === null || value === undefined || value === ""); };',
    'const app = Application("Calendar");',
    "const matches = [];",
    "for (const cal of app.calendars()) {",
    "  const hits = cal.events.whose({ uid: UID })();",
    "  for (const event of hits) matches.push([event, cal]);",
    "}",
    "if (matches.length === 0) {",
    '  return JSON.stringify({ ok: false, code: "no-event", error: "\u672A\u627E\u5230 uid \u4E3A " + UID + " \u7684\u65E5\u7A0B\uFF08\u53EF\u80FD\u5DF2\u88AB\u5220\u9664\uFF0C\u6216\u4E0D\u5728\u672C\u673A\u65E5\u5386\u4E2D\uFF09" });',
    "}",
    "if (matches.length > 1) {",
    '  return JSON.stringify({ ok: false, code: "ambiguous-uid", error: "uid " + UID + " \u5728\u591A\u4E2A\u65E5\u5386\u6216\u591A\u6761\u65E5\u7A0B\u4E2D\u91CD\u590D\uFF0C\u65E0\u6CD5\u5B89\u5168\u786E\u5B9A\u8981\u4FEE\u6539\u54EA\u4E00\u6761\uFF1B\u672C\u6B21\u672A\u505A\u4EFB\u4F55\u4FEE\u6539" });',
    "}",
    "const target = matches[0][0];",
    "const targetCal = matches[0][1];",
    // 写前必须严格读取 properties 与 recurrence；任何异常交给外层失败，且此时尚无 setter/delete/create。
    "const original = target.properties();",
    "const recurrence = target.recurrence();",
    "if (hasRecurrence(recurrence) || hasRecurrence(original.recurrence)) {",
    '  return JSON.stringify({ ok: false, code: "recurring-event", error: "\u8BE5 uid \u5BF9\u5E94\u91CD\u590D\u65E5\u7A0B\uFF0C\u65E7\u5199\u5165\u63A5\u53E3\u65E0\u6CD5\u5B89\u5168\u786E\u5B9A\u53D1\u751F\u5B9E\u4F8B\uFF1B\u672C\u6B21\u672A\u505A\u4EFB\u4F55\u4FEE\u6539\uFF0C\u8BF7\u5230\u7CFB\u7EDF\u65E5\u5386\u64CD\u4F5C" });',
    "}",
    "const calendarName = String(targetCal.name());",
    'if (calendarName === "") return JSON.stringify({ ok: false, code: "invalid-calendar", error: "\u76EE\u6807\u65E5\u5386\u540D\u79F0\u4E3A\u7A7A\uFF0C\u672C\u6B21\u672A\u505A\u4EFB\u4F55\u4FEE\u6539" });',
    "const existingAlarms = NEW_ALARMS === null ? null : target.displayAlarms();",
    "const reducingAlarms = NEW_ALARMS !== null && NEW_ALARMS.length < existingAlarms.length;",
    "const title = NEW_TITLE !== null ? NEW_TITLE : String(original.summary);",
    'const notes = NEW_NOTES !== null ? NEW_NOTES : (original.description === null || original.description === undefined ? "" : String(original.description));',
    'const location = NEW_LOCATION !== null ? NEW_LOCATION : (original.location === null || original.location === undefined ? "" : String(original.location));',
    "const startMs = NEW_START !== null ? NEW_START : original.startDate.getTime();",
    "const endMs = NEW_END !== null ? NEW_END : original.endDate.getTime();",
    "const isAllDay = original.alldayEvent === true;",
    "if (reducingAlarms) {",
    // Recreating only the supported text/date/display-alarm fields must not erase unrelated user data.
    "  const otherAlarms = target.soundAlarms().length + target.mailAlarms().length + target.openFileAlarms().length;",
    "  const attendees = target.attendees().length;",
    '  if (otherAlarms > 0 || attendees > 0 || original.status !== "none" ||',
    '      (original.url !== null && original.url !== "") || original.excludedDates.length > 0) {',
    '    return JSON.stringify({ ok: false, code: "unsupported-recreation", error: "\u8BE5\u65E5\u7A0B\u5305\u542B\u5176\u4ED6\u7C7B\u578B\u63D0\u9192\u3001\u53C2\u4E0E\u4EBA\u3001\u94FE\u63A5\u6216\u7279\u6B8A\u72B6\u6001\uFF0C\u51CF\u5C11\u63D0\u9192\u9700\u8981\u91CD\u5EFA\u4F46\u65E0\u6CD5\u5B8C\u6574\u4FDD\u7559\u8FD9\u4E9B\u5185\u5BB9\uFF1B\u672C\u6B21\u672A\u505A\u4EFB\u4F55\u4FEE\u6539\uFF0C\u8BF7\u5728\u7CFB\u7EDF\u65E5\u5386\u4E2D\u8C03\u6574\u63D0\u9192" });',
    "  }",
    "  let creationStarted = false;",
    "  let createdEvent = null;",
    '  let newUid = "";',
    "  let verified = null;",
    "  try {",
    "    const props = { summary: title, startDate: new Date(startMs), endDate: new Date(endMs) };",
    "    if (isAllDay) props.alldayEvent = true;",
    '    if (notes !== "") props.description = notes;',
    '    if (location !== "") props.location = location;',
    "    const ev = app.Event(props);",
    "    createdEvent = ev;",
    "    creationStarted = true;",
    "    targetCal.events.push(ev);",
    "    newUid = String(ev.uid()).trim();",
    "    for (const m of NEW_ALARMS) ev.displayAlarms.push(app.DisplayAlarm({ triggerInterval: -m }));",
    "    const newProps = ev.properties();",
    "    const newRecurrence = ev.recurrence();",
    "    const newAlarms = ev.displayAlarms();",
    "    const newAlarmCount = newAlarms.length;",
    "    let newAlarmValues = true;",
    "    for (let i = 0; i < newAlarms.length; i++) {",
    "      if (newAlarms[i].triggerInterval() !== -NEW_ALARMS[i]) newAlarmValues = false;",
    "    }",
    "    let initialNewMatches = 0;",
    "    for (const cal of app.calendars()) initialNewMatches += cal.events.whose({ uid: newUid })().length;",
    '    if (newUid === "" || newUid === UID || hasRecurrence(newRecurrence) || hasRecurrence(newProps.recurrence) ||',
    "        String(newProps.summary) !== title || newProps.startDate.getTime() !== startMs || newProps.endDate.getTime() !== endMs ||",
    '        (newProps.alldayEvent === true) !== isAllDay || String(newProps.location || "") !== location ||',
    '        String(newProps.description || "") !== notes || newAlarmCount !== NEW_ALARMS.length || !newAlarmValues || initialNewMatches !== 1) {',
    '      throw new Error("\u65B0\u65E5\u7A0B\u56DE\u8BFB\u6821\u9A8C\u4E0D\u4E00\u81F4");',
    "    }",
    '    verified = { uid: newUid, title: String(newProps.summary), startMs: newProps.startDate.getTime(), endMs: newProps.endDate.getTime(), allDay: newProps.alldayEvent === true, location: String(newProps.location || ""), notes: String(newProps.description || ""), alarmCount: newAlarmCount };',
    "  } catch (createError) {",
    '    if (newUid === "" && creationStarted && createdEvent !== null) {',
    "      try { newUid = String(createdEvent.uid()).trim(); } catch (uidError) {}",
    "    }",
    "    if (!creationStarted) {",
    '      return JSON.stringify({ ok: false, code: "recreate-failed", error: "\u65E0\u6CD5\u521B\u5EFA\u66FF\u4EE3\u65E5\u7A0B\uFF0C\u539F\u65E5\u7A0B\u4ECD\u4FDD\u7559\u4E14\u672A\u5220\u9664\uFF1A" + String(createError && createError.message ? createError.message : createError) });',
    "    }",
    '    return JSON.stringify({ ok: false, code: "update-result-unknown", newUid: newUid, error: "\u66FF\u4EE3\u65E5\u7A0B\u521B\u5EFA\u540E\u6821\u9A8C\u5931\u8D25\uFF0C\u7ED3\u679C\u672A\u77E5\uFF0C\u53EF\u80FD\u6709\u65B0\u65E7\u4E24\u9879\u3002\u8BF7\u5230\u65E5\u5386.app \u6838\u5BF9" + (newUid ? "\uFF08\u65B0 uid\uFF1A" + newUid + "\uFF09" : "") + "\uFF1B\u4E0D\u8981\u81EA\u52A8\u91CD\u8BD5" });',
    "  }",
    "  try {",
    "    app.delete(target);",
    "    let oldRemaining = 0;",
    "    let newMatches = 0;",
    "    for (const cal of app.calendars()) {",
    "      oldRemaining += cal.events.whose({ uid: UID })().length;",
    "      newMatches += cal.events.whose({ uid: newUid })().length;",
    "    }",
    '    if (oldRemaining !== 0 || newMatches !== 1) throw new Error("\u65B0\u65E7\u65E5\u7A0B\u6570\u91CF\u56DE\u8BFB\u4E0D\u4E00\u81F4");',
    "  } catch (deleteError) {",
    '    return JSON.stringify({ ok: false, code: "update-result-unknown", newUid: newUid, error: "\u66FF\u4EE3\u65E5\u7A0B\u5DF2\u521B\u5EFA\uFF0C\u4F46\u5220\u9664\u539F\u65E5\u7A0B\u6216\u56DE\u8BFB\u6838\u5BF9\u5931\u8D25\uFF0C\u7ED3\u679C\u672A\u77E5\uFF0C\u53EF\u80FD\u6709\u65B0\u65E7\u4E24\u9879\u3002\u8BF7\u5230\u65E5\u5386.app \u6309\u65B0 uid " + newUid + " \u6838\u5BF9\uFF1B\u4E0D\u8981\u81EA\u52A8\u91CD\u8BD5" });',
    "  }",
    "  return JSON.stringify({ ok: true, uid: verified.uid, recreated: true, calendar: calendarName, title: verified.title, startMs: verified.startMs, endMs: verified.endMs, allDay: verified.allDay, location: verified.location, notes: verified.notes, alarmCount: verified.alarmCount });",
    "}",
    "try {",
    "  if (NEW_TITLE !== null) target.summary = NEW_TITLE;",
    "  if (NEW_NOTES !== null) target.description = NEW_NOTES;",
    "  if (NEW_LOCATION !== null) target.location = NEW_LOCATION;",
    "  if (NEW_START !== null) target.startDate = new Date(NEW_START);",
    "  if (NEW_END !== null) target.endDate = new Date(NEW_END);",
    "  if (NEW_ALARMS !== null) {",
    "    for (let i = 0; i < existingAlarms.length; i++) existingAlarms[i].triggerInterval = -NEW_ALARMS[i];",
    "    for (let i = existingAlarms.length; i < NEW_ALARMS.length; i++) target.displayAlarms.push(app.DisplayAlarm({ triggerInterval: -NEW_ALARMS[i] }));",
    "  }",
    "  const checked = target.properties();",
    "  const checkedRecurrence = target.recurrence();",
    "  const checkedUid = String(target.uid()).trim();",
    "  const checkedAlarms = target.displayAlarms();",
    "  let checkedMatches = 0;",
    "  for (const cal of app.calendars()) checkedMatches += cal.events.whose({ uid: UID })().length;",
    "  let checkedAlarmValues = true;",
    "  if (NEW_ALARMS !== null) {",
    "    for (let i = 0; i < checkedAlarms.length; i++) {",
    "      if (checkedAlarms[i].triggerInterval() !== -NEW_ALARMS[i]) checkedAlarmValues = false;",
    "    }",
    "  }",
    "  if (checkedUid !== UID || checkedMatches !== 1 || hasRecurrence(checkedRecurrence) || hasRecurrence(checked.recurrence) ||",
    "      String(checked.summary) !== title || checked.startDate.getTime() !== startMs || checked.endDate.getTime() !== endMs ||",
    '      (checked.alldayEvent === true) !== isAllDay || String(checked.location || "") !== location || String(checked.description || "") !== notes ||',
    '      (NEW_ALARMS !== null && (checkedAlarms.length !== NEW_ALARMS.length || !checkedAlarmValues))) throw new Error("\u4FEE\u6539\u540E\u56DE\u8BFB\u6821\u9A8C\u4E0D\u4E00\u81F4");',
    '  return JSON.stringify({ ok: true, uid: checkedUid, recreated: false, calendar: calendarName, title: String(checked.summary), startMs: checked.startDate.getTime(), endMs: checked.endDate.getTime(), allDay: checked.alldayEvent === true, location: String(checked.location || ""), notes: String(checked.description || ""), alarmCount: checkedAlarms.length });',
    "} catch (updateError) {",
    '  return JSON.stringify({ ok: false, code: "update-result-unknown", error: "\u65E5\u7A0B\u4FEE\u6539\u5DF2\u5F00\u59CB\uFF0C\u4F46\u5199\u540E\u56DE\u8BFB\u6838\u5BF9\u5931\u8D25\uFF0C\u7ED3\u679C\u672A\u77E5\u3002\u8BF7\u5230\u65E5\u5386.app \u6838\u5BF9\uFF1B\u4E0D\u8981\u81EA\u52A8\u91CD\u8BD5\uFF08" + String(updateError && updateError.message ? updateError.message : updateError) + "\uFF09" });',
    "}"
  ].join("\n");
  return wrapper(body);
}
function deleteEventScript(input) {
  const body = [
    `const UID = ${js(input.uid)};`,
    `const CONFIRM = ${input.confirm ? "true" : "false"};`,
    'const hasRecurrence = function (value) { return !(value === null || value === undefined || value === ""); };',
    "if (CONFIRM !== true) {",
    '  return JSON.stringify({ ok: false, code: "confirm-required", error: "\u5220\u9664\u65E5\u7A0B\u9700\u8981\u660E\u786E\u786E\u8BA4\uFF1A\u8BF7\u8BA9\u5F8B\u5E08\u786E\u8BA4\u540E\u4EE5 confirm=true \u91CD\u8BD5" });',
    "}",
    'const app = Application("Calendar");',
    "const matches = [];",
    "for (const cal of app.calendars()) {",
    "  const hits = cal.events.whose({ uid: UID })();",
    "  for (const event of hits) matches.push([event, cal]);",
    "}",
    "if (matches.length === 0) {",
    '  return JSON.stringify({ ok: false, code: "no-event", error: "\u672A\u627E\u5230 uid \u4E3A " + UID + " \u7684\u65E5\u7A0B\uFF08\u53EF\u80FD\u5DF2\u88AB\u5220\u9664\uFF0C\u6216\u4E0D\u5728\u672C\u673A\u65E5\u5386\u4E2D\uFF09" });',
    "}",
    "if (matches.length > 1) {",
    '  return JSON.stringify({ ok: false, code: "ambiguous-uid", error: "uid " + UID + " \u5728\u591A\u4E2A\u65E5\u5386\u6216\u591A\u6761\u65E5\u7A0B\u4E2D\u91CD\u590D\uFF0C\u65E0\u6CD5\u5B89\u5168\u786E\u5B9A\u8981\u5220\u9664\u54EA\u4E00\u6761\uFF1B\u672C\u6B21\u672A\u505A\u4EFB\u4F55\u5220\u9664" });',
    "}",
    "const target = matches[0][0];",
    "const targetCal = matches[0][1];",
    "const original = target.properties();",
    "const recurrence = target.recurrence();",
    "if (hasRecurrence(recurrence) || hasRecurrence(original.recurrence)) {",
    '  return JSON.stringify({ ok: false, code: "recurring-event", error: "\u8BE5 uid \u5BF9\u5E94\u91CD\u590D\u65E5\u7A0B\uFF0C\u65E7\u5199\u5165\u63A5\u53E3\u65E0\u6CD5\u5B89\u5168\u786E\u5B9A\u53D1\u751F\u5B9E\u4F8B\uFF1B\u672C\u6B21\u672A\u505A\u4EFB\u4F55\u5220\u9664\uFF0C\u8BF7\u5230\u7CFB\u7EDF\u65E5\u5386\u64CD\u4F5C" });',
    "}",
    "const title = String(original.summary);",
    "const startMs = original.startDate.getTime();",
    "const endMs = original.endDate.getTime();",
    "const calendar = String(targetCal.name());",
    'if (calendar === "") return JSON.stringify({ ok: false, code: "invalid-calendar", error: "\u76EE\u6807\u65E5\u5386\u540D\u79F0\u4E3A\u7A7A\uFF0C\u672C\u6B21\u672A\u505A\u4EFB\u4F55\u5220\u9664" });',
    "try {",
    "  app.delete(target);",
    "  let remaining = 0;",
    "  for (const cal of app.calendars()) remaining += cal.events.whose({ uid: UID })().length;",
    "  if (remaining !== 0) {",
    '    return JSON.stringify({ ok: false, code: "delete-not-confirmed", uid: UID, remaining: remaining, error: "\u5220\u9664\u540E\u4ECD\u67E5\u5230 " + remaining + " \u6761\u540C uid \u65E5\u7A0B\uFF0C\u4E0D\u80FD\u786E\u8BA4\u5220\u9664\u6210\u529F\u3002\u8BF7\u5230\u65E5\u5386.app \u6838\u5BF9\uFF1B\u4E0D\u8981\u81EA\u52A8\u91CD\u8BD5" });',
    "  }",
    "  return JSON.stringify({ ok: true, uid: UID, calendar: calendar, title: title, startMs: startMs, endMs: endMs, deleted: 1, remaining: 0 });",
    "} catch (deleteError) {",
    '  return JSON.stringify({ ok: false, code: "delete-result-unknown", uid: UID, error: "\u5220\u9664\u5DF2\u5F00\u59CB\uFF0C\u4F46\u5220\u9664\u6216\u5199\u540E\u56DE\u8BFB\u5931\u8D25\uFF0C\u7ED3\u679C\u672A\u77E5\u3002\u8BF7\u5230\u65E5\u5386.app \u6838\u5BF9\uFF1B\u4E0D\u8981\u81EA\u52A8\u91CD\u8BD5\uFF08" + String(deleteError && deleteError.message ? deleteError.message : deleteError) + "\uFF09" });',
    "}"
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
function renderOccurrence(event) {
  const s = partsOf(event.startMs);
  const inclusiveEnd = partsOf(Math.max(event.startMs, event.endMs - 1));
  const sameAllDay = s.y === inclusiveEnd.y && s.mo === inclusiveEnd.mo && s.d === inclusiveEnd.d;
  const when = event.allDay ? `${pad2(s.mo)}-${pad2(s.d)}\uFF08${s.weekday}\uFF09\u5168\u5929${sameAllDay ? "" : ` \uFF5E ${inclusiveEnd.y}-${pad2(inclusiveEnd.mo)}-${pad2(inclusiveEnd.d)} \u5168\u5929`}` : formatRange(event.startMs, event.endMs);
  const recurring = event.isRecurring || event.isDetached;
  const identity = recurring ? "\u53EA\u8BFB\u67E5\u770B\uFF08\u91CD\u590D\u5B9E\u4F8B\u8BF7\u5728\u7CFB\u7EDF\u65E5\u5386\u4E2D\u4FEE\u6539/\u5220\u9664\uFF09" : event.editableUid ? `uid\uFF1A${event.editableUid}` : "\u53EA\u8BFB\u67E5\u770B\uFF08\u7CFB\u7EDF\u672A\u63D0\u4F9B\u53EF\u5B89\u5168\u7528\u4E8E\u4FEE\u6539/\u5220\u9664\u7684 uid\uFF09";
  const parts = [
    `- ${when} \xB7 ${event.title === "" ? "\u672A\u586B\u5199\u6807\u9898" : event.title}`,
    event.location ? `\u5730\u70B9\uFF1A${event.location}` : "",
    `\u65E5\u5386\u300A${event.calendar}\u300B`,
    event.alarmTimes.length > 0 ? `\u63D0\u9192 ${event.alarmTimes.map((ms) => formatAlarmTrigger(ms, event.startMs)).join("\u3001")}` : event.hasAlarm ? "\u6709\u63D0\u9192" : "\u65E0\u63D0\u9192",
    recurring ? event.isDetached ? "\u91CD\u590D\u65E5\u7A0B\uFF08\u672C\u6B21\u5DF2\u5355\u72EC\u8C03\u6574\uFF09" : "\u91CD\u590D\u65E5\u7A0B" : "",
    event.notes ? `\u5907\u6CE8\uFF1A${truncateText(event.notes)}` : "",
    event.fieldsTruncated ? "\u90E8\u5206\u8BE6\u60C5\u56E0\u8BFB\u53D6\u5927\u5C0F\u9650\u5236\u5DF2\u622A\u65AD" : "",
    identity
  ];
  return parts.filter(Boolean).join(" \xB7 ");
}
function renderOccurrenceList(input) {
  const window = `${formatDateTime(input.fromMs)} \uFF5E ${formatDateTime(input.toMs)}`;
  if (input.total === 0) return `\u672A\u6765 ${input.days} \u5929\uFF08${window}\uFF0C\u5317\u4EAC\u65F6\u95F4\uFF09\u6CA1\u6709\u65E5\u7A0B\u3002`;
  const lines = [
    `\u672A\u6765 ${input.days} \u5929\uFF08${window}\uFF0C\u5317\u4EAC\u65F6\u95F4\uFF0C\u542B\u91CD\u590D\u5B9E\u4F8B\u3001\u8FDB\u884C\u4E2D/\u8DE8\u7A97\u65E5\u7A0B\uFF09\u5171 ${input.total} \u6761\u65E5\u7A0B\uFF1A`,
    ...input.occurrences.map(renderOccurrence)
  ];
  if (input.truncated) {
    lines.push(`\uFF08\u7ED3\u679C\u8D85\u8FC7\u5B89\u5168\u8BFB\u53D6\u4E0A\u9650\uFF0C\u4EC5\u663E\u793A ${input.occurrences.length}/${input.total} \u6761\uFF1B\u8FD9\u4E0D\u662F\u5B8C\u6574\u5217\u8868\uFF0C\u53EF\u7F29\u77ED\u5929\u6570\u6216\u6307\u5B9A\u65E5\u5386\uFF09`);
  }
  if (input.contentTruncated) {
    lines.push("\uFF08\u90E8\u5206\u8D85\u957F\u8BE6\u60C5\u5DF2\u6309\u771F\u5B9E\u5B57\u8282\u4E0A\u9650\u7F29\u77ED\uFF1B\u6807\u9898\u3001\u65F6\u95F4\u548C\u5B9E\u4F8B\u8EAB\u4EFD\u4ECD\u4FDD\u7559\uFF0C\u5B8C\u6574\u5185\u5BB9\u8BF7\u5230\u65E5\u5386.app \u67E5\u770B\uFF09");
  }
  const hasEditable = input.occurrences.some((event) => event.editableUid !== null && !event.isRecurring && !event.isDetached);
  const hasRecurring = input.occurrences.some((event) => event.isRecurring || event.isDetached);
  if (hasEditable) lines.push("\uFF08\u4EC5\u975E\u91CD\u590D\u4E14\u5E26 uid \u7684\u65E5\u7A0B\u53EF\u7528\u4E8E calendar_update / calendar_delete\uFF1B\u5220\u9664\u4ECD\u987B\u5F8B\u5E08\u786E\u8BA4\uFF09");
  if (hasRecurring) lines.push("\uFF08\u91CD\u590D\u65E5\u7A0B\u53CA\u5355\u6B21\u4F8B\u5916\u4E0D\u5411\u65E7\u5199\u5165\u5DE5\u5177\u63D0\u4F9B\u7CFB\u5217 uid\uFF1B\u5982\u9700\u4FEE\u6539\u6216\u5220\u9664\u67D0\u4E00\u6B21\u53D1\u751F\uFF0C\u8BF7\u5230\u7CFB\u7EDF\u65E5\u5386\u64CD\u4F5C\uFF09");
  if (!hasEditable && !hasRecurring) {
    lines.push("\uFF08\u672C\u6B21\u7ED3\u679C\u6CA1\u6709\u7CFB\u7EDF\u53EF\u5B89\u5168\u63D0\u4F9B\u7ED9\u65E7\u4FEE\u6539/\u5220\u9664\u5DE5\u5177\u7684 uid\uFF0C\u56E0\u6B64\u4EC5\u4F9B\u67E5\u770B\uFF1B\u4E0D\u4F1A\u7528 EventKit \u5185\u90E8\u6807\u8BC6\u731C\u8865\uFF09");
  }
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

// src/reminders-jxa.ts
var quote = (value) => JSON.stringify(value);
function wrap(lines) {
  return [
    "(function () {",
    "try {",
    'const app = Application("Reminders");',
    ...lines,
    "} catch (e) { return JSON.stringify({ok:false,error:String(e && e.message ? e.message : e)}); }",
    "})()"
  ].join("\n");
}
var snapshot = [
  "function utf8Bytes(text) { let n=0; for(let i=0;i<text.length;i++){const c=text.charCodeAt(i);if(c<128)n++;else if(c<2048)n+=2;else if(c>=0xD800&&c<=0xDBFF&&i+1<text.length&&text.charCodeAt(i+1)>=0xDC00&&text.charCodeAt(i+1)<=0xDFFF){n+=4;i++}else n+=3}return n; }",
  'function dateMs(value) { try { return value && typeof value.getTime === "function" && Number.isFinite(value.getTime()) ? value.getTime() : null; } catch (_) { return null; } }',
  'function row(r) { const p=r.properties(); return { id:String(p.id), title:String(p.name || ""), list:String(p.container.name()), notes:String(p.body || ""), dueMs:dateMs(p.dueDate), remindMs:dateMs(p.remindMeDate), completed:p.completed === true }; }'
];
function listRemindersScript(fromMs, toMs, maxRows) {
  return wrap([
    ...snapshot,
    `const FROM = new Date(${Math.trunc(fromMs - 1)});`,
    `const TO = new Date(${Math.trunc(toMs)});`,
    `const LIMIT = ${Math.trunc(maxRows)};`,
    "const between = { _greaterThan: FROM, _lessThan: TO };",
    "const matches = app.reminders.whose({ _or: [{ dueDate: between }, { remindMeDate: between }] });",
    "const total = matches.length;",
    "const ids = matches.id(), titles = matches.name(), lists = matches.container.name();",
    "const notes = matches.body(), dues = matches.dueDate(), reminds = matches.remindMeDate(), completed = matches.completed();",
    'if ([ids,titles,lists,notes,dues,reminds,completed].some(function(values){return !Array.isArray(values)||values.length!==total})) return JSON.stringify({ok:false,error:"\u63D0\u9192\u4E8B\u9879\u6279\u91CF\u8BFB\u53D6\u6570\u91CF\u4E0D\u4E00\u81F4"});',
    "const reminders = [];",
    "let usedBytes = 200;",
    "for (let i = 0; i < total; i++) {",
    "  if (reminders.length >= LIMIT) break;",
    '  const item = {id:String(ids[i]),title:String(titles[i]||""),list:String(lists[i]),notes:String(notes[i]||""),dueMs:dateMs(dues[i]),remindMs:dateMs(reminds[i]),completed:completed[i]===true};',
    "  const bytes = utf8Bytes(JSON.stringify(item)) + 1;",
    "  if (usedBytes + bytes > 59000) break;",
    "  reminders.push(item); usedBytes += bytes;",
    "}",
    "return JSON.stringify({ok:true,total:total,truncated:total > reminders.length,reminders:reminders});"
  ]);
}
function find(id) {
  return [
    `const ID = ${quote(id)};`,
    "const matches = app.reminders.whose({id:ID});",
    'if (matches.length !== 1) return JSON.stringify({ok:false,error:"\u672A\u627E\u5230\u552F\u4E00\u7684\u63D0\u9192\u4E8B\u9879\uFF0C\u8BF7\u5237\u65B0\u540E\u91CD\u8BD5"});',
    "const r = matches[0];"
  ];
}
function updateReminderScript(input) {
  const changes = [
    ...input.title === void 0 ? [] : [`r.name = ${quote(input.title)};`],
    ...input.notes === void 0 ? [] : [`r.body = ${quote(input.notes)};`],
    ...input.dueMs === void 0 ? [] : [`r.dueDate = new Date(${Math.trunc(input.dueMs)});`],
    ...input.remindMs === void 0 ? [] : [`r.remindMeDate = new Date(${Math.trunc(input.remindMs)});`]
  ];
  return wrap([...snapshot, ...find(input.id), ...changes, "return JSON.stringify({ok:true,reminder:row(r)});"]);
}
function setReminderCompletedScript(id, completed) {
  return wrap([...snapshot, ...find(id), `r.completed = ${completed ? "true" : "false"};`, "return JSON.stringify({ok:true,reminder:row(r)});"]);
}
function deleteReminderScript(id) {
  return wrap([...find(id), "r.delete();", "return JSON.stringify({ok:true,deleted:1});"]);
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
function isTimeoutDetail(detail) {
  return /timed?[\s-]?out|timeout|超时/i.test(detail);
}
function isWriteOp(op) {
  return /写入|修改|删除|创建|完成/.test(op);
}
function timeoutError(op) {
  if (isWriteOp(op)) {
    return new CalendarError(
      `\u65E5\u5386.app \u64CD\u4F5C\u8D85\u65F6\uFF08${op}\uFF0C\u5DF2\u7B49 30 \u79D2\uFF09\uFF1A\u64CD\u4F5C\u7ED3\u679C\u672A\u786E\u8BA4\u2014\u2014\u8BF7\u5148\u5230\u65E5\u5386.app \u6838\u5BF9\u662F\u5426\u5DF2\u751F\u6548\uFF0C\u518D\u51B3\u5B9A\u662F\u5426\u91CD\u8BD5\uFF1B\u672A\u6838\u5BF9\u524D\u4E0D\u8981\u91CD\u590D\u64CD\u4F5C\u3002`,
      "calendar"
    );
  }
  return new CalendarError(
    `\u8BFB\u53D6\u65E5\u5386\u8D85\u65F6\uFF08${op}\uFF0C\u5DF2\u7B49 30 \u79D2\uFF09\uFF1A\u65E5\u5386.app \u54CD\u5E94\u592A\u6162\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\uFF1B\u8FD9\u6B21\u8BFB\u53D6\u6CA1\u6709\u5B8C\u6210\uFF0C\u4E0D\u4EE3\u8868\u8FD9\u4E00\u5929\u6CA1\u6709\u5B89\u6392\u3002`,
    "calendar"
  );
}
function remindersTimeoutError(op) {
  if (isWriteOp(op)) {
    return new CalendarError(
      `\u63D0\u9192\u4E8B\u9879.app \u64CD\u4F5C\u8D85\u65F6\uFF08${op}\uFF0C\u5DF2\u7B49 30 \u79D2\uFF09\uFF1A\u64CD\u4F5C\u7ED3\u679C\u672A\u786E\u8BA4\u2014\u2014\u8BF7\u5148\u5230\u7CFB\u7EDF\u300C\u63D0\u9192\u4E8B\u9879\u300DApp \u6838\u5BF9\u662F\u5426\u5DF2\u751F\u6548\uFF0C\u518D\u51B3\u5B9A\u662F\u5426\u91CD\u8BD5\u3002`,
      "calendar"
    );
  }
  return new CalendarError(`\u63D0\u9192\u4E8B\u9879.app \u8BFB\u53D6\u8D85\u65F6\uFF08${op}\uFF0C\u5DF2\u7B49 30 \u79D2\uFF09\uFF1A\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002`, "calendar");
}
function automationHint(op, detail) {
  return new CalendarError(
    `\u65E0\u6CD5\u8BBF\u95EE macOS\u300C\u65E5\u5386\u300DApp\uFF08${op}\u5931\u8D25\uFF09\uFF1A\u8BF7\u5728 \u7CFB\u7EDF\u8BBE\u7F6E \u2192 \u9690\u79C1\u4E0E\u5B89\u5168\u6027 \u2192 \u81EA\u52A8\u5316 \u4E2D\uFF0C\u5141\u8BB8 LawyerCopilot \u63A7\u5236\u300C\u65E5\u5386\u300D\uFF0C\u7136\u540E\u91CD\u8BD5\u3002\u82E5\u5217\u8868\u91CC\u6CA1\u6709\u8BE5\u9879\uFF0C\u5148\u91CD\u542F LawyerCopilot \u5E76\u5728\u5F39\u7A97\u4E2D\u70B9\u300C\u597D\u300D\u3002\uFF08\u539F\u59CB\u9519\u8BEF\uFF1A${detail || "\u65E0\u8F93\u51FA"}\uFF09`,
    "bridge"
  );
}
async function execRun(bridge, op, timeoutErrorOf, bin, args, timeoutMs) {
  let raw;
  try {
    raw = await bridge.invoke("plugin_exec_run", { bin, args, timeoutMs });
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    if (isTimeoutDetail(detail)) throw timeoutErrorOf(op);
    throw new CalendarError(
      `\u65E0\u6CD5\u6267\u884C\u7CFB\u7EDF\u547D\u4EE4 ${bin}\uFF08${detail}\uFF09\u3002\u8BF7\u786E\u8BA4\u63D2\u4EF6\u7248\u672C\u4E0D\u4F4E\u4E8E manifest \u8981\u6C42\uFF0C\u4E14\u5DF2\u6388\u4E88 osascript / open \u6267\u884C\u6743\u9650\u3002`,
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
    await execRun(bridge, "\u540E\u53F0\u5524\u8D77\u65E5\u5386.app", timeoutError, "open", ["-a", "Calendar", "-g"], OPEN_TIMEOUT_MS);
  } catch {
  }
}
async function runJxa(bridge, op, script) {
  await ensureCalendarRunning(bridge);
  const result = await execRun(bridge, op, timeoutError, "osascript", ["-l", "JavaScript", "-e", script], OSASCRIPT_TIMEOUT_MS);
  const output = (result.stdout ?? "").trim();
  if (result.code !== 0 || !output) {
    const detail = firstLine(result.stderr || result.stdout);
    if (isTimeoutDetail(detail)) throw timeoutError(op);
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
  const result = await execRun(bridge, op, remindersTimeoutError, "osascript", ["-l", "JavaScript", "-e", script], OSASCRIPT_TIMEOUT_MS);
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
function parseReminderRow(entry) {
  if (!isRecord2(entry) || typeof entry.id !== "string" || entry.id.trim() === "" || typeof entry.title !== "string" || typeof entry.list !== "string" || entry.list.trim() === "" || typeof entry.notes !== "string" || typeof entry.completed !== "boolean" || !(entry.dueMs === null || typeof entry.dueMs === "number" && Number.isFinite(entry.dueMs)) || !(entry.remindMs === null || typeof entry.remindMs === "number" && Number.isFinite(entry.remindMs))) {
    throw new CalendarError("\u63D0\u9192\u4E8B\u9879\u8FD4\u56DE\u7684\u6570\u636E\u4E0D\u5B8C\u6574\uFF0C\u672A\u628A\u5B83\u5F53\u6210\u540C\u6B65\u6210\u529F\u3002", "calendar");
  }
  return {
    id: entry.id,
    title: entry.title,
    list: entry.list,
    notes: entry.notes,
    dueMs: entry.dueMs,
    remindMs: entry.remindMs,
    completed: entry.completed
  };
}
function parseEventRow(entry) {
  if (!isRecord2(entry)) return null;
  const startMs = asNumber(entry.startMs);
  const endMs = asNumber(entry.endMs);
  if (typeof entry.title !== "string") return null;
  const title = entry.title;
  const calendar = asString(entry.calendar);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || !calendar) return null;
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
  let reminderChain = Promise.resolve();
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
  function enqueueReminder(op, task) {
    const queuedAt = Date.now();
    const run = reminderChain.then(() => {
      if (Date.now() - queuedAt > queueMaxWaitMs) {
        throw new CalendarError(`\u63D0\u9192\u4E8B\u9879\u64CD\u4F5C\uFF08${op}\uFF09\u7B49\u5F85\u8FC7\u4E45\uFF0C\u5DF2\u5728\u6267\u884C\u524D\u53D6\u6D88\uFF1B\u672C\u6B21\u672A\u5199\u5165\u3002\u8BF7\u5237\u65B0\u540E\u91CD\u8BD5\u3002`, "bridge");
      }
      return task();
    });
    reminderChain = run.then(() => void 0, () => void 0);
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
    async listEventsByCalendarName(input, options2 = {}) {
      const alarmsRead = input.light !== true;
      if (options2.shouldContinue !== void 0 && !options2.shouldContinue()) {
        return { canceled: true, events: [], total: 0, truncated: false, alarmsRead };
      }
      const CANCELED = Symbol("canceled");
      let namesPayload;
      try {
        namesPayload = await enqueue("\u8BFB\u53D6\u65E5\u5386\u540D\u5217\u8868", async () => {
          if (options2.shouldContinue !== void 0 && !options2.shouldContinue()) return CANCELED;
          return runJxa(bridge, "\u8BFB\u53D6\u65E5\u5386\u540D\u5217\u8868", listCalendarNamesScript());
        });
      } catch (cause) {
        if (cause instanceof CalendarError) {
          throw new CalendarError(`\u8BFB\u53D6\u65E5\u5386\u540D\u5217\u8868\u5931\u8D25\uFF1A${cause.message}`, cause.kind);
        }
        throw cause;
      }
      if (namesPayload === CANCELED) {
        return { canceled: true, events: [], total: 0, truncated: false, alarmsRead };
      }
      const rawNames = namesPayload.names;
      if (!Array.isArray(rawNames)) throw new CalendarError("\u65E5\u5386.app \u8FD4\u56DE\u7684\u65E5\u5386\u540D\u5217\u8868\u683C\u5F0F\u4E0D\u6B63\u786E", "calendar");
      for (const raw of rawNames) {
        if (typeof raw !== "string" || raw === "") {
          throw new CalendarError("\u65E5\u5386.app \u8FD4\u56DE\u7684\u65E5\u5386\u540D\u5217\u8868\u683C\u5F0F\u4E0D\u6B63\u786E\uFF08\u5B58\u5728\u975E\u5B57\u7B26\u4E32\u6216\u7A7A\u540D\u79F0\uFF09", "calendar");
        }
      }
      const names = [];
      for (const raw of rawNames) {
        if (!names.includes(raw)) names.push(raw);
      }
      const collected = [];
      let totalFromGroups = 0;
      let truncatedFromGroups = false;
      for (let i = 0; i < names.length; i++) {
        if (options2.shouldContinue !== void 0 && !options2.shouldContinue()) {
          return { canceled: true, events: [], total: 0, truncated: false, alarmsRead };
        }
        const name = names[i];
        const op = `\u67E5\u8BE2\u65E5\u7A0B\u300A${name}\u300B`;
        let outcome;
        try {
          outcome = await enqueue(op, async () => {
            if (options2.shouldContinue !== void 0 && !options2.shouldContinue()) return CANCELED;
            return runJxa(
              bridge,
              op,
              listEventsForCalendarNameScript({
                calendarName: name,
                fromMs: input.fromMs,
                toMs: input.toMs,
                maxRows: input.maxRows,
                light: input.light === true
              })
            );
          });
        } catch (cause) {
          if (cause instanceof CalendarError) {
            throw new CalendarError(`\u8BFB\u53D6\u65E5\u5386\u300A${name}\u300B\u5931\u8D25\uFF08\u5DF2\u8BFB ${i}/${names.length} \u4E2A\u65E5\u5386\uFF09\uFF1A${cause.message}`, cause.kind);
          }
          throw cause;
        }
        if (outcome === CANCELED) {
          return { canceled: true, events: [], total: 0, truncated: false, alarmsRead };
        }
        const payload = outcome;
        const events = payload.events;
        if (!Array.isArray(events)) throw new CalendarError("\u65E5\u5386.app \u8FD4\u56DE\u7684\u65E5\u7A0B\u5217\u8868\u683C\u5F0F\u4E0D\u6B63\u786E", "calendar");
        for (const entry of events) {
          const row = parseEventRow(entry);
          if (row === null) throw new CalendarError(`\u65E5\u5386\u300A${name}\u300B\u8FD4\u56DE\u4E86\u65E0\u6CD5\u89E3\u6790\u7684\u65E5\u7A0B\u884C\uFF08\u5B57\u6BB5\u7F3A\u5931\uFF09`, "calendar");
          collected.push(row);
        }
        const groupTotal = payload.total;
        if (typeof groupTotal !== "number" || !Number.isSafeInteger(groupTotal) || groupTotal < 0 || groupTotal < events.length) {
          throw new CalendarError(
            `\u65E5\u5386\u300A${name}\u300B\u8FD4\u56DE\u7684\u65E5\u7A0B\u603B\u6570\u4E0D\u6B63\u786E\uFF08total=${String(groupTotal)}\uFF0C\u5DF2\u53D6\u56DE ${events.length} \u6761\uFF09`,
            "calendar"
          );
        }
        const groupTruncated = payload.truncated;
        if (typeof groupTruncated !== "boolean" || groupTruncated !== groupTotal > events.length) {
          throw new CalendarError(
            `\u65E5\u5386\u300A${name}\u300B\u8FD4\u56DE\u7684\u622A\u65AD\u6807\u5FD7\u4E0E\u603B\u6570\u77DB\u76FE\uFF08truncated=${String(groupTruncated)}\uFF0Ctotal=${groupTotal}\uFF0C\u5DF2\u53D6\u56DE ${events.length} \u6761\uFF09`,
            "calendar"
          );
        }
        totalFromGroups += groupTotal;
        truncatedFromGroups = truncatedFromGroups || groupTruncated;
        options2.onProgress?.(i + 1, names.length);
      }
      collected.sort((a, b) => a.startMs - b.startMs || (a.calendar < b.calendar ? -1 : a.calendar > b.calendar ? 1 : 0));
      const truncated = truncatedFromGroups || collected.length > input.maxRows;
      const total = totalFromGroups;
      return {
        canceled: false,
        events: truncated ? collected.slice(0, input.maxRows) : collected,
        total,
        truncated,
        alarmsRead
      };
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
      const rawUid = payload.uid;
      const uid = typeof rawUid === "string" ? rawUid.trim() : "";
      const recreated = payload.recreated;
      const calendar = payload.calendar;
      const title = payload.title;
      const allDay = payload.allDay;
      const location = payload.location;
      const notes = payload.notes;
      const alarmCount = payload.alarmCount;
      const malformed = uid === "" || uid.length > 200 || rawUid !== uid || typeof recreated !== "boolean" || typeof calendar !== "string" || calendar === "" || typeof title !== "string" || !Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs) || typeof allDay !== "boolean" || typeof location !== "string" || typeof notes !== "string" || typeof alarmCount !== "number" || !Number.isSafeInteger(alarmCount) || alarmCount < 0 || (recreated ? uid === input.uid : uid !== input.uid) || input.title !== void 0 && title !== input.title || input.startMs !== void 0 && startMs !== input.startMs || input.endMs !== void 0 && endMs !== input.endMs || input.location !== void 0 && location !== input.location || input.notes !== void 0 && notes !== input.notes || input.alarmMinutes !== void 0 && alarmCount !== input.alarmMinutes.length;
      if (malformed) {
        const newUidHint = recreated === true && uid !== "" ? `\uFF08\u53EF\u80FD\u7684\u65B0 uid\uFF1A${uid}\uFF09` : "";
        throw new CalendarError(
          `\u65E5\u7A0B\u4FEE\u6539\u5DF2\u6267\u884C\uFF0C\u4F46\u5199\u540E\u56DE\u8BFB\u65E0\u6CD5\u786E\u8BA4\u7ED3\u679C${newUidHint}\u3002\u8BF7\u5230\u65E5\u5386.app \u6838\u5BF9\uFF0C\u53EF\u80FD\u5B58\u5728\u65B0\u65E7\u4E24\u9879\uFF1B\u672A\u6838\u5BF9\u524D\u4E0D\u8981\u81EA\u52A8\u91CD\u8BD5\u3002`,
          "calendar"
        );
      }
      return {
        uid,
        recreated,
        calendar,
        title,
        startMs,
        endMs,
        allDay,
        location,
        notes,
        alarmCount
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
      const uid = payload.uid;
      const calendar = payload.calendar;
      const title = payload.title;
      const startMs = payload.startMs;
      const endMs = payload.endMs;
      const deleted = payload.deleted;
      const remaining = payload.remaining;
      if (typeof uid !== "string" || uid === "" || uid.length > 200 || uid !== uid.trim() || uid !== input.uid || typeof calendar !== "string" || calendar === "" || typeof title !== "string" || typeof startMs !== "number" || !Number.isSafeInteger(startMs) || typeof endMs !== "number" || !Number.isSafeInteger(endMs) || deleted !== 1 || remaining !== 0) {
        throw new CalendarError(
          "\u5220\u9664\u64CD\u4F5C\u5DF2\u6267\u884C\uFF0C\u4F46\u5199\u540E\u56DE\u8BFB\u65E0\u6CD5\u786E\u8BA4\u7ED3\u679C\uFF08\u5FC5\u987B\u786E\u8BA4 deleted=1 \u4E14 remaining=0\uFF09\u3002\u8BF7\u5230\u65E5\u5386.app \u6838\u5BF9\uFF1B\u672A\u6838\u5BF9\u524D\u4E0D\u8981\u81EA\u52A8\u91CD\u8BD5\u3002",
          "calendar"
        );
      }
      return {
        uid,
        calendar,
        title,
        startMs,
        endMs,
        deleted,
        remaining
      };
    },
    async createReminder(input) {
      const payload = await enqueueReminder("\u521B\u5EFA\u63D0\u9192\u4E8B\u9879", () => runRemindersJxa(
        bridge,
        "\u521B\u5EFA\u63D0\u9192\u4E8B\u9879",
        createReminderScript({ title: input.title, notes: input.notes, dueMs: input.dueMs })
      ));
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
    },
    async listReminders(input) {
      if (!Number.isFinite(input.fromMs) || !Number.isFinite(input.toMs) || input.toMs <= input.fromMs || !Number.isSafeInteger(input.maxRows) || input.maxRows < 1 || input.maxRows > 200) {
        throw new CalendarError("\u63D0\u9192\u4E8B\u9879\u67E5\u8BE2\u8303\u56F4\u4E0D\u5408\u6CD5", "args");
      }
      const payload = await enqueueReminder("\u8BFB\u53D6\u63D0\u9192\u4E8B\u9879", () => runRemindersJxa(bridge, "\u8BFB\u53D6\u63D0\u9192\u4E8B\u9879", listRemindersScript(input.fromMs, input.toMs, input.maxRows)));
      if (!Array.isArray(payload.reminders) || !Number.isSafeInteger(payload.total) || payload.total < payload.reminders.length || typeof payload.truncated !== "boolean") {
        throw new CalendarError("\u63D0\u9192\u4E8B\u9879\u8FD4\u56DE\u7684\u6570\u636E\u4E0D\u5B8C\u6574\uFF0C\u672A\u628A\u5B83\u5F53\u6210\u540C\u6B65\u6210\u529F\u3002", "calendar");
      }
      const reminders = payload.reminders.map(parseReminderRow);
      const total = payload.total;
      if (payload.truncated !== total > reminders.length) throw new CalendarError("\u63D0\u9192\u4E8B\u9879\u8FD4\u56DE\u7684\u6570\u91CF\u4E0D\u4E00\u81F4\uFF0C\u672A\u628A\u5B83\u5F53\u6210\u5B8C\u6574\u6570\u636E\u3002", "calendar");
      return { reminders, total, truncated: payload.truncated };
    },
    async updateReminder(input) {
      if (!input.id.trim() || input.title === void 0 && input.notes === void 0 && input.dueMs === void 0 && input.remindMs === void 0) {
        throw new CalendarError("\u8BF7\u9009\u62E9\u63D0\u9192\u5E76\u586B\u5199\u8981\u4FEE\u6539\u7684\u5185\u5BB9", "args");
      }
      if (input.title !== void 0 && (input.title.trim() === "" || input.title.length > 200)) throw new CalendarError("\u63D0\u9192\u5185\u5BB9\u5E94\u4E3A 1\u2013200 \u5B57", "args");
      if (input.dueMs !== void 0 && !Number.isFinite(input.dueMs)) throw new CalendarError("\u63D0\u9192\u65F6\u95F4\u4E0D\u5408\u6CD5", "args");
      if (input.remindMs !== void 0 && !Number.isFinite(input.remindMs)) throw new CalendarError("\u901A\u77E5\u65F6\u95F4\u4E0D\u5408\u6CD5", "args");
      const payload = await enqueueReminder("\u4FEE\u6539\u63D0\u9192\u4E8B\u9879", () => runRemindersJxa(bridge, "\u4FEE\u6539\u63D0\u9192\u4E8B\u9879", updateReminderScript(input)));
      const row = parseReminderRow(payload.reminder);
      if (row.id !== input.id || input.title !== void 0 && row.title !== input.title || input.dueMs !== void 0 && (row.dueMs === null || Math.abs(row.dueMs - input.dueMs) > 2e3) || input.remindMs !== void 0 && (row.remindMs === null || Math.abs(row.remindMs - input.remindMs) > 2e3)) {
        throw new CalendarError("\u63D0\u9192\u4E8B\u9879\u5DF2\u63D0\u4EA4\u4FEE\u6539\uFF0C\u4F46\u8BFB\u56DE\u7ED3\u679C\u4E0D\u4E00\u81F4\uFF1B\u8BF7\u5230\u7CFB\u7EDF\u63D0\u9192\u4E8B\u9879\u6838\u5BF9\u3002", "calendar");
      }
      return row;
    },
    async setReminderCompleted(input) {
      if (!input.id.trim()) throw new CalendarError("\u8BF7\u9009\u62E9\u8981\u5B8C\u6210\u7684\u63D0\u9192", "args");
      const payload = await enqueueReminder("\u4FEE\u6539\u63D0\u9192\u5B8C\u6210\u72B6\u6001", () => runRemindersJxa(bridge, "\u4FEE\u6539\u63D0\u9192\u5B8C\u6210\u72B6\u6001", setReminderCompletedScript(input.id, input.completed)));
      const row = parseReminderRow(payload.reminder);
      if (row.id !== input.id || row.completed !== input.completed) {
        throw new CalendarError("\u63D0\u9192\u5B8C\u6210\u72B6\u6001\u8BFB\u56DE\u4E0D\u4E00\u81F4\uFF1B\u8BF7\u5230\u7CFB\u7EDF\u63D0\u9192\u4E8B\u9879\u6838\u5BF9\u3002", "calendar");
      }
      return row;
    },
    async deleteReminder(input) {
      if (!input.confirm) throw new CalendarError("\u5220\u9664\u63D0\u9192\u4E8B\u9879\u9700\u8981\u672C\u4EBA\u660E\u786E\u786E\u8BA4", "args");
      if (!input.id.trim()) throw new CalendarError("\u8BF7\u9009\u62E9\u8981\u5220\u9664\u7684\u63D0\u9192", "args");
      const payload = await enqueueReminder("\u5220\u9664\u63D0\u9192\u4E8B\u9879", () => runRemindersJxa(bridge, "\u5220\u9664\u63D0\u9192\u4E8B\u9879", deleteReminderScript(input.id)));
      if (payload.deleted !== 1) throw new CalendarError("\u63D0\u9192\u4E8B\u9879\u5220\u9664\u7ED3\u679C\u672A\u786E\u8BA4\uFF0C\u8BF7\u5230\u7CFB\u7EDF\u63D0\u9192\u4E8B\u9879\u6838\u5BF9\u3002", "calendar");
      return { deleted: 1 };
    }
  };
}

// src/eventkit-jxa.ts
var FULL_ACCESS_STATUS = 3;
function js2(value) {
  return JSON.stringify(value);
}
function wrapper2(body, imports = ["EventKit", "Foundation"]) {
  return [
    "(function () {",
    "  try {",
    // Bracket access is equivalent in JXA and avoids the bundle gate mistaking script text
    // for an ESM dynamic import expression in dist/main.js.
    ...imports.map((name) => `    ObjC["import"](${js2(name)});`),
    ...body.split("\n").map((line) => `    ${line}`),
    "  } catch (e) {",
    '    return JSON.stringify({ ok: false, code: "eventkit-native", error: String(e && e.message ? e.message : e) });',
    "  }",
    "})()"
  ].join("\n");
}
function authorizationLines() {
  return [
    "const ENTITY_EVENT = 0;",
    `const FULL_ACCESS_STATUS = ${FULL_ACCESS_STATUS};`,
    "const status = Number($.EKEventStore.authorizationStatusForEntityType(ENTITY_EVENT));"
  ];
}
function permissionGuardLines() {
  return [
    ...authorizationLines(),
    "if (status !== FULL_ACCESS_STATUS) {",
    '  return JSON.stringify({ ok: false, code: "eventkit-permission", status: status, error: "EventKit full calendar access is required" });',
    "}"
  ];
}
function nativeNilLines() {
  return [
    "function nativeIsNil(value) {",
    "  if (value === null || value === undefined) return true;",
    '  if (typeof value.isNil === "function") return Boolean(value.isNil());',
    "  const unwrapped = ObjC.unwrap(value);",
    "  return unwrapped === null || unwrapped === undefined;",
    "}"
  ];
}
function occurrenceHelperLines() {
  return [
    ...nativeNilLines(),
    "function nativeString(value) {",
    "  if (nativeIsNil(value)) return null;",
    "  try {",
    "    const unwrapped = ObjC.unwrap(value);",
    "    return unwrapped === null || unwrapped === undefined ? null : String(unwrapped);",
    "  } catch (e) {",
    "    return String(value);",
    "  }",
    "}",
    "function nativeDateMs(value) {",
    "  if (nativeIsNil(value)) return null;",
    "  const seconds = Number(value.timeIntervalSince1970);",
    "  return Number.isFinite(seconds) ? Math.round(seconds * 1000) : null;",
    "}",
    "function nativeCount(value, optional) {",
    "  if (nativeIsNil(value)) {",
    "    if (optional === true) return 0;",
    '    throw new Error("EventKit returned a missing required collection");',
    "  }",
    "  const raw = value.count;",
    '  const count = typeof raw === "number" ? raw : typeof raw === "string" && /^(0|[1-9][0-9]*)$/.test(raw) ? Number(raw) : NaN;',
    '  if (!Number.isSafeInteger(count) || count < 0) throw new Error("EventKit returned an invalid collection count");',
    "  return count;",
    "}",
    "function utf8ByteLength(text) {",
    "  let bytes = 0;",
    "  for (let i = 0; i < text.length; i++) {",
    "    const code = text.charCodeAt(i);",
    "    if (code < 0x80) bytes += 1;",
    "    else if (code < 0x800) bytes += 2;",
    "    else if (code >= 0xD800 && code <= 0xDBFF && i + 1 < text.length && text.charCodeAt(i + 1) >= 0xDC00 && text.charCodeAt(i + 1) <= 0xDFFF) { bytes += 4; i += 1; }",
    "    else bytes += 3;",
    "  }",
    "  return bytes;",
    "}",
    "function boundedString(value, maxBytes) {",
    "  const source = nativeString(value);",
    '  const text = source === null ? "" : source;',
    "  if (utf8ByteLength(text) <= maxBytes) return { value: text, truncated: false };",
    "  let low = 0;",
    "  let high = text.length;",
    "  while (low < high) {",
    "    const mid = Math.ceil((low + high) / 2);",
    "    if (utf8ByteLength(text.slice(0, mid)) <= maxBytes) low = mid; else high = mid - 1;",
    "  }",
    "  let end = low;",
    "  if (end > 0 && end < text.length && text.charCodeAt(end - 1) >= 0xD800 && text.charCodeAt(end - 1) <= 0xDBFF) end -= 1;",
    "  return { value: text.slice(0, end), truncated: true };",
    "}",
    "function occurrenceRow(event, light) {",
    "  const calendar = event.calendar;",
    '  const calendarIdentifier = nativeString(calendar.calendarIdentifier) || "";',
    "  const eventIdentifier = nativeString(event.eventIdentifier);",
    "  const itemIdentifier = nativeString(event.calendarItemIdentifier);",
    // Native fixture verification: Calendar.app uid matches calendarItemIdentifier, not the provider's external identifier.
    // Keep the internal JSON key for the parser; legacy writes still recheck unique UID and non-recurrence before mutation.
    "  const rawExternalUid = itemIdentifier;",
    '  const externalUid = rawExternalUid !== null && rawExternalUid !== "" && rawExternalUid.length <= 200 && rawExternalUid.trim() === rawExternalUid ? rawExternalUid : null;',
    "  const occurrenceMs = nativeDateMs(event.occurrenceDate);",
    "  const startMs = nativeDateMs(event.startDate);",
    "  const endMs = nativeDateMs(event.endDate);",
    '  if (startMs === null || endMs === null) throw new Error("EventKit returned an occurrence without valid dates");',
    "  const isDetached = Boolean(event.isDetached);",
    // occurrenceDate is also populated for ordinary events; only the native recurrence flags classify a series.
    "  const isRecurring = Boolean(event.hasRecurrenceRules) || isDetached;",
    "  const calendarName = boundedString(calendar.title, 1024);",
    "  const title = boundedString(event.title, 4096);",
    "  const location = boundedString(event.location, 4096);",
    '  const notes = light ? { value: "", truncated: false } : boundedString(event.notes, 8192);',
    "  const zone = boundedString(nativeIsNil(event.timeZone) ? null : event.timeZone.name, 512);",
    "  const alarms = light ? null : event.alarms;",
    "  const alarmCount = nativeCount(alarms, true);",
    "  const alarmTimes = [];",
    "  const alarmLimit = light ? 0 : Math.min(alarmCount, 64);",
    "  for (let i = 0; i < alarmLimit; i++) {",
    "    const alarm = alarms.objectAtIndex(i);",
    "    const absoluteMs = nativeDateMs(alarm.absoluteDate);",
    "    const relativeSeconds = Number(alarm.relativeOffset);",
    "    const alarmMs = absoluteMs !== null ? absoluteMs : Number.isFinite(relativeSeconds) ? Math.round(startMs + relativeSeconds * 1000) : null;",
    "    if (alarmMs !== null) alarmTimes.push(alarmMs);",
    "  }",
    "  alarmTimes.sort(function (a, b) { return a - b; });",
    "  const alarmsTruncated = !light && (alarmCount > alarmLimit || alarmTimes.length < alarmCount);",
    "  return {",
    "    _baseKey: JSON.stringify([calendarIdentifier, eventIdentifier, itemIdentifier, occurrenceMs, startMs, endMs]),",
    "    calendar: calendarName.value,",
    "    externalUid: Boolean(calendar.allowsContentModifications) && !isRecurring ? externalUid : null,",
    "    title: title.value,",
    "    startMs: startMs,",
    "    endMs: endMs,",
    "    allDay: Boolean(event.isAllDay),",
    "    hasAlarm: Boolean(event.hasAlarms),",
    "    alarmTimes: alarmTimes,",
    "    location: location.value,",
    "    notes: notes.value,",
    "    isRecurring: isRecurring,",
    "    isDetached: isDetached,",
    "    timeZone: zone.value,",
    "    fieldsTruncated: calendarName.truncated || title.truncated || location.truncated || notes.truncated || zone.truncated || alarmsTruncated,",
    "  };",
    "}",
    "function finalizeOccurrenceKeys(rows) {",
    "  rows.sort(function (a, b) {",
    "    return a.startMs - b.startMs || a.endMs - b.endMs || (a.calendar < b.calendar ? -1 : a.calendar > b.calendar ? 1 : (a._baseKey < b._baseKey ? -1 : a._baseKey > b._baseKey ? 1 : (a.title < b.title ? -1 : a.title > b.title ? 1 : 0)));",
    "  });",
    "  const seen = Object.create(null);",
    "  for (const row of rows) {",
    "    const ordinal = seen[row._baseKey] || 0;",
    "    seen[row._baseKey] = ordinal + 1;",
    "    const parts = JSON.parse(row._baseKey);",
    "    parts.push(ordinal);",
    "    row.occurrenceKey = JSON.stringify(parts);",
    "    delete row._baseKey;",
    "  }",
    "}",
    "function selectedCalendars(store, wanted, calendarIdentifier) {",
    "  if (wanted === null && calendarIdentifier === null) return null;",
    "  const selected = $.NSMutableArray.array;",
    "  const calendars = store.calendarsForEntityType(ENTITY_EVENT);",
    "  const count = nativeCount(calendars);",
    "  for (let i = 0; i < count; i++) {",
    "    const calendar = calendars.objectAtIndex(i);",
    "    const nameMatches = wanted === null || nativeString(calendar.title) === wanted;",
    "    const idMatches = calendarIdentifier === null || nativeString(calendar.calendarIdentifier) === calendarIdentifier;",
    "    if (nameMatches && idMatches) selected.addObject(calendar);",
    "  }",
    "  return selected;",
    "}",
    "function queryOccurrences(store, fromMs, toMs, calendars, light) {",
    "  const from = $.NSDate.dateWithTimeIntervalSince1970(fromMs / 1000);",
    "  const to = $.NSDate.dateWithTimeIntervalSince1970(toMs / 1000);",
    // JXA bridges JavaScript null to NSNull, not the nullable NSArray pointer EventKit expects.
    "  const nativeCalendars = calendars === null ? $(undefined) : calendars;",
    "  const predicate = store.predicateForEventsWithStartDateEndDateCalendars(from, to, nativeCalendars);",
    "  const nativeEvents = store.eventsMatchingPredicate(predicate);",
    "  const count = nativeCount(nativeEvents);",
    "  const rows = [];",
    "  for (let i = 0; i < count; i++) rows.push(occurrenceRow(nativeEvents.objectAtIndex(i), light));",
    "  finalizeOccurrenceKeys(rows);",
    "  return rows;",
    "}"
  ];
}
function eventKitAuthorizationScript() {
  const body = [
    ...authorizationLines(),
    "return JSON.stringify({ ok: true, status: status, canRead: status === FULL_ACCESS_STATUS });"
  ].join("\n");
  return wrapper2(body);
}
function eventKitOccurrencesScript(input) {
  const body = [
    `const WANTED = ${input.calendar === null ? "null" : js2(input.calendar)};`,
    `const FROM_MS = ${Math.trunc(input.fromMs)};`,
    `const TO_MS = ${Math.trunc(input.toMs)};`,
    `const MAX_ROWS = ${Math.trunc(input.maxRows)};`,
    `const LIGHT = ${input.light === true ? "true" : "false"};`,
    `const MAX_OUTPUT_BYTES = ${Math.trunc(input.maxOutputBytes)};`,
    ...permissionGuardLines(),
    ...occurrenceHelperLines(),
    "const store = $.EKEventStore.alloc.init;",
    "const calendars = selectedCalendars(store, WANTED, null);",
    "if (WANTED !== null && nativeCount(calendars) === 0) {",
    '  return JSON.stringify({ ok: false, code: "no-calendar", error: "\u672A\u627E\u5230\u540D\u4E3A\u300A" + WANTED + "\u300B\u7684\u65E5\u5386" });',
    "}",
    "const allRows = queryOccurrences(store, FROM_MS, TO_MS, calendars, LIGHT);",
    "const total = allRows.length;",
    "const occurrences = [];",
    "let contentTruncated = false;",
    "const rowLimit = Math.min(total, Math.max(0, MAX_ROWS));",
    "for (let i = 0; i < rowLimit; i++) {",
    "  const row = allRows[i];",
    "  const candidateRows = occurrences.concat([row]);",
    "  const candidate = JSON.stringify({ ok: true, status: status, total: total, truncated: candidateRows.length < total, contentTruncated: contentTruncated || row.fieldsTruncated, alarmsRead: !LIGHT, occurrences: candidateRows });",
    "  if (utf8ByteLength(candidate) > MAX_OUTPUT_BYTES) break;",
    "  occurrences.push(row);",
    "  contentTruncated = contentTruncated || row.fieldsTruncated;",
    "}",
    "const truncated = occurrences.length < total;",
    "let output = JSON.stringify({ ok: true, status: status, total: total, truncated: truncated, contentTruncated: contentTruncated, alarmsRead: !LIGHT, occurrences: occurrences });",
    "while (utf8ByteLength(output) > MAX_OUTPUT_BYTES && occurrences.length > 0) {",
    "  occurrences.pop();",
    "  contentTruncated = occurrences.some(function (row) { return row.fieldsTruncated; });",
    "  output = JSON.stringify({ ok: true, status: status, total: total, truncated: true, contentTruncated: contentTruncated, alarmsRead: !LIGHT, occurrences: occurrences });",
    "}",
    "return output;"
  ].join("\n");
  return wrapper2(body);
}
function eventKitOccurrenceDetailScript(input) {
  const body = [
    `const OCCURRENCE_KEY = ${js2(input.occurrenceKey)};`,
    `const FROM_MS = ${Math.trunc(input.fromMs)};`,
    `const TO_MS = ${Math.trunc(input.toMs)};`,
    `const MAX_OUTPUT_BYTES = ${Math.trunc(input.maxOutputBytes)};`,
    ...permissionGuardLines(),
    ...occurrenceHelperLines(),
    "const keyParts = JSON.parse(OCCURRENCE_KEY);",
    "const calendarIdentifier = keyParts[0];",
    "const store = $.EKEventStore.alloc.init;",
    "const calendars = selectedCalendars(store, null, calendarIdentifier);",
    "if (nativeCount(calendars) === 0) {",
    '  return JSON.stringify({ ok: false, code: "no-occurrence", error: "\u6240\u9009\u65E5\u7A0B\u5B9E\u4F8B\u5DF2\u4E0D\u5B58\u5728\u6216\u6240\u5C5E\u65E5\u5386\u5DF2\u79FB\u9664" });',
    "}",
    "const rows = queryOccurrences(store, FROM_MS, TO_MS, calendars, false);",
    "let target = null;",
    "for (const row of rows) {",
    "  if (row.occurrenceKey === OCCURRENCE_KEY) { target = row; break; }",
    "}",
    "if (target === null) {",
    '  return JSON.stringify({ ok: false, code: "no-occurrence", error: "\u672A\u627E\u5230\u6240\u9009\u65E5\u7A0B\u5B9E\u4F8B\uFF08\u53EF\u80FD\u5DF2\u88AB\u5220\u9664\u3001\u6539\u671F\u6216\u540C\u6B65\u66F4\u65B0\uFF09" });',
    "}",
    "const output = JSON.stringify({ ok: true, status: status, contentTruncated: target.fieldsTruncated, occurrence: target });",
    "if (utf8ByteLength(output) > MAX_OUTPUT_BYTES) {",
    '  return JSON.stringify({ ok: false, code: "output-too-large", error: "\u6240\u9009\u65E5\u7A0B\u8BE6\u60C5\u8D85\u8FC7\u5B89\u5168\u8BFB\u53D6\u4E0A\u9650\uFF0C\u672A\u8FD4\u56DE\u4E0D\u5B8C\u6574\u8BE6\u60C5" });',
    "}",
    "return output;"
  ].join("\n");
  return wrapper2(body);
}
function eventKitCalendarsScript(input) {
  const body = [
    `const MAX_OUTPUT_BYTES = ${Math.trunc(input.maxOutputBytes)};`,
    ...permissionGuardLines(),
    ...occurrenceHelperLines().slice(0, occurrenceHelperLines().findIndex((line) => line === "function occurrenceRow(event, light) {")),
    "function colorHex(calendar) {",
    "  try {",
    "    const color = calendar.color.colorUsingColorSpace($.NSColorSpace.sRGBColorSpace);",
    '    if (color === null || color === undefined) return "";',
    "    const values = [Number(color.redComponent), Number(color.greenComponent), Number(color.blueComponent)];",
    '    if (values.some(function (value) { return !Number.isFinite(value) || value < 0 || value > 1; })) return "";',
    '    return "#" + values.map(function (value) { return Math.round(value * 255).toString(16).padStart(2, "0"); }).join("").toUpperCase();',
    '  } catch (e) { return ""; }',
    "}",
    "const store = $.EKEventStore.alloc.init;",
    "const nativeCalendars = store.calendarsForEntityType(ENTITY_EVENT);",
    "const total = nativeCount(nativeCalendars);",
    "const allRows = [];",
    "let contentTruncated = false;",
    "for (let i = 0; i < total; i++) {",
    "  const calendar = nativeCalendars.objectAtIndex(i);",
    "  const name = boundedString(calendar.title, 1024);",
    "  contentTruncated = contentTruncated || name.truncated;",
    "  allRows.push({ name: name.value, writable: Boolean(calendar.allowsContentModifications), color: colorHex(calendar) });",
    "}",
    "allRows.sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; });",
    "const calendars = [];",
    "for (const row of allRows) {",
    "  const candidate = JSON.stringify({ ok: true, status: status, total: total, truncated: calendars.length + 1 < total, contentTruncated: contentTruncated, calendars: calendars.concat([row]) });",
    "  if (utf8ByteLength(candidate) > MAX_OUTPUT_BYTES) break;",
    "  calendars.push(row);",
    "}",
    "return JSON.stringify({ ok: true, status: status, total: total, truncated: calendars.length < total, contentTruncated: contentTruncated, calendars: calendars });"
  ].join("\n");
  return wrapper2(body, ["EventKit", "Foundation", "AppKit"]);
}
function requestEventKitFullAccessScript(input) {
  const body = [
    `const WAIT_MS = ${Math.trunc(input.waitMs)};`,
    ...authorizationLines(),
    ...nativeNilLines(),
    "if (status === FULL_ACCESS_STATUS) return JSON.stringify({ ok: true, status: status, granted: true });",
    "if (status === 1 || status === 2) {",
    '  return JSON.stringify({ ok: false, code: "eventkit-permission", status: status, error: "Full calendar access is unavailable" });',
    "}",
    "const store = $.EKEventStore.alloc.init;",
    "let done = false;",
    "let granted = false;",
    'let callbackError = "";',
    'const completion = ObjC.block("void", ["bool", "id"], function (didGrant, error) {',
    "  granted = Boolean(didGrant);",
    "  if (!nativeIsNil(error)) {",
    "    try { callbackError = String(ObjC.unwrap(error.localizedDescription)); } catch (e) { callbackError = String(error); }",
    "  }",
    "  done = true;",
    "});",
    'const fullSelector = $.NSSelectorFromString("requestFullAccessToEventsWithCompletion:");',
    "if (Boolean(store.respondsToSelector(fullSelector))) store.requestFullAccessToEventsWithCompletion(completion);",
    "else store.requestAccessToEntityTypeCompletion(ENTITY_EVENT, completion);",
    "const deadline = Date.now() + WAIT_MS;",
    "while (!done && Date.now() < deadline) {",
    "  $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.05));",
    "}",
    "const finalStatus = Number($.EKEventStore.authorizationStatusForEntityType(ENTITY_EVENT));",
    "if (finalStatus === FULL_ACCESS_STATUS) return JSON.stringify({ ok: true, status: finalStatus, granted: true });",
    "if (finalStatus === 1 || finalStatus === 2) {",
    '  return JSON.stringify({ ok: false, code: "eventkit-permission", status: finalStatus, error: callbackError || "Full calendar access was not granted" });',
    "}",
    "if (!done) {",
    '  return JSON.stringify({ ok: false, code: "permission-pending", status: finalStatus, error: "\u6388\u6743\u7ED3\u679C\u5C1A\u672A\u8FD4\u56DE\uFF1B\u8BF7\u67E5\u770B\u7CFB\u7EDF\u5F39\u7A97\u6216\u7A0D\u540E\u91CD\u65B0\u68C0\u67E5" });',
    "}",
    "if (finalStatus === 4) {",
    '  return JSON.stringify({ ok: false, code: "eventkit-permission", status: finalStatus, error: callbackError || "Full calendar access was not granted" });',
    "}",
    'if (callbackError !== "") {',
    '  return JSON.stringify({ ok: false, code: "permission-request-error", status: finalStatus, error: callbackError });',
    "}",
    'return JSON.stringify({ ok: false, code: "permission-pending", status: finalStatus, granted: granted, error: "\u6388\u6743\u7ED3\u679C\u5C1A\u672A\u786E\u8BA4\uFF1B\u8BF7\u7A0D\u540E\u91CD\u65B0\u68C0\u67E5" });'
  ].join("\n");
  return wrapper2(body);
}

// src/eventkit.ts
var EXEC_TIMEOUT_MS = 3e4;
var OPEN_TIMEOUT_MS2 = 15e3;
var DEFAULT_QUEUE_MAX_WAIT_MS2 = 2e4;
var DEFAULT_SCRIPT_OUTPUT_BUDGET_BYTES = 6e4;
var DEFAULT_PERMISSION_WAIT_MS = 12e3;
var EVENTKIT_STDOUT_LIMIT_BYTES = 65536;
var EventKitPermissionError = class extends CalendarError {
  status;
  constructor(message, status) {
    super(message, "calendar");
    this.name = "EventKitPermissionError";
    this.status = status;
  }
};
function isRecord3(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function firstLine2(text, max = 300) {
  const line = text.split("\n").find((entry) => entry.trim()) ?? "";
  return line.trim().slice(0, max);
}
function utf8ByteLength(text) {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 128) bytes += 1;
    else if (code < 2048) bytes += 2;
    else if (code >= 55296 && code <= 56319 && i + 1 < text.length && text.charCodeAt(i + 1) >= 56320 && text.charCodeAt(i + 1) <= 57343) {
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}
function isTimeout(detail) {
  return /timed?[\s-]?out|timeout|超时/i.test(detail);
}
function permissionMessage(status) {
  if (status === 0) {
    return "\u5C1A\u672A\u6388\u4E88\u5B8C\u6574\u65E5\u5386\u8BBF\u95EE\u6743\u9650\u3002\u8BF7\u5728\u53F3\u4FA7\u300C\u65E5\u5386\u300D\u9762\u677F\u70B9\u51FB\u201C\u6388\u6743\u8BFB\u53D6\u65E5\u5386\u201D\uFF0C\u5E76\u7531\u4F60\u672C\u4EBA\u5728\u7CFB\u7EDF\u5F39\u7A97\u4E2D\u9009\u62E9\uFF1B\u672C\u6B21\u672A\u8BFB\u53D6\u4EFB\u4F55\u65E5\u7A0B\u3002";
  }
  if (status === 1) {
    return "\u7CFB\u7EDF\u9650\u5236\u4E86\u5B8C\u6574\u65E5\u5386\u8BBF\u95EE\uFF08\u53EF\u80FD\u7531\u8BBE\u5907\u7BA1\u7406\u6216\u5BB6\u957F\u63A7\u5236\u8BBE\u7F6E\uFF09\uFF0CLawyerCopilot \u65E0\u6CD5\u81EA\u884C\u66F4\u6539\uFF1B\u672C\u6B21\u672A\u8BFB\u53D6\u4EFB\u4F55\u65E5\u7A0B\u3002";
  }
  if (status === 2) {
    return "\u5B8C\u6574\u65E5\u5386\u8BBF\u95EE\u5DF2\u88AB\u62D2\u7EDD\u3002\u8BF7\u70B9\u51FB\u754C\u9762\u7684\u201C\u6253\u5F00\u7CFB\u7EDF\u8BBE\u7F6E\u201D\uFF0C\u5728 \u9690\u79C1\u4E0E\u5B89\u5168\u6027 \u2192 \u65E5\u5386 \u4E2D\u5141\u8BB8 LawyerCopilot \u5B8C\u6574\u8BBF\u95EE\uFF1B\u672C\u6B21\u672A\u8BFB\u53D6\u4EFB\u4F55\u65E5\u7A0B\u3002";
  }
  if (status === 4) {
    return "\u5F53\u524D\u53EA\u6709\u201C\u4EC5\u6DFB\u52A0\u65E5\u7A0B\u201D\u6743\u9650\uFF0C\u4E0D\u80FD\u8BFB\u53D6\u65E5\u5386\u3002\u8BF7\u70B9\u51FB\u754C\u9762\u7684\u201C\u6388\u6743\u5B8C\u6574\u8BFB\u53D6\u201D\uFF0C\u7531\u4F60\u672C\u4EBA\u6539\u4E3A\u5B8C\u6574\u8BBF\u95EE\uFF1B\u672C\u6B21\u672A\u8BFB\u53D6\u4EFB\u4F55\u65E5\u7A0B\u3002";
  }
  return `\u7CFB\u7EDF\u8FD4\u56DE\u4E86\u65E0\u6CD5\u786E\u8BA4\u7684\u65E5\u5386\u6743\u9650\u72B6\u6001${status === null ? "" : `\uFF08${status}\uFF09`}\uFF1B\u672A\u6309\u201C\u62D2\u7EDD\u201D\u5904\u7406\uFF0C\u4E5F\u672A\u8BFB\u53D6\u4EFB\u4F55\u65E5\u7A0B\u3002\u8BF7\u5237\u65B0\u540E\u91CD\u8BD5\u6216\u68C0\u67E5\u7CFB\u7EDF\u8BBE\u7F6E\u3002`;
}
function permissionError(status) {
  const parsed = typeof status === "number" && Number.isSafeInteger(status) ? status : null;
  return new EventKitPermissionError(permissionMessage(parsed), parsed);
}
function requireFullAccess(payload) {
  if (payload.status !== 3) throw permissionError(payload.status);
}
async function execRun2(bridge, op, bin, args, timeoutMs) {
  let raw;
  try {
    raw = await bridge.invoke("plugin_exec_run", { bin, args, timeoutMs });
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    if (isTimeout(detail)) {
      throw new CalendarError(
        `\u7CFB\u7EDF\u65E5\u5386\u8BFB\u53D6\u8D85\u65F6\uFF08${op}\uFF0C\u5DF2\u7B49 30 \u79D2\uFF09\uFF1A\u8BFB\u53D6\u6CA1\u6709\u5B8C\u6210\uFF0C\u4E0D\u4EE3\u8868\u6CA1\u6709\u5B89\u6392\uFF1B\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002`,
        "calendar"
      );
    }
    throw new CalendarError(`\u65E0\u6CD5\u6267\u884C\u7CFB\u7EDF\u65E5\u5386\u8BFB\u53D6\uFF08${op}\uFF09\uFF1A${firstLine2(detail) || "\u7CFB\u7EDF\u547D\u4EE4\u4E0D\u53EF\u7528"}`, "bridge");
  }
  if (!isRecord3(raw)) throw new CalendarError(`\u7CFB\u7EDF\u65E5\u5386\u8BFB\u53D6\u8FD4\u56DE\u683C\u5F0F\u4E0D\u6B63\u786E\uFF08${op}\uFF09`, "bridge");
  return {
    code: typeof raw.code === "number" ? raw.code : -1,
    stdout: typeof raw.stdout === "string" ? raw.stdout : "",
    stderr: typeof raw.stderr === "string" ? raw.stderr : ""
  };
}
async function runEventKitJxa(bridge, op, script) {
  const result = await execRun2(bridge, op, "osascript", ["-l", "JavaScript", "-e", script], EXEC_TIMEOUT_MS);
  if (utf8ByteLength(result.stdout) > EVENTKIT_STDOUT_LIMIT_BYTES) {
    throw new CalendarError(
      `\u7CFB\u7EDF\u65E5\u5386\u8FD4\u56DE\u8D85\u8FC7\u5BBF\u4E3B 64 KiB \u5B89\u5168\u4E0A\u9650\uFF08${op}\uFF09\uFF0C\u5DF2\u62D2\u7EDD\u628A\u53EF\u80FD\u622A\u65AD\u7684\u6570\u636E\u5F53\u6210\u5B8C\u6574\u7ED3\u679C\u3002\u8BF7\u7F29\u77ED\u65F6\u95F4\u8303\u56F4\u6216\u6307\u5B9A\u65E5\u5386\u3002`,
      "calendar"
    );
  }
  const output = result.stdout.trim();
  if (result.code !== 0 || output === "") {
    const detail = firstLine2(result.stderr || result.stdout);
    if (isTimeout(detail)) {
      throw new CalendarError(
        `\u7CFB\u7EDF\u65E5\u5386\u8BFB\u53D6\u8D85\u65F6\uFF08${op}\uFF0C\u5DF2\u7B49 30 \u79D2\uFF09\uFF1A\u8BFB\u53D6\u6CA1\u6709\u5B8C\u6210\uFF0C\u4E0D\u4EE3\u8868\u6CA1\u6709\u5B89\u6392\uFF1B\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002`,
        "calendar"
      );
    }
    throw new CalendarError(`\u7CFB\u7EDF\u65E5\u5386\u8BFB\u53D6\u5931\u8D25\uFF08${op}\uFF0C\u9000\u51FA\u7801 ${result.code}\uFF09\uFF1A${detail || "\u65E0\u8F93\u51FA"}`, "calendar");
  }
  let payload;
  try {
    payload = JSON.parse(output);
  } catch {
    throw new CalendarError(`\u7CFB\u7EDF\u65E5\u5386\u8FD4\u56DE\u4E86\u65E0\u6CD5\u89E3\u6790\u7684\u7ED3\u679C\uFF08${op}\uFF09\uFF1B\u53EF\u80FD\u8D85\u8FC7\u8F93\u51FA\u4E0A\u9650\uFF0C\u672A\u628A\u90E8\u5206\u7ED3\u679C\u5F53\u6210\u5B8C\u6574\u6570\u636E\u3002`, "calendar");
  }
  if (!isRecord3(payload)) throw new CalendarError(`\u7CFB\u7EDF\u65E5\u5386\u8FD4\u56DE\u683C\u5F0F\u4E0D\u6B63\u786E\uFF08${op}\uFF09`, "calendar");
  if (payload.ok !== true) {
    const code = typeof payload.code === "string" ? payload.code : "";
    const rawMessage = typeof payload.error === "string" ? firstLine2(payload.error) : "";
    if (code === "eventkit-permission") throw permissionError(payload.status);
    if (code === "permission-pending") {
      throw new CalendarError("\u7CFB\u7EDF\u6388\u6743\u7ED3\u679C\u5C1A\u672A\u786E\u8BA4\uFF1A\u8BF7\u67E5\u770B\u7CFB\u7EDF\u5F39\u7A97\uFF1B\u82E5\u4F60\u5C1A\u672A\u9009\u62E9\uFF0C\u53EF\u7A0D\u540E\u518D\u6B21\u70B9\u51FB\u68C0\u67E5\u3002\u5F53\u524D\u4E0D\u4F5C\u6743\u9650\u7ED3\u8BBA\u3002", "calendar");
    }
    if (code === "permission-request-error") {
      throw new CalendarError(`\u7CFB\u7EDF\u672A\u80FD\u5B8C\u6210\u65E5\u5386\u6388\u6743\u8BF7\u6C42\uFF0C\u7ED3\u679C\u672A\u786E\u8BA4\uFF1A${rawMessage || "\u8BF7\u7A0D\u540E\u91CD\u8BD5\u6216\u6253\u5F00\u7CFB\u7EDF\u8BBE\u7F6E\u68C0\u67E5\u3002"}`, "calendar");
    }
    if (code === "no-calendar" || code === "no-occurrence" || code === "output-too-large") {
      throw new CalendarError(rawMessage || "\u672A\u627E\u5230\u6240\u9700\u65E5\u5386\u6570\u636E", "calendar");
    }
    throw new CalendarError(`\u7CFB\u7EDF\u65E5\u5386\u8BFB\u53D6\u5931\u8D25\uFF08${op}\uFF09\uFF1A${rawMessage || "\u672A\u77E5\u9519\u8BEF"}`, "calendar");
  }
  return payload;
}
function decodeOccurrenceKey(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 8192) {
    throw new CalendarError("\u65E5\u7A0B\u5B9E\u4F8B\u952E\u4E0D\u5408\u6CD5\uFF0C\u8BF7\u5237\u65B0\u65E5\u5386\u540E\u91CD\u65B0\u9009\u62E9\u3002", "args");
  }
  let parts;
  try {
    parts = JSON.parse(value);
  } catch {
    throw new CalendarError("\u65E5\u7A0B\u5B9E\u4F8B\u952E\u4E0D\u5408\u6CD5\uFF0C\u8BF7\u5237\u65B0\u65E5\u5386\u540E\u91CD\u65B0\u9009\u62E9\u3002", "args");
  }
  if (!Array.isArray(parts) || parts.length !== 7 || typeof parts[0] !== "string" || parts[0].length === 0 || !(parts[1] === null || typeof parts[1] === "string") || !(parts[2] === null || typeof parts[2] === "string") || !(parts[3] === null || typeof parts[3] === "number" && Number.isFinite(parts[3])) || typeof parts[4] !== "number" || !Number.isFinite(parts[4]) || typeof parts[5] !== "number" || !Number.isFinite(parts[5]) || parts[5] < parts[4] || typeof parts[6] !== "number" || !Number.isSafeInteger(parts[6]) || parts[6] < 0) {
    throw new CalendarError("\u65E5\u7A0B\u5B9E\u4F8B\u952E\u4E0D\u5408\u6CD5\uFF0C\u8BF7\u5237\u65B0\u65E5\u5386\u540E\u91CD\u65B0\u9009\u62E9\u3002", "args");
  }
  return { calendarIdentifier: parts[0], startMs: parts[4], endMs: parts[5] };
}
function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function parseOccurrence(value) {
  if (!isRecord3(value)) throw new CalendarError("\u7CFB\u7EDF\u65E5\u5386\u8FD4\u56DE\u7684\u53D1\u751F\u5B9E\u4F8B\u683C\u5F0F\u4E0D\u6B63\u786E\uFF08\u4E0D\u662F\u5BF9\u8C61\uFF09", "calendar");
  const occurrenceKey = typeof value.occurrenceKey === "string" ? value.occurrenceKey : "";
  const decoded = decodeOccurrenceKey(occurrenceKey);
  const startMs = finiteNumber(value.startMs);
  const endMs = finiteNumber(value.endMs);
  if (startMs === null || endMs === null || endMs < startMs || decoded.startMs !== startMs || decoded.endMs !== endMs) {
    throw new CalendarError("\u7CFB\u7EDF\u65E5\u5386\u8FD4\u56DE\u7684\u53D1\u751F\u5B9E\u4F8B\u65F6\u95F4\u4E0E\u5B9E\u4F8B\u952E\u4E0D\u4E00\u81F4", "calendar");
  }
  if (typeof value.calendar !== "string" || typeof value.title !== "string" || typeof value.location !== "string" || typeof value.notes !== "string" || typeof value.timeZone !== "string" || typeof value.allDay !== "boolean" || typeof value.hasAlarm !== "boolean" || typeof value.isRecurring !== "boolean" || typeof value.isDetached !== "boolean" || typeof value.fieldsTruncated !== "boolean" || !Array.isArray(value.alarmTimes) || !value.alarmTimes.every((entry) => typeof entry === "number" && Number.isFinite(entry)) || !(value.externalUid === null || typeof value.externalUid === "string")) {
    throw new CalendarError("\u7CFB\u7EDF\u65E5\u5386\u8FD4\u56DE\u7684\u53D1\u751F\u5B9E\u4F8B\u5B57\u6BB5\u683C\u5F0F\u4E0D\u6B63\u786E", "calendar");
  }
  const externalUid = value.externalUid !== null && value.externalUid !== "" && value.externalUid.length <= 200 && value.externalUid.trim() === value.externalUid ? value.externalUid : null;
  const editableUid = value.isRecurring || value.isDetached ? null : externalUid;
  return {
    occurrenceKey,
    calendar: value.calendar,
    editableUid,
    title: value.title,
    startMs,
    endMs,
    allDay: value.allDay,
    hasAlarm: value.hasAlarm,
    alarmTimes: [...value.alarmTimes],
    location: value.location,
    notes: value.notes,
    isRecurring: value.isRecurring,
    isDetached: value.isDetached,
    timeZone: value.timeZone,
    fieldsTruncated: value.fieldsTruncated
  };
}
function validateListInput(input) {
  if (!Number.isFinite(input.fromMs) || !Number.isFinite(input.toMs) || input.toMs <= input.fromMs) {
    throw new CalendarError("\u65E5\u5386\u67E5\u8BE2\u65F6\u95F4\u7A97\u4E0D\u5408\u6CD5", "args");
  }
  if (!Number.isSafeInteger(input.maxRows) || input.maxRows < 1 || input.maxRows > 1e4) {
    throw new CalendarError("\u65E5\u5386\u67E5\u8BE2\u6761\u6570\u4E0A\u9650\u4E0D\u5408\u6CD5", "args");
  }
  if (!(input.calendar === null || typeof input.calendar === "string" && input.calendar.trim() !== "")) {
    throw new CalendarError("calendar \u5FC5\u987B\u662F\u975E\u7A7A\u65E5\u5386\u540D\u79F0\u6216 null", "args");
  }
}
function createEventKitCalendar(bridge, options = {}) {
  const queueMaxWaitMs = options.queueMaxWaitMs ?? DEFAULT_QUEUE_MAX_WAIT_MS2;
  const outputBudget = options.scriptOutputBudgetBytes ?? DEFAULT_SCRIPT_OUTPUT_BUDGET_BYTES;
  const permissionWaitMs = options.permissionWaitMs ?? DEFAULT_PERMISSION_WAIT_MS;
  const ambiguousEditableUids = /* @__PURE__ */ new Set();
  let chain = Promise.resolve();
  function enqueue(op, task) {
    const queuedAt = Date.now();
    const run = chain.then(async () => {
      const waitedMs = Date.now() - queuedAt;
      if (waitedMs > queueMaxWaitMs) {
        throw new CalendarError(
          `\u7CFB\u7EDF\u65E5\u5386\u64CD\u4F5C\uFF08${op}\uFF09\u6392\u961F\u7B49\u5F85 ${(waitedMs / 1e3).toFixed(1)} \u79D2\uFF0C\u8D85\u8FC7 ${(queueMaxWaitMs / 1e3).toFixed(1)} \u79D2\u4E0A\u9650\uFF0C\u5DF2\u5728\u6267\u884C\u524D\u53D6\u6D88\u3002`,
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
    async authorizationStatus() {
      const payload = await enqueue(
        "\u68C0\u67E5\u65E5\u5386\u6743\u9650",
        () => runEventKitJxa(bridge, "\u68C0\u67E5\u65E5\u5386\u6743\u9650", eventKitAuthorizationScript())
      );
      const status = payload.status;
      if (typeof status !== "number" || !Number.isSafeInteger(status) || typeof payload.canRead !== "boolean" || payload.canRead !== (status === 3)) {
        throw new CalendarError("\u7CFB\u7EDF\u8FD4\u56DE\u7684\u65E5\u5386\u6743\u9650\u72B6\u6001\u683C\u5F0F\u4E0D\u6B63\u786E", "calendar");
      }
      return { status, canRead: payload.canRead };
    },
    async listCalendars(readOptions = {}) {
      const checkCurrent = () => {
        if (readOptions.shouldContinue !== void 0 && !readOptions.shouldContinue()) {
          throw new CalendarError("\u65E5\u5386\u5206\u7C7B\u8BFB\u53D6\u5DF2\u53D6\u6D88", "calendar");
        }
      };
      checkCurrent();
      const payload = await enqueue("\u8BFB\u53D6\u65E5\u5386\u5206\u7C7B", () => {
        checkCurrent();
        return runEventKitJxa(bridge, "\u8BFB\u53D6\u65E5\u5386\u5206\u7C7B", eventKitCalendarsScript({ maxOutputBytes: outputBudget }));
      });
      requireFullAccess(payload);
      if (!Array.isArray(payload.calendars)) throw new CalendarError("\u7CFB\u7EDF\u8FD4\u56DE\u7684\u65E5\u5386\u5206\u7C7B\u683C\u5F0F\u4E0D\u6B63\u786E", "calendar");
      const calendars = [];
      for (const value of payload.calendars) {
        if (!isRecord3(value) || typeof value.name !== "string" || typeof value.writable !== "boolean" || typeof value.color !== "string") {
          throw new CalendarError("\u7CFB\u7EDF\u8FD4\u56DE\u7684\u65E5\u5386\u5206\u7C7B\u5B57\u6BB5\u683C\u5F0F\u4E0D\u6B63\u786E", "calendar");
        }
        calendars.push({ name: value.name, writable: value.writable, color: value.color });
      }
      const total = payload.total;
      const truncated = payload.truncated;
      const contentTruncated = payload.contentTruncated;
      if (typeof total !== "number" || !Number.isSafeInteger(total) || total < calendars.length || typeof truncated !== "boolean" || truncated !== total > calendars.length || typeof contentTruncated !== "boolean") {
        throw new CalendarError("\u7CFB\u7EDF\u8FD4\u56DE\u7684\u65E5\u5386\u5206\u7C7B\u603B\u6570\u6216\u622A\u65AD\u6807\u5FD7\u4E0D\u6B63\u786E", "calendar");
      }
      return { calendars, total, truncated, contentTruncated };
    },
    async listOccurrences(input, readOptions = {}) {
      validateListInput(input);
      const alarmsRead = input.light !== true;
      if (readOptions.shouldContinue !== void 0 && !readOptions.shouldContinue()) {
        return { canceled: true, occurrences: [], total: 0, truncated: false, contentTruncated: false, alarmsRead };
      }
      const CANCELED = Symbol("canceled");
      const outcome = await enqueue("\u8BFB\u53D6\u65E5\u7A0B\u5B9E\u4F8B", async () => {
        if (readOptions.shouldContinue !== void 0 && !readOptions.shouldContinue()) return CANCELED;
        return runEventKitJxa(
          bridge,
          "\u8BFB\u53D6\u65E5\u7A0B\u5B9E\u4F8B",
          eventKitOccurrencesScript({ ...input, maxOutputBytes: outputBudget })
        );
      });
      if (outcome === CANCELED) {
        return { canceled: true, occurrences: [], total: 0, truncated: false, contentTruncated: false, alarmsRead };
      }
      requireFullAccess(outcome);
      if (!Array.isArray(outcome.occurrences)) throw new CalendarError("\u7CFB\u7EDF\u65E5\u5386\u8FD4\u56DE\u7684\u53D1\u751F\u5B9E\u4F8B\u5217\u8868\u683C\u5F0F\u4E0D\u6B63\u786E", "calendar");
      let occurrences = outcome.occurrences.map(parseOccurrence);
      if (new Set(occurrences.map((entry) => entry.occurrenceKey)).size !== occurrences.length) {
        throw new CalendarError("\u7CFB\u7EDF\u65E5\u5386\u8FD4\u56DE\u4E86\u91CD\u590D\u7684\u53D1\u751F\u5B9E\u4F8B\u952E\uFF0C\u65E0\u6CD5\u5B89\u5168\u533A\u5206\u6BCF\u6B21\u53D1\u751F", "calendar");
      }
      const editableUidCounts = /* @__PURE__ */ new Map();
      for (const occurrence of occurrences) {
        if (occurrence.editableUid !== null) {
          editableUidCounts.set(occurrence.editableUid, (editableUidCounts.get(occurrence.editableUid) ?? 0) + 1);
        }
      }
      for (const [uid, count] of editableUidCounts) {
        if (count > 1) ambiguousEditableUids.add(uid);
      }
      occurrences = occurrences.map(
        (occurrence) => occurrence.editableUid !== null && ambiguousEditableUids.has(occurrence.editableUid) ? { ...occurrence, editableUid: null } : occurrence
      );
      const total = outcome.total;
      const truncated = outcome.truncated;
      const contentTruncated = outcome.contentTruncated;
      if (outcome.alarmsRead !== alarmsRead) {
        throw new CalendarError("\u7CFB\u7EDF\u65E5\u5386\u8FD4\u56DE\u7684\u63D0\u9192\u8BFB\u53D6\u72B6\u6001\u4E0E\u8BF7\u6C42\u4E0D\u4E00\u81F4", "calendar");
      }
      if (typeof total !== "number" || !Number.isSafeInteger(total) || total < occurrences.length) {
        throw new CalendarError("\u7CFB\u7EDF\u65E5\u5386\u8FD4\u56DE\u7684\u53D1\u751F\u5B9E\u4F8B\u603B\u6570\u4E0D\u6B63\u786E", "calendar");
      }
      if (typeof truncated !== "boolean" || truncated !== total > occurrences.length) {
        throw new CalendarError("\u7CFB\u7EDF\u65E5\u5386\u8FD4\u56DE\u7684\u53D1\u751F\u5B9E\u4F8B\u622A\u65AD\u6807\u5FD7\u4E0E\u603B\u6570\u77DB\u76FE", "calendar");
      }
      if (typeof contentTruncated !== "boolean" || contentTruncated !== occurrences.some((entry) => entry.fieldsTruncated)) {
        throw new CalendarError("\u7CFB\u7EDF\u65E5\u5386\u8FD4\u56DE\u7684\u8BE6\u60C5\u622A\u65AD\u6807\u5FD7\u4E0E\u5B9E\u4F8B\u5B57\u6BB5\u77DB\u76FE", "calendar");
      }
      return { canceled: false, occurrences, total, truncated, contentTruncated, alarmsRead };
    },
    async occurrenceDetail(occurrenceKey, readOptions = {}) {
      const decoded = decodeOccurrenceKey(occurrenceKey);
      if (readOptions.shouldContinue !== void 0 && !readOptions.shouldContinue()) {
        throw new CalendarError("\u6240\u9009\u65E5\u7A0B\u8BE6\u60C5\u8BFB\u53D6\u5DF2\u53D6\u6D88", "calendar");
      }
      const fromMs = Math.min(decoded.startMs, decoded.endMs) - 1;
      const toMs = Math.max(decoded.startMs, decoded.endMs) + 1;
      const CANCELED = Symbol("canceled");
      const outcome = await enqueue("\u8BFB\u53D6\u65E5\u7A0B\u5B9E\u4F8B\u8BE6\u60C5", async () => {
        if (readOptions.shouldContinue !== void 0 && !readOptions.shouldContinue()) return CANCELED;
        return runEventKitJxa(
          bridge,
          "\u8BFB\u53D6\u65E5\u7A0B\u5B9E\u4F8B\u8BE6\u60C5",
          eventKitOccurrenceDetailScript({ occurrenceKey, fromMs, toMs, maxOutputBytes: outputBudget })
        );
      });
      if (outcome === CANCELED) throw new CalendarError("\u6240\u9009\u65E5\u7A0B\u8BE6\u60C5\u8BFB\u53D6\u5DF2\u53D6\u6D88", "calendar");
      requireFullAccess(outcome);
      let occurrence = parseOccurrence(outcome.occurrence);
      if (occurrence.occurrenceKey !== occurrenceKey) {
        throw new CalendarError("\u7CFB\u7EDF\u672A\u8FD4\u56DE\u540C\u4E00\u5B9E\u4F8B\u7684\u8BE6\u60C5\uFF0C\u5DF2\u62D2\u7EDD\u7528\u91CD\u590D\u6BCD\u4E8B\u4EF6\u8986\u76D6\u6240\u9009\u65E5\u671F\u3002", "calendar");
      }
      if (occurrence.editableUid !== null && ambiguousEditableUids.has(occurrence.editableUid)) {
        occurrence = { ...occurrence, editableUid: null };
      }
      if (typeof outcome.contentTruncated !== "boolean" || outcome.contentTruncated !== occurrence.fieldsTruncated) {
        throw new CalendarError("\u7CFB\u7EDF\u65E5\u5386\u8FD4\u56DE\u7684\u5B9E\u4F8B\u8BE6\u60C5\u622A\u65AD\u6807\u5FD7\u4E0D\u6B63\u786E", "calendar");
      }
      return occurrence;
    },
    async requestFullAccess() {
      const payload = await enqueue(
        "\u8BF7\u6C42\u5B8C\u6574\u65E5\u5386\u8BBF\u95EE",
        () => runEventKitJxa(
          bridge,
          "\u8BF7\u6C42\u5B8C\u6574\u65E5\u5386\u8BBF\u95EE",
          requestEventKitFullAccessScript({ waitMs: permissionWaitMs })
        )
      );
      const status = payload.status;
      if (status !== 3) throw permissionError(status);
      return { status, canRead: true };
    },
    async openPrivacySettings() {
      const result = await execRun2(
        bridge,
        "\u6253\u5F00\u65E5\u5386\u9690\u79C1\u8BBE\u7F6E",
        "open",
        ["x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars"],
        OPEN_TIMEOUT_MS2
      );
      if (result.code !== 0) {
        throw new CalendarError(`\u65E0\u6CD5\u6253\u5F00\u65E5\u5386\u9690\u79C1\u8BBE\u7F6E\uFF08\u9000\u51FA\u7801 ${result.code}\uFF09\uFF1A${firstLine2(result.stderr) || "\u65E0\u8F93\u51FA"}`, "bridge");
      }
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

// src/panel-format.ts
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
  if (detail === null || detail.occurrenceKey !== event.occurrenceKey) return "\u8BFB\u53D6\u4E2D\u2026";
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
function eventTitleText(event) {
  return event.title === "" ? "\u672A\u586B\u5199\u6807\u9898" : event.title;
}

// src/panel.ts
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
    const [loadSeqRef] = useState(() => ({ generation: 0, active: true, anchorMs: monthAnchorOf(nowMs) }));
    const [metaNotice, setMetaNotice] = useState("");
    const [detailSeqRef] = useState(() => ({ generation: 0 }));
    const [anchorMs, setAnchorMs] = useState(() => monthAnchorOf(nowMs));
    const [selectedDayMs, setSelectedDayMs] = useState(() => beijingDayStart(nowMs));
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    const [partial, setPartial] = useState(false);
    const [contentPartial, setContentPartial] = useState(false);
    const [rangeTotal, setRangeTotal] = useState(0);
    const [permissionStatus, setPermissionStatus] = useState(null);
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
    const [reminders, setReminders] = useState([]);
    const [reminderLoadError, setReminderLoadError] = useState("");
    const [remindersPartial, setRemindersPartial] = useState(false);
    const [remindersLoading, setRemindersLoading] = useState(true);
    const [editingReminderId, setEditingReminderId] = useState("");
    const [editTitle, setEditTitle] = useState("");
    const [editDate, setEditDate] = useState("");
    const [editTime, setEditTime] = useState("");
    const [confirmDeleteId, setConfirmDeleteId] = useState("");
    const [detail, setDetail] = useState(null);
    function clearDetail() {
      detailSeqRef.generation++;
      setDetailKey("");
      setDetail(null);
    }
    async function loadMonth(nextAnchor) {
      if (!loadSeqRef.active) return;
      loadSeqRef.anchorMs = nextAnchor;
      const seq = ++loadSeqRef.generation;
      clearDetail();
      setLoading(true);
      setError("");
      setPartial(false);
      setContentPartial(false);
      setRangeTotal(0);
      setPermissionStatus(null);
      setMetaNotice("");
      setEvents([]);
      setReminders([]);
      setRemindersLoading(true);
      setReminderLoadError("");
      setRemindersPartial(false);
      try {
        const win = monthWindow(nextAnchor);
        void api.remindersInRange(win.fromMs, win.toMs).then((out) => {
          if (seq !== loadSeqRef.generation) return;
          setReminders(out.reminders);
          setRemindersPartial(out.truncated);
          setReminderLoadError(out.error ?? "");
          setRemindersLoading(false);
        }).catch((cause) => {
          if (seq !== loadSeqRef.generation) return;
          setReminderLoadError(cause instanceof Error ? cause.message : String(cause));
          setRemindersLoading(false);
        });
        const [range, draftItems] = await Promise.all([
          api.eventsInRange(win.fromMs, win.toMs, {
            // 换月/刷新后旧批次停止（入口与排队闭包执行前检查；已取消的结果在此被丢弃）
            shouldContinue: () => seq === loadSeqRef.generation
          }),
          api.drafts()
        ]);
        if (seq !== loadSeqRef.generation) return;
        setEvents(range.events);
        setPartial(range.truncated === true);
        setContentPartial(range.contentTruncated === true);
        setRangeTotal(range.total ?? range.events.length);
        setPermissionStatus(range.permissionStatus ?? null);
        setError(range.error ?? "");
        setDrafts(draftItems);
        setLoading(false);
        if (range.error) return;
        const calendarsOut = await api.calendars({ shouldContinue: () => seq === loadSeqRef.generation });
        if (seq !== loadSeqRef.generation) return;
        setCalendars(calendarsOut.calendars);
        setMetaNotice(calendarsOut.error ?? "");
      } catch (cause) {
        if (seq !== loadSeqRef.generation) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (seq === loadSeqRef.generation) {
          setLoading(false);
        }
      }
    }
    async function fetchDetail(occurrenceKey) {
      const seq = ++detailSeqRef.generation;
      setDetail({ occurrenceKey, status: "loading" });
      try {
        const event = await api.eventDetail(occurrenceKey, { shouldContinue: () => seq === detailSeqRef.generation });
        if (seq !== detailSeqRef.generation) return;
        setDetail({ occurrenceKey, status: "ok", event });
      } catch (cause) {
        if (seq !== detailSeqRef.generation) return;
        setDetail({ occurrenceKey, status: "error", error: cause instanceof Error ? cause.message : String(cause) });
      }
    }
    useEffect(() => {
      loadSeqRef.active = true;
      void loadMonth(anchorMs);
      const onFocus = () => {
        void loadMonth(loadSeqRef.anchorMs);
      };
      const browser = globalThis;
      browser.addEventListener?.("focus", onFocus);
      return () => {
        browser.removeEventListener?.("focus", onFocus);
        loadSeqRef.active = false;
        loadSeqRef.generation++;
        detailSeqRef.generation++;
      };
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
      void loadMonth(next);
    }
    function gotoToday() {
      const todayAnchor = monthAnchorOf(Date.now());
      setAnchorMs(todayAnchor);
      setSelectedDayMs(beijingDayStart(Date.now()));
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
        await loadMonth(anchorMs);
      } catch (cause) {
        setReminderError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setReminderBusy(false);
      }
    }
    async function runReminder(action) {
      setReminderBusy(true);
      setReminderError("");
      try {
        await action();
        await loadMonth(anchorMs);
      } catch (cause) {
        setReminderError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setReminderBusy(false);
      }
    }
    function beginReminderEdit(item) {
      const t = beijingWallClockParts(item.remindMs ?? item.dueMs ?? selectedDayMs + 9 * 36e5);
      setEditingReminderId(item.id);
      setEditTitle(item.title);
      setEditDate(`${t.y}-${pad22(t.mo)}-${pad22(t.d)}`);
      setEditTime(`${pad22(t.hh)}:${pad22(t.mi)}`);
      setConfirmDeleteId("");
      setReminderError("");
    }
    async function saveReminderEdit(item) {
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(editDate);
      if (!match) {
        setReminderError("\u8BF7\u586B\u5199\u771F\u5B9E\u65E5\u671F\uFF0C\u4F8B\u5982 2026-09-23");
        return;
      }
      const y = Number(match[1]);
      const mo = Number(match[2]);
      const d = Number(match[3]);
      const utc = Date.UTC(y, mo - 1, d);
      const checkDate = new Date(utc);
      if (checkDate.getUTCFullYear() !== y || checkDate.getUTCMonth() !== mo - 1 || checkDate.getUTCDate() !== d) {
        setReminderError("\u63D0\u9192\u65E5\u671F\u4E0D\u771F\u5B9E");
        return;
      }
      const check = reminderDraftCheck({ title: editTitle, time: editTime }, utc - 8 * 36e5);
      if (!check.ok) {
        setReminderError(check.error);
        return;
      }
      const originalMs = item.remindMs ?? item.dueMs;
      const timeChanged = originalMs === null || Math.floor(originalMs / 6e4) !== Math.floor(check.dueMs / 6e4);
      const titleChanged = editTitle.trim() !== item.title;
      if (!timeChanged && !titleChanged) {
        setEditingReminderId("");
        return;
      }
      const timeChanges = !timeChanged ? {} : item.remindMs === null ? { dueMs: check.dueMs } : item.dueMs !== null && Math.abs(item.remindMs - item.dueMs) <= 2e3 ? { dueMs: check.dueMs, remindMs: check.dueMs } : { remindMs: check.dueMs };
      await runReminder(async () => {
        await api.updateReminder({ id: item.id, ...titleChanged ? { title: editTitle.trim() } : {}, ...timeChanges });
        setEditingReminderId("");
        setNotice("\u63D0\u9192\u5DF2\u540C\u6B65\u5230\u7CFB\u7EDF\u300C\u63D0\u9192\u4E8B\u9879\u300D\u3002");
      });
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
    async function handleCalendarPermission() {
      setBusy(true);
      setError("");
      setNotice("");
      try {
        if (permissionStatus === 2) {
          await api.openCalendarPrivacySettings();
          setNotice("\u5DF2\u6253\u5F00\u7CFB\u7EDF\u65E5\u5386\u6743\u9650\u8BBE\u7F6E\u3002\u8BF7\u7531\u4F60\u672C\u4EBA\u8C03\u6574\u4E3A\u5B8C\u6574\u8BBF\u95EE\uFF0C\u8FD4\u56DE\u540E\u70B9\u201C\u5237\u65B0\u201D\u3002");
          return;
        }
        await api.requestCalendarAccess();
        setNotice("\u7CFB\u7EDF\u5DF2\u6388\u4E88\u5B8C\u6574\u65E5\u5386\u8BBF\u95EE\uFF0C\u6B63\u5728\u91CD\u65B0\u8BFB\u53D6\u3002");
        await loadMonth(anchorMs);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    }
    const visible = activeCalendar === "" ? events : events.filter((event) => event.calendar === activeCalendar);
    const grid = monthGrid(anchorMs, Date.now(), visible);
    const dayEvents = eventsOnDay(visible, selectedDayMs);
    const dayReminders = reminders.filter((item) => {
      const ms = item.remindMs ?? item.dueMs;
      return ms !== null && beijingDayStart(ms) === selectedDayMs;
    }).sort((a, b) => (a.remindMs ?? a.dueMs ?? 0) - (b.remindMs ?? b.dueMs ?? 0));
    const todayStart = beijingDayStart(Date.now());
    const noEventsLine = dayReminders.length > 0 ? `${dayEvents.length} \u573A\u65E5\u7A0B \xB7 ${dayReminders.length} \u6761\u63D0\u9192` : remindersLoading ? "\u6B63\u5728\u8BFB\u53D6\u63D0\u9192\u2026" : reminderLoadError !== "" ? "\u63D0\u9192\u8BFB\u53D6\u5931\u8D25" : dayEvents.length === 0 ? partial || remindersPartial ? "\u672A\u5728\u5DF2\u8BFB\u53D6\u7684\u90E8\u5206\u5B89\u6392\u4E2D\u627E\u5230\u65E5\u7A0B\u6216\u63D0\u9192" : "\u65E0\u5B89\u6392" : `${dayEvents.length} \u573A\u5B89\u6392`;
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
          if (reminders.some((item) => {
            const ms = item.remindMs ?? item.dueMs;
            return ms !== null && beijingDayStart(ms) === cell.dayStartMs;
          }) && cellDots.length < 3) cellDots.push("#2563EB");
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
                clearDetail();
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
          onClick: () => {
            clearDetail();
            setActiveCalendar("");
          }
        }, "\u5168\u90E8"),
        ...calendars.map(
          (cal) => el("button", {
            key: cal.name,
            title: cal.name,
            className: `shrink-0 rounded-full px-3 text-caption-1-medium transition-colors ${activeCalendar === cal.name ? "bg-pill-tab-blue-selected-background text-status-blue-text" : "text-text-secondary hover:bg-background-secondary-hover"}`,
            style: PILL_PAD,
            onClick: () => {
              clearDetail();
              setActiveCalendar(cal.name);
            }
          }, cal.name)
        )
      ),
      // ———————— 状态提示 ————————
      error === "" ? null : el("div", {
        className: "rounded-lg bg-background-tertiary-error px-3 py-2 text-caption-1-regular text-text-error-primary",
        style: { margin: "8px 12px 0" }
      }, error),
      error === "" || ![0, 2, 4].includes(permissionStatus ?? -1) ? null : el("div", {
        className: "px-3",
        style: { paddingTop: "8px" }
      }, el("button", {
        type: "button",
        className: "rounded-md bg-accent-500 px-3 py-2 text-caption-1-medium text-white shadow-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        disabled: busy,
        onClick: () => {
          void handleCalendarPermission();
        }
      }, permissionStatus === 2 ? "\u6253\u5F00\u7CFB\u7EDF\u8BBE\u7F6E" : permissionStatus === 4 ? "\u6388\u6743\u5B8C\u6574\u8BFB\u53D6" : "\u6388\u6743\u8BFB\u53D6\u65E5\u5386")),
      notice === "" ? null : el("div", {
        className: "rounded-lg bg-background-secondary-default px-3 py-2 text-caption-1-regular text-text-primary",
        style: { margin: "8px 12px 0" }
      }, notice),
      metaNotice === "" || loading ? null : el("div", {
        className: "rounded-lg bg-background-secondary-default px-3 py-2 text-caption-1-regular text-text-secondary",
        style: { margin: "8px 12px 0" }
      }, `\u65E5\u5386\u5206\u7C7B\u4FE1\u606F\u8BFB\u53D6\u5931\u8D25\uFF1A\u8272\u70B9\u4E0E\u7B5B\u9009\u6682\u4E0D\u53EF\u7528\uFF0C\u4EE5\u4E0A\u65E5\u7A0B\u4E0D\u53D7\u5F71\u54CD\u3002\uFF08${metaNotice}\uFF09`),
      // 截断如实提示：窗口内日程超过上限时不能假装列表完整
      partial && !loading ? el("div", {
        className: "rounded-lg bg-background-secondary-default px-3 py-2 text-caption-1-regular text-text-secondary",
        style: { margin: "8px 12px 0" }
      }, `\u7ED3\u679C\u8D85\u8FC7\u5B89\u5168\u8BFB\u53D6\u4E0A\u9650\uFF0C\u4EC5\u52A0\u8F7D ${events.length}/${rangeTotal} \u6761\uFF0C\u6570\u636E\u672A\u5B8C\u6574\uFF1A\u53EF\u7F29\u77ED\u8303\u56F4\u6216\u5230\u65E5\u5386.app \u67E5\u770B\u5168\u90E8\u3002`) : null,
      contentPartial && !loading ? el("div", {
        className: "rounded-lg bg-background-secondary-default px-3 py-2 text-caption-1-regular text-text-secondary",
        style: { margin: "8px 12px 0" }
      }, "\u90E8\u5206\u8D85\u957F\u8BE6\u60C5\u5DF2\u6309\u771F\u5B9E\u5B57\u8282\u4E0A\u9650\u7F29\u77ED\uFF1B\u5B8C\u6574\u5185\u5BB9\u8BF7\u5230\u65E5\u5386.app \u67E5\u770B\u3002") : null,
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
              disabled: busy || reminderBusy || remindersLoading,
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
                disabled: reminderBusy || remindersLoading,
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
                disabled: reminderBusy || remindersLoading,
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
          reminderLoadError === "" ? null : el(
            "p",
            { className: "px-3 py-2 text-caption-1-regular text-text-error-primary" },
            `\u7CFB\u7EDF\u63D0\u9192\u6682\u65F6\u65E0\u6CD5\u8BFB\u53D6\uFF1A${reminderLoadError}`
          ),
          remindersPartial ? el(
            "p",
            { className: "px-3 py-2 text-caption-1-regular text-text-tertiary" },
            `\u7CFB\u7EDF\u63D0\u9192\u8F83\u591A\uFF0C\u4EC5\u663E\u793A\u5DF2\u8BFB\u53D6\u7684 ${reminders.length} \u6761\uFF1B\u8BF7\u5230\u300C\u63D0\u9192\u4E8B\u9879\u300D\u67E5\u770B\u5B8C\u6574\u5217\u8868\u3002`
          ) : null,
          reminderError === "" ? null : el("p", { className: "px-3 py-2 text-caption-1-regular text-text-error-primary" }, reminderError),
          dayReminders.length === 0 ? null : el(
            "div",
            { className: "flex flex-col gap-1 px-2 py-2" },
            el("span", { className: "text-caption-1-medium text-text-secondary" }, `\u63D0\u9192\u4E8B\u9879 \xB7 ${dayReminders.length}`),
            ...dayReminders.map((item) => el(
              "div",
              { key: item.id, className: "rounded-xl bg-background-secondary-default p-2" },
              el(
                "div",
                { className: "flex items-center gap-2" },
                el("button", {
                  type: "button",
                  title: `${item.completed ? "\u91CD\u65B0\u6253\u5F00" : "\u5B8C\u6210"}\u63D0\u9192\uFF1A${item.title}`,
                  disabled: reminderBusy,
                  className: "shrink-0 text-status-blue-text",
                  onClick: () => {
                    void runReminder(async () => {
                      await api.setReminderCompleted({ id: item.id, completed: !item.completed });
                      setNotice(item.completed ? "\u63D0\u9192\u5DF2\u91CD\u65B0\u6253\u5F00\u3002" : "\u63D0\u9192\u5DF2\u5B8C\u6210\u3002");
                    });
                  }
                }, item.completed ? "\u25CF" : "\u25CB"),
                el(
                  "div",
                  { className: "min-w-0 flex-1" },
                  el("div", { className: `truncate text-body-2-medium text-text-primary ${item.completed ? "line-through opacity-60" : ""}` }, item.title || "\u672A\u586B\u5199\u6807\u9898"),
                  el(
                    "div",
                    { className: "text-caption-2-medium text-text-tertiary" },
                    `${item.list} \xB7 ${item.remindMs === null ? "\u5168\u5929" : `${pad22(beijingWallClockParts(item.remindMs).hh)}:${pad22(beijingWallClockParts(item.remindMs).mi)}`} \xB7 ${item.completed ? "\u5DF2\u5B8C\u6210" : "\u672A\u5B8C\u6210"}`
                  )
                ),
                el("button", {
                  type: "button",
                  title: `\u7F16\u8F91\u63D0\u9192\uFF1A${item.title}`,
                  disabled: reminderBusy,
                  className: "text-caption-2-medium text-status-blue-text",
                  onClick: () => beginReminderEdit(item)
                }, "\u7F16\u8F91"),
                el("button", {
                  type: "button",
                  title: `\u5220\u9664\u63D0\u9192\uFF1A${item.title}`,
                  disabled: reminderBusy,
                  className: "text-caption-2-medium text-text-error-primary",
                  onClick: () => {
                    setConfirmDeleteId(item.id);
                    setEditingReminderId("");
                    setReminderError("");
                  }
                }, "\u5220\u9664")
              ),
              editingReminderId !== item.id ? null : el(
                "div",
                { className: "mt-2 flex flex-col gap-2" },
                el("input", {
                  placeholder: "\u4FEE\u6539\u63D0\u9192\u5185\u5BB9",
                  value: editTitle,
                  disabled: reminderBusy,
                  className: "w-full rounded-md border border-border-button-default bg-background-full px-2 py-1 text-text-primary",
                  onChange: (event) => setEditTitle(event.target.value)
                }),
                el(
                  "div",
                  { className: "flex gap-2" },
                  el("input", {
                    placeholder: "YYYY-MM-DD",
                    value: editDate,
                    disabled: reminderBusy,
                    className: "min-w-0 flex-1 rounded-md border border-border-button-default bg-background-full px-2 py-1 text-text-primary",
                    onChange: (event) => setEditDate(event.target.value)
                  }),
                  el("input", {
                    placeholder: "HH:mm",
                    value: editTime,
                    disabled: reminderBusy,
                    className: "w-20 rounded-md border border-border-button-default bg-background-full px-2 py-1 text-text-primary",
                    onChange: (event) => setEditTime(event.target.value)
                  })
                ),
                el(
                  "div",
                  { className: "flex gap-2" },
                  el("button", {
                    type: "button",
                    disabled: reminderBusy,
                    className: "text-caption-1-medium text-status-blue-text",
                    onClick: () => {
                      void saveReminderEdit(item);
                    }
                  }, "\u4FDD\u5B58\u4FEE\u6539"),
                  el("button", {
                    type: "button",
                    disabled: reminderBusy,
                    className: "text-caption-1-medium text-text-secondary",
                    onClick: () => setEditingReminderId("")
                  }, "\u53D6\u6D88\u7F16\u8F91")
                )
              ),
              confirmDeleteId !== item.id ? null : el(
                "div",
                { className: "mt-2 flex gap-2 text-caption-1-medium" },
                el("span", { className: "text-text-secondary" }, "\u5220\u9664\u540E\u7CFB\u7EDF\u300C\u63D0\u9192\u4E8B\u9879\u300D\u4E2D\u4E5F\u4F1A\u5220\u9664\u3002"),
                el("button", {
                  type: "button",
                  disabled: reminderBusy,
                  className: "text-text-error-primary",
                  onClick: () => {
                    void runReminder(async () => {
                      await api.deleteReminder({ id: item.id, confirm: true });
                      setConfirmDeleteId("");
                      setNotice("\u63D0\u9192\u5DF2\u4ECE\u7CFB\u7EDF\u300C\u63D0\u9192\u4E8B\u9879\u300D\u5220\u9664\u3002");
                    });
                  }
                }, "\u786E\u8BA4\u5220\u9664"),
                el("button", {
                  type: "button",
                  disabled: reminderBusy,
                  className: "text-text-secondary",
                  onClick: () => setConfirmDeleteId("")
                }, "\u53D6\u6D88")
              )
            ))
          ),
          // 日程列表
          loading || error !== "" ? el(
            "p",
            { className: "px-3 py-2 text-caption-1-regular text-text-tertiary" },
            loading ? "\u6B63\u5728\u8BFB\u53D6\u65E5\u7A0B\uFF0C\u8BF7\u7A0D\u5019\u2026\uFF08\u8BFB\u53D6\u5B8C\u6210\u524D\uFF0C\u4E0D\u4EE3\u8868\u8FD9\u4E00\u5929\u6CA1\u6709\u5B89\u6392\uFF09" : "\u8BFB\u53D6\u5931\u8D25\uFF0C\u6682\u65F6\u65E0\u6CD5\u5224\u65AD\u8FD9\u4E00\u5929\u662F\u5426\u6709\u5B89\u6392\u3002"
          ) : dayEvents.length === 0 && dayReminders.length === 0 && !remindersLoading && reminderLoadError === "" ? partial || remindersPartial ? el(
            "div",
            { className: "flex flex-col items-center text-center", style: { padding: "32px 24px 0" } },
            el("div", {
              className: "flex items-center justify-center rounded-full bg-background-quaternary-default text-foreground-icon-tertiary",
              style: { width: "44px", height: "44px" }
            }, icon(el, "calendar", { size: 20 })),
            el("div", { className: "text-body-2-medium text-text-primary", style: { marginTop: "10px" } }, "\u5DF2\u8BFB\u53D6\u7684\u90E8\u5206\u5B89\u6392\u4E2D\u6CA1\u6709\u8FD9\u4E00\u5929\u7684\u8BB0\u5F55"),
            el("div", { className: "mt-1 text-caption-1-regular text-text-tertiary" }, "\u672C\u6708\u8BB0\u5F55\u672A\u5168\u90E8\u52A0\u8F7D\uFF1B\u5B8C\u6574\u5B89\u6392\u8BF7\u5230\u7CFB\u7EDF\u65E5\u5386\u6216\u63D0\u9192\u4E8B\u9879\u67E5\u770B\u3002")
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
              const key = event.occurrenceKey;
              const expanded = detailKey === key;
              const hasDetail = detail !== null && detail.occurrenceKey === event.occurrenceKey && detail.status === "ok";
              const detailEvent = hasDetail && detail?.event ? detail.event : event;
              const alarmIconOn = hasDetail ? (detail?.event?.alarmTimes.length ?? 0) > 0 || (detail?.event?.hasAlarm ?? false) : event.alarmTimes.length > 0 || event.hasAlarm;
              return el(
                "div",
                { key },
                el(
                  "div",
                  {
                    className: "flex cursor-pointer items-start gap-2 rounded-xl py-2 transition-colors hover:bg-background-secondary-hover",
                    style: { paddingInline: "8px" },
                    onClick: () => {
                      if (expanded) clearDetail();
                      else setDetailKey(key);
                      if (!expanded) void fetchDetail(event.occurrenceKey);
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
                    el("div", { className: "truncate text-body-2-medium text-text-primary" }, eventTitleText(event)),
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
                // 展开详情：按 occurrenceKey 回查同一次 EventKit 发生实例。
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
                    el("span", { className: "truncate text-body-2-medium text-text-primary" }, eventTitleText(detailEvent))
                  ),
                  el("span", { className: "text-caption-1-regular text-text-secondary" }, `\u65F6\u95F4\uFF1A${eventWhenText(detailEvent)}`),
                  detailEvent.location === "" ? null : el("span", { className: "text-caption-1-regular text-text-secondary" }, `\u5730\u70B9\uFF1A${detailEvent.location}`),
                  el("span", { className: "text-caption-1-regular text-text-secondary" }, `\u65E5\u5386\uFF1A${detailEvent.calendar}`),
                  el("span", { className: "text-caption-1-regular text-text-secondary" }, `\u63D0\u9192\uFF1A${detailAlarmText(event, detail)}`),
                  detailEvent.timeZone === "" ? null : el("span", { className: "text-caption-1-regular text-text-secondary" }, `\u65F6\u533A\uFF1A${detailEvent.timeZone}`),
                  detailEvent.isRecurring || detailEvent.isDetached ? el("span", { className: "text-caption-1-regular text-text-secondary" }, detailEvent.isDetached ? "\u91CD\u590D\u65E5\u7A0B\uFF08\u672C\u6B21\u5DF2\u5355\u72EC\u8C03\u6574\uFF09" : "\u91CD\u590D\u65E5\u7A0B") : null,
                  detailEvent.isRecurring || detailEvent.isDetached ? el("span", { className: "text-caption-1-regular text-text-secondary" }, "\u5F53\u524D\u4EC5\u652F\u6301\u53EA\u8BFB\u67E5\u770B\uFF1A\u5982\u9700\u4FEE\u6539\u6216\u5220\u9664\u672C\u6B21\u53D1\u751F\uFF0C\u8BF7\u5230\u7CFB\u7EDF\u65E5\u5386\u64CD\u4F5C") : detailEvent.editableUid === null ? el("span", { className: "text-caption-1-regular text-text-secondary" }, "\u5F53\u524D\u4EC5\u652F\u6301\u53EA\u8BFB\u67E5\u770B\uFF1A\u7CFB\u7EDF\u672A\u63D0\u4F9B\u53EF\u5B89\u5168\u7528\u4E8E\u4FEE\u6539/\u5220\u9664\u7684 uid") : null,
                  detailEvent.fieldsTruncated ? el("span", { className: "text-caption-1-regular text-text-secondary" }, "\u90E8\u5206\u8D85\u957F\u8BE6\u60C5\u5DF2\u7F29\u77ED\uFF0C\u5B8C\u6574\u5185\u5BB9\u8BF7\u5230\u65E5\u5386.app \u67E5\u770B") : null,
                  detailEvent.notes === "" ? null : el("span", {
                    className: "text-caption-1-regular text-text-secondary",
                    style: { whiteSpace: "pre-wrap", wordBreak: "break-all" }
                  }, `\u5907\u6CE8\uFF1A${detailEvent.notes}`)
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

// src/settings.ts
function createSettingsPanel(ctx, api) {
  const { createElement, useState, useEffect } = ctx.react;
  return function CalendarSettingsPanel() {
    const [readOwner] = useState(() => ({ generation: 0, active: true }));
    const [status, setStatus] = useState(null);
    const [events, setEvents] = useState([]);
    const [window, setWindow] = useState(null);
    const [eventsError, setEventsError] = useState("");
    const [eventsTotal, setEventsTotal] = useState(0);
    const [eventsPartial, setEventsPartial] = useState(false);
    const [contentPartial, setContentPartial] = useState(false);
    const [permissionStatus, setPermissionStatus] = useState(null);
    const [drafts, setDrafts] = useState([]);
    const [notice, setNotice] = useState("");
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);
    async function refresh() {
      if (!readOwner.active) return;
      const generation = ++readOwner.generation;
      const readOptions = { shouldContinue: () => readOwner.active && generation === readOwner.generation };
      setBusy(true);
      setError("");
      try {
        const [upcoming, draftItems] = await Promise.all([api.upcoming(readOptions), api.drafts()]);
        if (!readOptions.shouldContinue()) return;
        setEvents(upcoming.events);
        setWindow({ fromMs: upcoming.fromMs, toMs: upcoming.toMs });
        setEventsError(upcoming.error ?? "");
        setEventsTotal(upcoming.total ?? upcoming.events.length);
        setEventsPartial(upcoming.truncated === true);
        setContentPartial(upcoming.contentTruncated === true);
        setPermissionStatus(upcoming.permissionStatus ?? null);
        setDrafts(draftItems);
        const calendarsOut = await api.calendars(readOptions);
        if (!readOptions.shouldContinue()) return;
        const writableCount = calendarsOut.calendars.filter((calendar) => calendar.writable).length;
        setStatus(
          calendarsOut.error ? { ok: false, writableCount: 0, error: calendarsOut.error } : { ok: true, writableCount }
        );
        setPermissionStatus(calendarsOut.permissionStatus ?? upcoming.permissionStatus ?? null);
      } catch (cause) {
        if (!readOptions.shouldContinue()) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (readOptions.shouldContinue()) setBusy(false);
      }
    }
    useEffect(() => {
      readOwner.active = true;
      void refresh();
      return () => {
        readOwner.active = false;
        readOwner.generation++;
      };
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
    async function handlePermission() {
      setBusy(true);
      setError("");
      setNotice("");
      try {
        if (permissionStatus === 2) {
          await api.openCalendarPrivacySettings();
          setNotice("\u5DF2\u6253\u5F00\u7CFB\u7EDF\u65E5\u5386\u6743\u9650\u8BBE\u7F6E\u3002\u8BF7\u7531\u4F60\u672C\u4EBA\u8C03\u6574\u4E3A\u5B8C\u6574\u8BBF\u95EE\uFF0C\u8FD4\u56DE\u540E\u70B9\u201C\u5237\u65B0\u201D\u3002");
        } else {
          await api.requestCalendarAccess();
          setNotice("\u7CFB\u7EDF\u5DF2\u6388\u4E88\u5B8C\u6574\u65E5\u5386\u8BBF\u95EE\u3002");
          await refresh();
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    }
    const statusLine = status ? status.ok ? `\u5DF2\u8FDE\u63A5\u7CFB\u7EDF\u65E5\u5386\uFF08${status.writableCount} \u4E2A\u53EF\u5199\u65E5\u5386\uFF09` : "\u7CFB\u7EDF\u65E5\u5386\u4E0D\u53EF\u7528" : "\u6B63\u5728\u68C0\u67E5\u7CFB\u7EDF\u65E5\u5386\u2026";
    const SMALL_PAD = { paddingTop: "6px", paddingBottom: "6px" };
    return createElement(
      "div",
      { className: "flex flex-col gap-3", style: { padding: "16px" } },
      createElement(
        "div",
        { className: "flex items-center justify-between gap-2" },
        createElement(
          "span",
          { className: `text-body-2-medium ${status && !status.ok ? "text-text-error-primary" : "text-text-primary"}` },
          statusLine
        ),
        createElement(
          "button",
          {
            type: "button",
            className: "rounded-md px-3 text-caption-2-medium text-text-secondary transition-colors hover:bg-button-ghost-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50",
            style: { ...SMALL_PAD, border: "1px solid var(--color-border-button-default)" },
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
      status && !status.ok && [0, 2, 4].includes(permissionStatus ?? -1) ? createElement(
        "button",
        {
          type: "button",
          className: "self-start rounded-md bg-blue-600 px-3 text-caption-2-medium text-white disabled:opacity-50",
          style: SMALL_PAD,
          disabled: busy,
          onClick: () => {
            void handlePermission();
          }
        },
        permissionStatus === 2 ? "\u6253\u5F00\u7CFB\u7EDF\u8BBE\u7F6E" : permissionStatus === 4 ? "\u6388\u6743\u5B8C\u6574\u8BFB\u53D6" : "\u6388\u6743\u8BFB\u53D6\u65E5\u5386"
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
            (event) => createElement(
              "li",
              { key: event.occurrenceKey, className: "flex flex-col gap-1.5 px-3 py-2" },
              createElement("span", { className: "text-body-2-regular text-text-primary" }, event.title === "" ? "\u672A\u586B\u5199\u6807\u9898" : event.title),
              createElement(
                "span",
                { className: "text-caption-2-medium text-text-tertiary" },
                `${formatDraftWhen({
                  start: toBeijingNaive(event.startMs),
                  // EventKit 全天 endDate 是排他边界；草稿格式器接收最后一个实际日期。
                  end: toBeijingNaive(event.allDay ? Math.max(event.startMs, event.endMs - 1) : event.endMs),
                  allDay: event.allDay
                })} \xB7 \u65E5\u5386\u300A${event.calendar}\u300B \xB7 ${event.alarmTimes.length > 0 || event.hasAlarm ? "\u6709\u63D0\u9192" : "\u65E0\u63D0\u9192"}${event.location ? ` \xB7 ${event.location}` : ""}`
              )
            )
          )
        ),
        eventsPartial ? createElement("p", { className: "text-caption-1-regular text-text-secondary" }, `\u4EC5\u8BFB\u53D6 ${events.length}/${eventsTotal} \u6761\uFF0C\u5217\u8868\u4E0D\u5B8C\u6574\u3002`) : null,
        contentPartial ? createElement("p", { className: "text-caption-1-regular text-text-secondary" }, "\u90E8\u5206\u8D85\u957F\u8BE6\u60C5\u5DF2\u6309\u8BFB\u53D6\u5927\u5C0F\u9650\u5236\u7F29\u77ED\u3002") : null
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
                  style: { ...SMALL_PAD, border: "1px solid var(--color-border-button-default)" },
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

// src/index.ts
var STORAGE_KEY = "drafts";
var REGISTRY_KEY = "events";
var DAY_MS2 = 864e5;
function activate(ctx) {
  const disposers = [];
  let disposed = false;
  const bridge = {
    invoke(method, payload) {
      ensureActive();
      return ctx.bridge.invoke(method, payload);
    }
  };
  const apple = createAppleCalendar(bridge);
  const eventKit = createEventKitCalendar(bridge);
  let state = emptyState();
  let registry = emptyRegistry();
  let stateLoaded = null;
  let serial = Promise.resolve();
  function ensureActive() {
    if (disposed) throw new CalendarError("\u65E5\u5386\u63D2\u4EF6\u5DF2\u505C\u6B62\uFF0C\u8BF7\u91CD\u65B0\u6253\u5F00\u540E\u5148\u6838\u5BF9\u7CFB\u7EDF\u65E5\u5386\u3002", "calendar");
  }
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
      ensureActive();
      await ctx.storage.set(STORAGE_KEY, outcome.state);
      state = outcome.state;
      return outcome.result;
    });
  }
  async function mutateRegistry(fn) {
    await enqueue(async () => {
      await ensureLoaded();
      const next = fn(registry);
      ensureActive();
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
      description: "\u53EA\u8BFB\u67E5\u770B macOS \u7CFB\u7EDF\u65E5\u5386\u7684\u771F\u5B9E\u53D1\u751F\u5B9E\u4F8B\uFF1A\u5217\u51FA\u672A\u6765 N \u5929\uFF08\u9ED8\u8BA4 7 \u5929\uFF09\u5185\u4E0E\u65F6\u95F4\u7A97\u76F8\u4EA4\u7684\u65E5\u7A0B\uFF0C\u5305\u542B\u91CD\u590D\u65E5\u7A0B\u7684\u6BCF\u6B21\u53D1\u751F\u3001\u6392\u9664\u65E5\u671F\u548C\u5355\u6B21\u6539\u671F\u7ED3\u679C\uFF0C\u4EE5\u53CA\u8FDB\u884C\u4E2D/\u8DE8\u7A97\u65E5\u7A0B\u3002\u8FD4\u56DE\u6807\u9898\u3001\u65F6\u95F4\u3001\u5730\u70B9\u3001\u5907\u6CE8\u3001\u63D0\u9192\u3001\u6240\u5C5E\u65E5\u5386\uFF1B\u53EA\u6709\u975E\u91CD\u590D\u65E5\u7A0B\u4E14\u7CFB\u7EDF\u63D0\u4F9B\u5B89\u5168\u5916\u90E8 uid \u65F6\u624D\u53EF\u914D\u5408 calendar_update/delete\u3002\u91CD\u590D\u5B9E\u4F8B\u6216\u6CA1\u6709\u5B89\u5168 uid \u7684\u8BB0\u5F55\u4EC5\u4F9B\u67E5\u770B\uFF0C\u5982\u9700\u4FEE\u6539\u67D0\u6B21\u91CD\u590D\u53D1\u751F\u8BF7\u5230\u7CFB\u7EDF\u65E5\u5386\u64CD\u4F5C\u3002",
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
          const outcome = await eventKit.listOccurrences({
            calendar: typeof input.calendar === "string" && input.calendar.trim() ? input.calendar.trim() : null,
            fromMs: nowMs,
            toMs: nowMs + days * DAY_MS2,
            maxRows: MAX_EVENT_ROWS
          });
          if (outcome.canceled) throw new CalendarError("\u65E5\u5386\u67E5\u8BE2\u5DF2\u53D6\u6D88\uFF0C\u8BF7\u91CD\u8BD5\u3002", "calendar");
          return textResult(
            renderOccurrenceList({
              days,
              fromMs: nowMs,
              toMs: nowMs + days * DAY_MS2,
              total: outcome.total,
              truncated: outcome.truncated,
              contentTruncated: outcome.contentTruncated,
              occurrences: outcome.occurrences
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
      description: "\u6309 uid \u4FEE\u6539\u65E5\u5386.app \u91CC\u7684\u975E\u91CD\u590D\u65E5\u7A0B\uFF08calendar_list \u53EA\u4E3A\u53EF\u5B89\u5168\u5B9A\u4F4D\u7684\u975E\u91CD\u590D\u9879\u8FD4\u56DE uid\uFF1B\u91CD\u590D\u65E5\u7A0B\u6216\u5355\u6B21\u4F8B\u5916\u8BF7\u5230\u7CFB\u7EDF\u65E5\u5386\u64CD\u4F5C\uFF09\u3002\u53EF\u6539 title/start/end/location/notes/alarmMinutes\uFF0C\u81F3\u5C11\u7ED9\u4E00\u4E2A\u5B57\u6BB5\u3002\u6CE8\u610F\uFF1A\u63D0\u9192\u6570\u91CF\u51CF\u5C11\u65F6 Calendar.app \u65E0\u6CD5\u539F\u4F4D\u5220\u9664\u63D0\u9192\uFF0C\u65E5\u7A0B\u4F1A\u6309\u65B0\u5B57\u6BB5\u91CD\u5EFA\uFF08uid \u53D8\u5316\uFF0C\u8FD4\u56DE\u7ED3\u679C\u4F1A\u6CE8\u660E\uFF09\u3002",
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
      description: "\u3010\u5220\u9664\u65E5\u7A0B \xB7 \u5FC5\u987B\u5F8B\u5E08\u786E\u8BA4\u3011\u6309 uid \u5220\u9664\u65E5\u5386.app \u91CC\u7684\u975E\u91CD\u590D\u65E5\u7A0B\uFF08calendar_list \u4E0D\u4F1A\u4E3A\u91CD\u590D\u65E5\u7A0B\u6216\u5355\u6B21\u4F8B\u5916\u8FD4\u56DE uid\uFF0C\u8FD9\u7C7B\u9879\u76EE\u8BF7\u5230\u7CFB\u7EDF\u65E5\u5386\u64CD\u4F5C\uFF09\u3002\u5220\u9664\u4E0D\u53EF\u6062\u590D\uFF0C\u5FC5\u987B\u663E\u5F0F\u4F20 confirm=true\u2014\u2014\u5373\u4F7F\u7528\u6237\u5728\u5BF9\u8BDD\u91CC\u8BF4\u8FC7\u300C\u5220\u6389\u5427\u300D\uFF0C\u4E5F\u8981\u5148\u5411\u5F8B\u5E08\u590D\u8FF0\u8981\u5220\u7684\u65E5\u7A0B\uFF08\u6807\u9898/\u65F6\u95F4\uFF09\u5E76\u53D6\u5F97\u786E\u8BA4\u540E\uFF0C\u4EE5 confirm=true \u91CD\u8BD5\u3002",
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
    const attemptKey = `confirmation-attempt-${draft.id}`;
    await enqueue(async () => {
      await ensureLoaded();
      findDraft(state, draft.id);
      if (await ctx.storage.get(attemptKey) != null) {
        throw new CalendarError("\u8BE5\u8349\u7A3F\u5DF2\u5C1D\u8BD5\u5199\u5165\uFF0C\u8BF7\u5148\u5728\u7CFB\u7EDF\u65E5\u5386\u6838\u5BF9\uFF0C\u4E0D\u8981\u91CD\u590D\u786E\u8BA4\uFF1B\u6838\u5BF9\u540E\u53EF\u4E22\u5F03\u6B64\u8349\u7A3F\u5E76\u91CD\u65B0\u8D77\u8349\u3002", "calendar");
      }
      ensureActive();
      await ctx.storage.set(attemptKey, true);
    });
    try {
      ensureActive();
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
      ensureActive();
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
      await ctx.storage.delete(attemptKey);
      return textResult(renderConfirmed(draft, created.calendar, created.uid, alarmMinutes));
    } catch (error) {
      throw new CalendarError(`\u5DF2\u5C1D\u8BD5\u5199\u5165\u65E5\u5386\u4F46\u540E\u7EED\u672A\u5B8C\u5168\u786E\u8BA4\uFF0C\u8BF7\u5230\u7CFB\u7EDF\u65E5\u5386\u6838\u5BF9\uFF0C\u4E0D\u8981\u91CD\u590D\u786E\u8BA4\uFF1A${error instanceof Error ? error.message : String(error)}`, "calendar");
    }
  }
  const api = {
    drafts: () => readDrafts((current) => listDrafts(current)),
    discard: async (id) => {
      const removed = await mutateDrafts((current) => {
        const outcome = removeDraft(current, id);
        return { state: outcome.state, result: outcome.removed };
      });
      await ctx.storage.delete(`confirmation-attempt-${removed.id}`);
      return removed;
    },
    confirm: (id) => confirmDraft(id).then((result) => result.content.map((part) => part.text).join("\n")),
    calendars: async (opts) => {
      try {
        const outcome = await eventKit.listCalendars(opts);
        const calendars = outcome.calendars.filter((calendar, index, rows) => rows.findIndex((row) => row.name === calendar.name) === index);
        return {
          calendars,
          ...outcome.truncated || outcome.contentTruncated ? { error: `\u65E5\u5386\u5206\u7C7B\u4FE1\u606F\u4E0D\u5B8C\u6574\uFF08\u8FD4\u56DE ${outcome.calendars.length}/${outcome.total} \u4E2A\uFF0C\u6216\u540D\u79F0\u8FC7\u957F\uFF09\uFF0C\u8272\u70B9\u4E0E\u7B5B\u9009\u53EF\u80FD\u4E0D\u5B8C\u6574\u3002` } : {}
        };
      } catch (cause) {
        return {
          calendars: [],
          error: cause instanceof Error ? cause.message : String(cause),
          ...cause instanceof EventKitPermissionError && cause.status !== null ? { permissionStatus: cause.status } : {}
        };
      }
    },
    upcoming: async (opts) => {
      const nowMs = Date.now();
      const toMs = nowMs + DEFAULT_DAYS * DAY_MS2;
      try {
        const outcome = await eventKit.listOccurrences({ calendar: null, fromMs: nowMs, toMs, maxRows: MAX_EVENT_ROWS }, opts);
        if (outcome.canceled) return { events: [], fromMs: nowMs, toMs, error: "\u65E5\u5386\u67E5\u8BE2\u5DF2\u53D6\u6D88" };
        return {
          events: outcome.occurrences,
          fromMs: nowMs,
          toMs,
          total: outcome.total,
          truncated: outcome.truncated,
          contentTruncated: outcome.contentTruncated
        };
      } catch (cause) {
        return {
          events: [],
          fromMs: nowMs,
          toMs,
          error: cause instanceof Error ? cause.message : String(cause),
          ...cause instanceof EventKitPermissionError && cause.status !== null ? { permissionStatus: cause.status } : {}
        };
      }
    },
    eventsInRange: async (fromMs, toMs, opts) => {
      try {
        const outcome = await eventKit.listOccurrences(
          { calendar: null, fromMs, toMs, maxRows: MAX_EVENT_ROWS, light: true },
          { shouldContinue: opts?.shouldContinue }
        );
        if (outcome.canceled) return { events: [], canceled: true };
        return {
          events: outcome.occurrences,
          total: outcome.total,
          truncated: outcome.truncated,
          contentTruncated: outcome.contentTruncated
        };
      } catch (cause) {
        return {
          events: [],
          error: cause instanceof Error ? cause.message : String(cause),
          ...cause instanceof EventKitPermissionError && cause.status !== null ? { permissionStatus: cause.status } : {}
        };
      }
    },
    eventDetail: (occurrenceKey, opts) => eventKit.occurrenceDetail(occurrenceKey, { shouldContinue: opts?.shouldContinue }),
    requestCalendarAccess: async () => {
      await eventKit.requestFullAccess();
    },
    openCalendarPrivacySettings: () => eventKit.openPrivacySettings(),
    createReminder: (input) => apple.createReminder(input),
    remindersInRange: async (fromMs, toMs) => {
      try {
        return await apple.listReminders({ fromMs, toMs, maxRows: 200 });
      } catch (cause) {
        return { reminders: [], total: 0, truncated: false, error: cause instanceof Error ? cause.message : String(cause) };
      }
    },
    updateReminder: (input) => apple.updateReminder(input),
    setReminderCompleted: (input) => apple.setReminderCompleted(input),
    deleteReminder: (input) => apple.deleteReminder(input)
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
    disposed = true;
    for (const dispose of disposers.splice(0)) dispose();
  };
}
export {
  activate as default
};
