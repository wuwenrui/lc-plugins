// src/newapi.ts
var SITE = "https://model.codingrui.work";
var CONSOLE_URL = `${SITE}/console/token`;
var RECHARGE_URL = `${SITE}/wallet`;
var BILLING_PATH = "/api/usage/token/billing";
var LEGACY_PATH = "/api/usage/token/";
var LOGS_PATH = "/api/log/token";
var QUOTA_PER_UNIT = 5e5;
var USD_TO_CNY = 7.3;
var BillingError = class extends Error {
  code;
  constructor(code) {
    super(code);
    this.name = "BillingError";
    this.code = code;
  }
};
function readReply(reply) {
  if (typeof reply?.status !== "number" || typeof reply?.body !== "string") return { ok: false, kind: "invalid-response" };
  if (reply.status === 404) return { ok: false, kind: "not-found" };
  if (reply.status === 401 || reply.status === 403) return { ok: false, kind: "unauthorized" };
  if (reply.status === 429) return { ok: false, kind: "rate-limited" };
  if (reply.status < 200 || reply.status >= 300) return { ok: false, kind: "unavailable" };
  try {
    return { ok: true, value: JSON.parse(reply.body) };
  } catch {
    return { ok: false, kind: "invalid-response" };
  }
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isSafeInt(value) {
  return typeof value === "number" && Number.isSafeInteger(value);
}
function isPrice(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
}
function isTimestamp(value) {
  return isSafeInt(value) && value > 0 && value <= 864e10 / 1e3;
}
function quotaToYuan(quota, quotaPerUnit = QUOTA_PER_UNIT, exchangeRate = USD_TO_CNY) {
  return quota / quotaPerUnit * exchangeRate;
}
function parseBillingBody(body) {
  const data = isRecord(body) ? body.data : void 0;
  if (!isRecord(body) || body.success !== true || !isRecord(data) || data.version !== 1) throw new BillingError("invalid-response");
  const display = data.display;
  const quotaPerUnit = data.quota_per_unit;
  const exchangeRate = isRecord(display) ? display.exchange_rate : void 0;
  if (!isPrice(quotaPerUnit) || quotaPerUnit <= 0 || !isRecord(display) || display.type !== "USD" && display.type !== "CNY" && display.type !== "TOKENS" || !isPrice(exchangeRate) || exchangeRate <= 0 || !isTimestamp(data.observed_at)) {
    throw new BillingError("invalid-response");
  }
  const account = data.account;
  const token = data.token;
  if (!isRecord(account) || !isSafeInt(account.remaining_quota)) throw new BillingError("invalid-response");
  if (!isRecord(token) || !isSafeInt(token.used_quota) || token.used_quota < 0 || typeof token.unlimited !== "boolean") {
    throw new BillingError("invalid-response");
  }
  let tokenQuota = null;
  if (!token.unlimited) {
    const remaining = token.remaining_quota;
    if (!isSafeInt(remaining)) throw new BillingError("invalid-response");
    tokenQuota = remaining;
  }
  return {
    source: "v1",
    displayType: display.type,
    balanceQuota: account.remaining_quota,
    tokenQuota,
    usedQuota: token.used_quota,
    quotaPerUnit,
    exchangeRate,
    balanceYuan: display.type === "TOKENS" ? account.remaining_quota : quotaToYuan(account.remaining_quota, quotaPerUnit, exchangeRate),
    usedYuan: display.type === "TOKENS" ? token.used_quota : quotaToYuan(token.used_quota, quotaPerUnit, exchangeRate),
    observedAt: data.observed_at * 1e3
  };
}
function parseLegacyBody(body) {
  const data = isRecord(body) ? body.data : void 0;
  if (!isRecord(body) || !(body.code === true || body.code === 200 || body.success === true) || !isRecord(data)) {
    throw new BillingError("invalid-response");
  }
  if (!isSafeInt(data.total_used) || data.total_used < 0 || typeof data.unlimited_quota !== "boolean") {
    throw new BillingError("invalid-response");
  }
  let available = null;
  if (!data.unlimited_quota) {
    const totalAvailable = data.total_available;
    if (!isSafeInt(totalAvailable)) throw new BillingError("invalid-response");
    available = totalAvailable;
  }
  return {
    source: "legacy",
    displayType: "CNY",
    balanceQuota: available,
    tokenQuota: available,
    usedQuota: data.total_used,
    quotaPerUnit: QUOTA_PER_UNIT,
    exchangeRate: USD_TO_CNY,
    balanceYuan: available === null ? null : quotaToYuan(available),
    usedYuan: quotaToYuan(data.total_used),
    observedAt: null
  };
}
async function fetchBillingSnapshot(transport) {
  try {
    const primary = readReply(await transport(BILLING_PATH));
    if (primary.ok) {
      try {
        return { ok: true, snapshot: parseBillingBody(primary.value) };
      } catch {
        return { ok: false, kind: "invalid-response" };
      }
    }
    if (primary.kind !== "not-found") return { ok: false, kind: primary.kind };
    const legacy = readReply(await transport(LEGACY_PATH));
    if (legacy.ok) {
      try {
        return { ok: true, snapshot: parseLegacyBody(legacy.value) };
      } catch {
        return { ok: false, kind: "invalid-response" };
      }
    }
    return { ok: false, kind: legacy.kind === "not-found" ? "unavailable" : legacy.kind };
  } catch {
    return { ok: false, kind: "unavailable" };
  }
}
var MAX_LOG_ROWS = 5e3;
var MAX_TEXT = 160;
function logRows(data) {
  if (Array.isArray(data)) return data;
  if (isRecord(data) && Array.isArray(data.items)) return data.items;
  throw new BillingError("invalid-response");
}
function text(value) {
  return typeof value === "string" ? value.slice(0, MAX_TEXT) : "";
}
function parseLogsBody(body) {
  if (!isRecord(body) || body.success !== true) throw new BillingError("invalid-response");
  const rows = logRows(body.data);
  if (rows.length > MAX_LOG_ROWS) throw new BillingError("invalid-response");
  return rows.filter((row) => isRecord(row) && row.type === 2).map((row) => {
    const settled = row;
    if (!isSafeInt(settled.quota) || settled.quota < 0 || !isTimestamp(settled.created_at)) {
      throw new BillingError("invalid-response");
    }
    const input = settled.prompt_tokens ?? 0;
    const output = settled.completion_tokens ?? 0;
    if (!isSafeInt(input) || input < 0 || !isSafeInt(output) || output < 0) throw new BillingError("invalid-response");
    return {
      id: text(String(settled.id ?? "")),
      at: settled.created_at * 1e3,
      model: text(settled.model_name),
      quota: settled.quota,
      input,
      output
    };
  });
}
async function fetchUsageRows(transport) {
  try {
    const reply = readReply(await transport(LOGS_PATH));
    if (!reply.ok) return { ok: false, kind: reply.kind };
    try {
      return { ok: true, rows: parseLogsBody(reply.value) };
    } catch {
      return { ok: false, kind: "invalid-response" };
    }
  } catch {
    return { ok: false, kind: "unavailable" };
  }
}

// src/usage.ts
var LOW_BALANCE_YUAN = 10;
var DEFAULT_DAYS = 7;
var MAX_DAYS = 31;
var UsageError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "UsageError";
  }
};
function formatYuan(yuan) {
  if (yuan === null || !Number.isFinite(yuan)) return "\u2014";
  const cents = Math.round(yuan * 100);
  if (cents === 0) return "\xA50";
  const negative = cents < 0;
  const abs = Math.abs(cents);
  let text2 = `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
  text2 = text2.replace(/0+$/, "").replace(/\.$/, "");
  return `${negative ? "-" : ""}\xA5${text2}`;
}
function formatUsd(usd) {
  if (!Number.isFinite(usd)) return "$--";
  return `$${usd.toFixed(2)}`;
}
function formatAmount(value, snapshot) {
  if (value === null) return "\u2014";
  if (snapshot.displayType === "TOKENS") return `${value.toLocaleString("zh-CN")} \u989D\u5EA6\u5355\u4F4D`;
  if (snapshot.displayType === "USD") return formatYuan(value).replace("\xA5", "$");
  return formatYuan(value);
}
function displayDivisor(snapshot) {
  return snapshot.displayType === "TOKENS" ? snapshot.exchangeRate : snapshot.quotaPerUnit;
}
function dateKey(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
function formatDateTime(ms) {
  const date = new Date(ms);
  const pad = (value) => String(value).padStart(2, "0");
  return `${dateKey(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
function formatShortDate(date) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  if (match === null) return date;
  return `${match[2]}-${match[3]}`;
}
function maskToken(token) {
  const clean = token.trim();
  if (clean.length <= 4) return "\u2022\u2022\u2022\u2022";
  return `\u2022\u2022\u2022\u2022${clean.slice(-4)}`;
}
function normalizeDays(value) {
  if (value === void 0 || value === null || value === "") return DEFAULT_DAYS;
  let candidate = value;
  if (typeof candidate === "string" && /^-?\d+$/.test(candidate.trim())) candidate = Number(candidate.trim());
  if (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate < 1 || candidate > MAX_DAYS) {
    throw new UsageError(`days \u9700\u4E3A 1\u2013${MAX_DAYS} \u7684\u6574\u6570\uFF08\u9ED8\u8BA4 ${DEFAULT_DAYS}\uFF09`);
  }
  return candidate;
}
function summarizeDaily(rows, now, days = DEFAULT_DAYS, quotaPerUnit = QUOTA_PER_UNIT, exchangeRate = USD_TO_CNY) {
  const count = normalizeDays(days);
  const buckets = /* @__PURE__ */ new Map();
  const first = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (count - 1));
  for (let index = 0; index < count; index++) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (count - 1 - index));
    const key = dateKey(day);
    buckets.set(key, { date: key, quota: 0, yuan: 0, calls: 0 });
  }
  const startMs = first.getTime();
  const endMs = now.getTime();
  for (const row of rows) {
    if (row.at < startMs || row.at > endMs) continue;
    const bucket = buckets.get(dateKey(new Date(row.at)));
    if (!bucket) continue;
    bucket.quota += row.quota;
    bucket.calls += 1;
  }
  const list = [...buckets.values()].sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  for (const day of list) day.yuan = quotaToYuan(day.quota, quotaPerUnit, exchangeRate);
  return list;
}
function totalUsage(daily) {
  return daily.reduce((sum, day) => ({ yuan: sum.yuan + day.yuan, calls: sum.calls + day.calls }), { yuan: 0, calls: 0 });
}
function summarizeMonth(rows, now, quotaPerUnit = QUOTA_PER_UNIT, exchangeRate = USD_TO_CNY) {
  const startMs = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const endMs = now.getTime();
  let quota = 0;
  let calls = 0;
  for (const row of rows) {
    if (row.at < startMs || row.at > endMs) continue;
    quota += row.quota;
    calls += 1;
  }
  return { yuan: quotaToYuan(quota, quotaPerUnit, exchangeRate), calls };
}
var MIN_BAR_PERCENT = 6;
function barPercent(value, max) {
  if (!Number.isFinite(value) || value <= 0 || !Number.isFinite(max) || max <= 0) return 0;
  return Math.min(100, Math.max(MIN_BAR_PERCENT, Math.round(value / max * 100)));
}
function balanceUsdNote(snapshot) {
  if (snapshot.displayType !== "CNY") return "";
  const usd = snapshot.balanceQuota === null ? null : snapshot.balanceQuota / snapshot.quotaPerUnit;
  if (usd === null || snapshot.balanceYuan === null) return "";
  return usd < snapshot.balanceYuan * 0.9 ? `\u7EA6 ${formatUsd(usd)}` : "";
}
function renderStatusText(snapshot, daily, refreshedAt) {
  const total = totalUsage(daily);
  const lines = [];
  const label = snapshot.source === "v1" ? "\u6A21\u578B\u7AD9\u4F59\u989D" : "\u4EE4\u724C\u989D\u5EA6\uFF08\u975E\u8D26\u6237\u4F59\u989D\uFF0C\u6309\u53C2\u8003\u6C47\u7387\u4F30\u7B97\uFF09";
  if (snapshot.balanceYuan === null) {
    lines.push("\u8D26\u6237\u4F59\u989D\u672A\u63D0\u4F9B\uFF1B\u8BE5\u4EE4\u724C\u4E3A\u4E0D\u9650\u989D\u4EE4\u724C\u3002");
  } else {
    const note = balanceUsdNote(snapshot);
    lines.push(
      note === "" ? `${label}\uFF1A${formatAmount(snapshot.balanceYuan, snapshot)}` : `${label}\uFF1A${formatAmount(snapshot.balanceYuan, snapshot)}\uFF08${note}\uFF09`
    );
  }
  lines.push(`\u8FD1 ${daily.length} \u5929\u6D88\u8D39\uFF1A${formatAmount(total.yuan, snapshot)}\uFF0C\u5171 ${total.calls} \u6B21\u8C03\u7528`);
  lines.push(`\u4EE4\u724C\u7D2F\u8BA1\u5DF2\u7528\uFF1A${formatAmount(snapshot.usedYuan, snapshot)}`);
  lines.push(`\u66F4\u65B0\u4E8E ${formatDateTime(refreshedAt)}`);
  if (snapshot.source === "v1" && snapshot.displayType === "CNY" && snapshot.balanceYuan !== null && snapshot.balanceYuan < LOW_BALANCE_YUAN) {
    lines.push(`\u63D0\u793A\uFF1A\u4F59\u989D\u5DF2\u4F4E\u4E8E ${formatYuan(LOW_BALANCE_YUAN)}\uFF0C\u8BF7\u5230\u6A21\u578B\u7AD9\u63A7\u5236\u53F0\u53CA\u65F6\u5145\u503C\u3002`);
  }
  return lines.join("\n");
}
function renderUsageText(daily, snapshot) {
  const total = totalUsage(daily);
  const format = (value) => snapshot ? formatAmount(value, snapshot) : formatYuan(value);
  const unit = snapshot?.displayType === "USD" ? "\u7F8E\u5143" : snapshot?.displayType === "TOKENS" ? "\u989D\u5EA6\u5355\u4F4D" : "\u4EBA\u6C11\u5E01";
  const lines = [`\u8FD1 ${daily.length} \u5929\u9010\u65E5\u6D88\u8D39\uFF08\u6A21\u578B\u7AD9\uFF0C${unit}\uFF09\uFF1A`];
  for (const day of daily) {
    lines.push(day.calls > 0 ? `- ${day.date}\uFF1A${format(day.yuan)}\uFF08${day.calls} \u6B21\u8C03\u7528\uFF09` : `- ${day.date}\uFF1A\u65E0\u6D88\u8D39`);
  }
  lines.push(`\u5408\u8BA1\uFF1A${format(total.yuan)}\uFF08${total.calls} \u6B21\u8C03\u7528\uFF09`);
  return lines.join("\n");
}

// src/store.ts
var CACHE_TTL_MS = 6e4;
var NotConfiguredError = class extends Error {
  constructor() {
    super("\u8BF7\u5148\u5728 \u8BBE\u7F6E\u2192\u63D2\u4EF6\u2192\u6A21\u578B\u7AD9\u8BA1\u8D39 \u586B\u5199 API \u4EE4\u724C\uFF08\u5728\u6A21\u578B\u7AD9\u63A7\u5236\u53F0\u521B\u5EFA\u540E\u7C98\u8D34\uFF09\u3002");
  }
};
function kindMessage(kind) {
  if (kind === "unauthorized") return "API \u4EE4\u724C\u65E0\u6548\u6216\u5DF2\u8FC7\u671F\uFF1A\u8BF7\u5728 \u8BBE\u7F6E\u2192\u63D2\u4EF6\u2192\u6A21\u578B\u7AD9\u8BA1\u8D39 \u91CD\u65B0\u586B\u5199\u3002";
  if (kind === "rate-limited") return "\u6A21\u578B\u7AD9\u8BF7\u6C42\u8FC7\u4E8E\u9891\u7E41\uFF0C\u8BF7\u7A0D\u540E\u518D\u8BD5\u3002";
  return "\u6682\u65F6\u65E0\u6CD5\u8FDE\u63A5\u6A21\u578B\u7AD9\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002";
}
function createBillingStore(ctx) {
  let state = { status: "loading", tokenMask: "", balance: null, report: null, error: "" };
  let token;
  let generation = 0;
  let disposed = false;
  let balanceFlight = null;
  let reportFlight = null;
  let reportAt = 0;
  let retryAt = 0;
  let writes = Promise.resolve();
  let poll;
  let settle;
  let offEvent;
  const listeners = /* @__PURE__ */ new Set();
  const publish = (patch) => {
    state = { ...state, ...patch };
    for (const cb of listeners) cb();
  };
  const assertCurrent = (g) => {
    if (disposed) throw new Error("\u6A21\u578B\u7AD9\u67E5\u8BE2\u5DF2\u505C\u6B62\u3002");
    if (g !== generation) throw new Error("\u8D26\u6237\u5DF2\u53D8\u66F4\uFF0C\u8BF7\u91CD\u65B0\u67E5\u8BE2\u3002");
  };
  function reset(next) {
    generation++;
    token = next;
    balanceFlight = null;
    reportFlight = null;
    reportAt = retryAt = 0;
    if (settle) clearTimeout(settle);
    settle = void 0;
    publish({ status: next ? "loading" : "unconfigured", tokenMask: next ? maskToken(next) : "", balance: null, report: null, error: "" });
  }
  async function loadToken() {
    await writes;
    const g = generation;
    assertCurrent(g);
    let raw;
    try {
      raw = await ctx.storage.get("api-token");
    } catch {
      assertCurrent(g);
      publish({ status: "error", balance: null, report: null, error: "\u65E0\u6CD5\u8BFB\u53D6\u672C\u673A\u4EE4\u724C\uFF0C\u8BF7\u91CD\u65B0\u6253\u5F00\u63D2\u4EF6\u8BBE\u7F6E\u3002" });
      throw new Error(state.error);
    }
    assertCurrent(g);
    const next = typeof raw === "string" ? raw.trim() : "";
    if (token === void 0) {
      token = next;
      publish({ status: next ? "loading" : "unconfigured", tokenMask: next ? maskToken(next) : "" });
    } else if (token !== next) reset(next);
    return next;
  }
  function transport(secret) {
    return async (path) => {
      const reply = await ctx.bridge.invoke("plugin_http_request", {
        method: "GET",
        url: `${SITE}${path}`,
        headers: { Authorization: `Bearer ${secret}`, accept: "application/json" }
      });
      return reply;
    };
  }
  async function refreshBalance(force) {
    const secret = await loadToken();
    if (!secret) throw new NotConfiguredError();
    if (balanceFlight) return balanceFlight;
    if (Date.now() < retryAt) throw new Error(state.error);
    if (!force && state.balance && Date.now() - state.balance.at < CACHE_TTL_MS) return state.balance;
    const g = generation;
    publish({ status: "loading", error: "" });
    const task = (async () => {
      const result = await fetchBillingSnapshot(transport(secret));
      assertCurrent(g);
      if (!result.ok) {
        const error = kindMessage(result.kind);
        retryAt = Date.now() + CACHE_TTL_MS;
        publish({ status: "error", error, balance: null, report: null });
        throw new Error(error);
      }
      const balance = { at: Date.now(), billing: result.snapshot };
      const previous = state.report;
      const report = previous ? {
        ...previous,
        ...balance,
        daily: summarizeDaily(previous.rows, new Date(balance.at), DEFAULT_DAYS, displayDivisor(balance.billing), balance.billing.exchangeRate)
      } : null;
      publish({ status: "ready", balance, error: "", report });
      return balance;
    })();
    balanceFlight = task;
    try {
      return await task;
    } finally {
      if (g === generation) balanceFlight = null;
    }
  }
  async function refresh(force) {
    const balance = await refreshBalance(force);
    if (reportFlight) return reportFlight;
    if (!force && state.report && Date.now() - reportAt < CACHE_TTL_MS) return state.report;
    const g = generation;
    const secret = token;
    const task = (async () => {
      const logs = await fetchUsageRows(transport(secret));
      assertCurrent(g);
      if (!state.balance || state.status === "error") throw new Error(state.error || "\u4F59\u989D\u9700\u8981\u91CD\u65B0\u67E5\u8BE2\u3002");
      const current = state.balance;
      const rows = logs.ok ? logs.rows : [];
      const report = {
        ...current,
        rows,
        daily: summarizeDaily(rows, new Date(current.at), DEFAULT_DAYS, displayDivisor(current.billing), current.billing.exchangeRate),
        warning: logs.ok ? "" : "\u6D88\u8D39\u8BB0\u5F55\u6682\u65F6\u65E0\u6CD5\u83B7\u53D6\uFF0C\u4EC5\u663E\u793A\u4F59\u989D\u3002"
      };
      reportAt = balance.at;
      publish({ report });
      return report;
    })();
    reportFlight = task;
    try {
      return await task;
    } finally {
      if (g === generation) reportFlight = null;
    }
  }
  function changeCredential(next) {
    reset();
    const task = writes.then(async () => {
      if (disposed) throw new Error("\u6A21\u578B\u7AD9\u67E5\u8BE2\u5DF2\u505C\u6B62\u3002");
      try {
        if (next) await ctx.storage.set("api-token", next);
        else await ctx.storage.delete("api-token");
      } catch {
        throw new Error("\u65E0\u6CD5\u4FDD\u5B58\u672C\u673A\u4EE4\u724C\uFF0C\u8BF7\u91CD\u65B0\u6253\u5F00\u63D2\u4EF6\u8BBE\u7F6E\u540E\u91CD\u8BD5\u3002");
      }
      if (disposed) throw new Error("\u6A21\u578B\u7AD9\u67E5\u8BE2\u5DF2\u505C\u6B62\u3002");
      reset(next);
    });
    writes = task.catch(() => void 0);
    return task;
  }
  const backgroundRefresh = () => {
    void refreshBalance(true).catch(() => void 0);
  };
  function stop() {
    if (poll) clearInterval(poll);
    if (settle) clearTimeout(settle);
    poll = settle = void 0;
    offEvent?.();
    offEvent = void 0;
  }
  function subscribe(cb) {
    listeners.add(cb);
    if (listeners.size === 1 && !disposed) {
      poll = setInterval(backgroundRefresh, CACHE_TTL_MS);
      offEvent = ctx.events.on("usage://done", () => {
        backgroundRefresh();
        if (settle) clearTimeout(settle);
        settle = setTimeout(() => {
          settle = void 0;
          backgroundRefresh();
        }, 6e3);
      });
    }
    return () => {
      listeners.delete(cb);
      if (!listeners.size) stop();
    };
  }
  return {
    getState: () => state,
    subscribe,
    loadToken,
    refreshBalance,
    refresh,
    saveToken: (next) => changeCredential(next.trim()),
    clearToken: () => changeCredential(""),
    dispose() {
      disposed = true;
      generation++;
      stop();
      listeners.clear();
    }
  };
}

// src/pill.ts
function pillText(state) {
  if (state.status === "loading") return "\u67E5\u8BE2\u4E2D\u2026";
  if (state.status === "unconfigured") return "\u672A\u914D\u7F6E";
  if (state.status === "error" || !state.balance) return "\u4F59\u989D\u4E0D\u53EF\u7528";
  const snapshot = state.balance.billing;
  if (snapshot.source === "legacy") return "\u8D26\u6237\u4F59\u989D\u672A\u63D0\u4F9B";
  return `\u4F59\u989D ${formatAmount(snapshot.balanceYuan, snapshot)}`;
}
function createStatusPill(ctx, store, openSettings2) {
  const { createElement: el, useState, useEffect } = ctx.react;
  return function BillingStatusPill() {
    const [state, setState] = useState(store.getState);
    useEffect(() => {
      const off = store.subscribe(() => setState(store.getState()));
      setState(store.getState());
      void store.refreshBalance(false).catch(() => void 0);
      return off;
    }, []);
    const snapshot = state.balance?.billing;
    const low = state.status === "ready" && snapshot?.source === "v1" && snapshot.displayType === "CNY" && snapshot.balanceYuan !== null && snapshot.balanceYuan < LOW_BALANCE_YUAN;
    const title = state.error || (state.balance ? `${snapshot?.source === "v1" ? "\u6A21\u578B\u7AD9\u8D26\u6237\u4F59\u989D" : "\u7AD9\u70B9\u672A\u63D0\u4F9B\u8D26\u6237\u4F59\u989D\uFF0C\u4EE4\u724C\u989D\u5EA6\u4E0D\u4EE3\u8868\u8D26\u6237\u4F59\u989D"} \xB7 \u66F4\u65B0\u4E8E ${formatDateTime(state.balance.at)} \xB7 \u6BCF\u5206\u949F\u53CA\u5BF9\u8BDD\u5B8C\u6210\u540E\u66F4\u65B0\uFF1B\u70B9\u51FB\u6253\u5F00\u8BBE\u7F6E` : "\u6A21\u578B\u7AD9\u8D26\u6237\u4F59\u989D\uFF1B\u70B9\u51FB\u6253\u5F00\u8BBE\u7F6E");
    return el("button", {
      type: "button",
      title,
      "aria-label": `${pillText(state)}\uFF1B${title}`,
      className: low ? "rounded-full bg-background-tertiary-error text-caption-2-medium text-text-error-primary" : "rounded-full bg-badge-neutral-background text-caption-2-medium text-text-secondary transition-colors hover:bg-background-secondary-hover",
      style: { padding: "2px 10px", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" },
      onClick: openSettings2
    }, pillText(state));
  };
}

// src/panel.ts
var ICONS = {
  refresh: ["M3 12a9 9 0 0 1 15-6.7L21 8", "M21 3v5h-5", "M21 12a9 9 0 0 1-15 6.7L3 16", "M3 21v-5h5"],
  chart: ["M3 3v18h18", "M18 17V9", "M13 17V5", "M8 17v-3"],
  key: [
    "M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z",
    "M16.5 7.5h.01"
  ]
};
var BORDER_STYLE = { borderWidth: "1px", borderStyle: "solid" };
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
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}
function renderDailyChart(el, daily, snapshot) {
  if (daily.length === 0) return null;
  const format = (value) => snapshot ? formatAmount(value, snapshot) : formatYuan(value);
  const total = totalUsage(daily);
  const max = Math.max(...daily.map((day) => day.yuan), 0);
  const todayKey = daily[daily.length - 1].date;
  return el(
    "div",
    { className: "flex flex-col gap-2" },
    el(
      "div",
      { className: "flex items-center justify-between" },
      el("span", { className: "text-caption-1-medium text-text-tertiary" }, `\u8FD1 ${daily.length} \u5929\u6BCF\u65E5\u6D88\u8D39`),
      el(
        "span",
        { className: "text-caption-2-medium text-text-tertiary" },
        `\u5408\u8BA1 ${format(total.yuan)} \xB7 ${total.calls} \u6B21`
      )
    ),
    el(
      "div",
      { className: "flex items-end gap-1.5", style: { height: "96px" } },
      ...daily.map((day) => {
        const percent = barPercent(day.yuan, max);
        const isToday = day.date === todayKey;
        return el(
          "div",
          {
            key: day.date,
            title: `${day.date}\uFF1A${day.calls > 0 ? `${format(day.yuan)}\uFF08${day.calls} \u6B21\u8C03\u7528\uFF09` : "\u65E0\u6D88\u8D39"}`,
            className: "flex h-full flex-1 flex-col",
            style: { justifyContent: "flex-end" }
          },
          el("div", {
            className: percent === 0 ? "rounded-md bg-background-tertiary-default" : isToday ? "rounded-md bg-blue-600" : "rounded-md bg-blue-600 opacity-60",
            style: { width: "100%", height: percent === 0 ? "2px" : `${percent}%` }
          })
        );
      })
    ),
    el(
      "div",
      { className: "flex items-center justify-between" },
      el("span", { className: "text-caption-2-medium text-text-tertiary" }, formatShortDate(daily[0].date)),
      el(
        "span",
        { className: "text-caption-2-medium text-text-tertiary" },
        `\u4ECA\u5929 \xB7 ${formatShortDate(todayKey)}`
      )
    )
  );
}
function metricCard(el, label, value, sub) {
  return el(
    "div",
    { className: "flex min-w-0 flex-1 flex-col gap-1.5 rounded-xl border-separator-border p-2.5", style: BORDER_STYLE },
    el("span", { className: "text-caption-2-medium text-text-tertiary" }, label),
    el(
      "span",
      { className: "text-body-2-medium text-text-primary", style: { fontVariantNumeric: "tabular-nums" } },
      value
    ),
    el("span", { className: "text-caption-2-medium text-text-tertiary" }, sub)
  );
}
function createBillingPanelTab(ctx, deps) {
  const { createElement: el, useState, useEffect } = ctx.react;
  return function BillingPanelTab() {
    const [ready, setReady] = useState(false);
    const [tokenMask, setTokenMask] = useState("");
    const [data, setData] = useState(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    async function load(force) {
      setBusy(true);
      setError("");
      try {
        setData(await deps.refresh(force));
      } catch (cause) {
        setData(null);
        setError(messageOf(cause));
      } finally {
        setBusy(false);
      }
    }
    useEffect(() => {
      let alive = true;
      const sync = () => {
        const state = deps.getState();
        setTokenMask(state.tokenMask);
        setData(state.status === "ready" ? state.report : null);
        setError(state.error);
      };
      const off = deps.subscribe(sync);
      sync();
      void (async () => {
        try {
          const token = await deps.loadToken();
          if (!alive) return;
          setTokenMask(token ? maskToken(token) : "");
          if (token) await deps.refresh(false);
        } catch (cause) {
          if (alive) setError(messageOf(cause));
        } finally {
          if (alive) setReady(true);
        }
      })();
      return () => {
        alive = false;
        off();
      };
    }, []);
    if (!ready) {
      return el(
        "div",
        { className: "flex h-full items-center px-3 text-center", style: { justifyContent: "center" } },
        el("span", { className: "text-caption-1-medium text-text-tertiary" }, "\u6B63\u5728\u8BFB\u53D6\u6A21\u578B\u7AD9\u8D26\u6237\u2026")
      );
    }
    if (tokenMask === "") {
      return el(
        "div",
        {
          className: "flex h-full flex-col items-center gap-2 text-center",
          style: { justifyContent: "center", padding: "0 32px" }
        },
        el(
          "div",
          {
            className: "flex h-9 w-9 items-center rounded-full bg-badge-neutral-background text-foreground-icon-secondary",
            style: { justifyContent: "center" }
          },
          icon(el, "chart", { size: 18 })
        ),
        el("div", { className: "text-title-3-semibold text-text-primary" }, "\u8FD8\u6CA1\u6709\u914D\u7F6E\u6A21\u578B\u7AD9\u4EE4\u724C"),
        el(
          "p",
          { className: "text-caption-1-regular text-text-tertiary" },
          "\u5728\u6A21\u578B\u7AD9\u63A7\u5236\u53F0\u521B\u5EFA\u4EE4\u724C\u5E76\u7C98\u8D34\u5230\u8BBE\u7F6E\u9875\uFF0C\u5373\u53EF\u5728\u8FD9\u91CC\u67E5\u770B\u4F59\u989D\u4E0E\u8FD1 7 \u5929\u7528\u91CF\u3002"
        ),
        el(
          "button",
          {
            className: "mt-1 flex items-center gap-1.5 rounded-full bg-blue-600 px-3 py-2 text-caption-1-medium text-white shadow-sm transition-colors hover:bg-blue-700",
            onClick: () => deps.openSettings()
          },
          icon(el, "key", { size: 14 }),
          "\u53BB\u8BBE\u7F6E\u914D\u7F6E\u4EE4\u724C"
        ),
        error === "" ? null : el("p", { className: "text-caption-2-medium text-text-error-primary" }, error)
      );
    }
    const snapshot = data === null ? null : data.billing;
    const formatYuan2 = (value) => snapshot ? formatAmount(value, snapshot) : "\u2014";
    const daily = data === null ? [] : data.daily;
    const total = totalUsage(daily);
    const today = daily.length > 0 ? daily[daily.length - 1] : null;
    const month = data === null ? null : summarizeMonth(data.rows, new Date(data.at), displayDivisor(data.billing), data.billing.exchangeRate);
    const tokenLeftYuan = snapshot === null || snapshot.tokenQuota === null ? null : quotaToYuan(snapshot.tokenQuota, displayDivisor(snapshot), snapshot.exchangeRate);
    const balance = snapshot === null ? null : snapshot.balanceYuan;
    const low = snapshot?.source === "v1" && snapshot.displayType === "CNY" && balance !== null && balance < LOW_BALANCE_YUAN;
    const note = snapshot === null ? "" : balanceUsdNote(snapshot);
    return el(
      "div",
      { className: "flex h-full min-h-0 flex-col" },
      // ———————— 标题行：用量 + 令牌/刷新时间 + 刷新圆钮 ————————
      el(
        "div",
        { className: "flex items-center gap-2 px-3 pb-1", style: { paddingTop: "14px" } },
        el(
          "div",
          { className: "min-w-0" },
          el("div", { className: "text-title-3-semibold text-text-primary" }, "\u7528\u91CF"),
          el(
            "div",
            { className: "truncate text-caption-2-medium text-text-tertiary" },
            data === null ? `\u4EE4\u724C ${tokenMask}` : `\u4EE4\u724C ${tokenMask} \xB7 \u66F4\u65B0\u4E8E ${formatDateTime(data.at)}`
          )
        ),
        el("div", { className: "flex-1" }),
        el(
          "button",
          {
            title: busy ? "\u6B63\u5728\u5237\u65B0\u2026" : "\u5237\u65B0",
            className: "flex h-9 w-9 items-center rounded-full text-foreground-icon-secondary transition-colors hover:bg-button-ghost-hover disabled:cursor-not-allowed disabled:opacity-50",
            style: { justifyContent: "center" },
            disabled: busy,
            onClick: () => {
              void load(true);
            }
          },
          icon(el, "refresh", { size: 15, style: busy ? { animation: "spin 1s linear infinite" } : void 0 })
        )
      ),
      // ———————— 内容：余额卡 / 柱状图 / 指标卡 ————————
      el(
        "div",
        { className: "min-h-0 flex-1 overflow-y-auto px-3 pt-2", style: { paddingBottom: "16px" } },
        el(
          "div",
          { className: "flex flex-col gap-2" },
          error === "" ? null : el(
            "div",
            { className: "rounded-lg bg-background-tertiary-error px-3 py-2 text-caption-1-regular text-text-error-primary" },
            `${error}\u53EF\u70B9\u53F3\u4E0A\u89D2\u5237\u65B0\u91CD\u8BD5\u3002`
          ),
          data !== null && data.warning !== "" ? el(
            "div",
            { className: "rounded-lg bg-background-secondary-default px-3 py-2 text-caption-1-regular text-text-primary" },
            data.warning
          ) : null,
          data === null ? null : el(
            "div",
            {
              className: "flex flex-col gap-1.5 rounded-xl border-separator-border bg-background-secondary-default p-2.5",
              style: BORDER_STYLE
            },
            el("span", { className: "text-caption-1-medium text-text-tertiary" }, snapshot?.source === "v1" ? "\u6A21\u578B\u7AD9\u4F59\u989D" : "\u4EE4\u724C\u989D\u5EA6\uFF08\u975E\u8D26\u6237\u4F59\u989D\uFF0C\u4F30\u7B97\uFF09"),
            el(
              "div",
              { className: "flex items-end justify-between gap-2" },
              el(
                "span",
                {
                  className: low ? "text-title-2-medium text-text-error-primary" : "text-title-2-medium text-text-primary",
                  style: { fontVariantNumeric: "tabular-nums" }
                },
                balance === null ? "\u4E0D\u9650\u989D" : formatYuan2(balance)
              ),
              low ? el("span", { className: "text-caption-1-medium text-text-error-primary" }, "\u4F59\u989D\u504F\u4F4E") : note === "" ? null : el("span", { className: "text-caption-1-regular text-text-tertiary" }, note)
            ),
            el(
              "span",
              { className: "text-caption-1-regular text-text-secondary" },
              tokenLeftYuan === null ? `\u4EE4\u724C\u7D2F\u8BA1\u5DF2\u7528 ${formatYuan2(data.billing.usedYuan)} \xB7 \u4EE4\u724C\u4E0D\u9650\u989D` : `\u4EE4\u724C\u7D2F\u8BA1\u5DF2\u7528 ${formatYuan2(data.billing.usedYuan)} \xB7 \u4EE4\u724C\u5269\u4F59 ${formatYuan2(tokenLeftYuan)}`
            )
          ),
          el(
            "button",
            {
              className: "mt-0.5 flex items-center gap-1 self-start rounded-full bg-blue-600 px-3 py-1.5 text-caption-1-medium text-white shadow-sm transition-colors hover:bg-blue-700",
              onClick: () => deps.openRechargePage(),
              title: "\u524D\u5F80\u6A21\u578B\u7AD9\u5145\u503C"
            },
            icon(el, "key", { size: 12 }),
            "\u5145\u503C"
          ),
          data === null ? null : el("div", { className: "rounded-xl border-separator-border p-2.5", style: BORDER_STYLE }, renderDailyChart(el, daily, data.billing)),
          data === null || month === null ? null : el(
            "div",
            { className: "flex flex-col gap-1.5" },
            el(
              "div",
              { className: "flex gap-1.5" },
              metricCard(el, "\u4ECA\u65E5\u6D88\u8D39", formatYuan2(today === null ? 0 : today.yuan), `${today === null ? 0 : today.calls} \u6B21\u8C03\u7528`),
              metricCard(el, "\u672C\u6708\u6D88\u8D39", formatYuan2(month.yuan), `${month.calls} \u6B21\u8C03\u7528`)
            ),
            el(
              "div",
              { className: "flex gap-1.5" },
              metricCard(el, "\u8FD1 7 \u5929\u6D88\u8D39", formatYuan2(total.yuan), `${total.calls} \u6B21\u8C03\u7528`),
              metricCard(
                el,
                "\u4EE4\u724C\u7D2F\u8BA1\u5DF2\u7528",
                formatYuan2(data.billing.usedYuan),
                tokenLeftYuan === null ? "\u4EE4\u724C\u4E0D\u9650\u989D" : `\u4EE4\u724C\u5269\u4F59 ${formatYuan2(tokenLeftYuan)}`
              )
            )
          ),
          el(
            "p",
            { className: "text-caption-2-medium text-text-tertiary" },
            "\u7EDF\u8BA1\u81EA\u6A21\u578B\u7AD9\u5DF2\u7ED3\u7B97\u7684\u6D88\u8D39\u8BB0\u5F55\uFF1B\u60AC\u505C\u67F1\u5B50\u53EF\u67E5\u770B\u5F53\u5929\u6D88\u8D39\u3002"
          )
        )
      )
    );
  };
}

// src/index.ts
var SETTINGS_KEY = "lawyer-billing";
function messageOf2(error) {
  return error instanceof Error ? error.message : String(error);
}
function activate(ctx) {
  const disposers = [];
  const store = createBillingStore(ctx);
  const { refresh } = store;
  function textResult(text2) {
    return { content: [{ type: "text", text: text2 }] };
  }
  function failure(error) {
    if (error instanceof NotConfiguredError) return textResult(messageOf2(error));
    return { content: [{ type: "text", text: `\u67E5\u8BE2\u5931\u8D25\uFF1A${messageOf2(error)}` }], isError: true };
  }
  function dailyFor(fresh, days) {
    if (days === DEFAULT_DAYS) return fresh.daily;
    return summarizeDaily(fresh.rows, new Date(fresh.at), days, displayDivisor(fresh.billing), fresh.billing.exchangeRate);
  }
  disposers.push(
    ctx.tools.register({
      name: "billing_status",
      description: "\u67E5\u8BE2\u6A21\u578B\u7AD9\u8D26\u6237\u4F59\u989D\u4E0E\u8FD1 7 \u5929\u6D88\u8D39\uFF08\u53EA\u8BFB\uFF0C\u65E0\u9700\u53C2\u6570\uFF09\u3002\u9002\u5408\u56DE\u7B54\u5F8B\u5E08\u201C\u6211\u8FD8\u5269\u591A\u5C11\u989D\u5EA6 / \u6700\u8FD1\u82B1\u4E86\u591A\u5C11\u94B1\u201D\uFF1B\u672A\u914D\u7F6E API \u4EE4\u724C\u65F6\u8FD4\u56DE\u914D\u7F6E\u5F15\u5BFC\u3002",
      inputSchema: { type: "object", additionalProperties: false, properties: {}, required: [] },
      async execute() {
        try {
          const fresh = await refresh(false);
          const text2 = renderStatusText(fresh.billing, fresh.daily, fresh.at);
          return textResult(fresh.warning ? `${text2}
\u6CE8\u610F\uFF1A${fresh.warning}` : text2);
        } catch (error) {
          return failure(error);
        }
      }
    })
  );
  disposers.push(
    ctx.tools.register({
      name: "billing_usage",
      description: "\u67E5\u8BE2\u6A21\u578B\u7AD9\u9010\u65E5\u6D88\u8D39\u660E\u7EC6\uFF08\u53EA\u8BFB\uFF09\u3002\u8FD4\u56DE\u6BCF\u5929\u7684\u4EBA\u6C11\u5E01\u6D88\u8D39\u91D1\u989D\u4E0E\u8C03\u7528\u6B21\u6570\uFF0C\u5408\u8BA1\u5728\u6700\u540E\u4E00\u884C\u3002",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          days: { type: "integer", minimum: 1, maximum: 31, description: "\u7EDF\u8BA1\u5929\u6570\uFF0C\u9ED8\u8BA4 7\uFF0C\u6700\u5927 31" }
        },
        required: []
      },
      async execute(args = {}) {
        try {
          const days = normalizeDays(args?.days);
          const fresh = await refresh(false);
          return textResult(renderUsageText(dailyFor(fresh, days), fresh.billing));
        } catch (error) {
          return failure(error);
        }
      }
    })
  );
  disposers.push(
    ctx.ui.registerSettingsSection({
      key: SETTINGS_KEY,
      label: () => "\u6A21\u578B\u7AD9\u8BA1\u8D39",
      component: createSettingsPanel(ctx, store)
    })
  );
  disposers.push(ctx.ui.registerStatusBarItem({
    key: "balance-header",
    zone: "chat-header",
    component: createStatusPill(ctx, store, () => openSettings(ctx))
  }));
  if (typeof ctx.ui.registerPanelTab === "function") {
    disposers.push(
      ctx.ui.registerPanelTab({
        key: SETTINGS_KEY,
        label: () => "\u7528\u91CF",
        component: createBillingPanelTab(ctx, {
          ...store,
          openSettings: () => openSettings(ctx),
          openRechargePage: () => {
            void ctx.bridge.invoke("plugin_open_url", { url: RECHARGE_URL }).catch(() => void 0);
          }
        })
      })
    );
  }
  return () => {
    store.dispose();
    for (const dispose of disposers.splice(0)) dispose();
  };
}
function openSettings(ctx) {
  try {
    ctx.ui.openSettings(SETTINGS_KEY);
  } catch {
    try {
      ctx.ui.openSettings();
    } catch {
    }
  }
}
var SETTINGS_INPUT_CLASS = "min-w-0 flex-1 rounded-md border-border-button-default bg-background-full px-3 py-2 text-body-2-regular text-text-primary disabled:cursor-not-allowed disabled:opacity-50";
var SETTINGS_BUTTON_PRIMARY = "rounded-full bg-blue-600 px-3 py-2 text-caption-1-medium text-white shadow-sm transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50";
var SETTINGS_BUTTON_PLAIN = "rounded-full border-border-button-default px-3 py-2 text-caption-1-medium text-text-secondary transition-colors hover:bg-button-ghost-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50";
var BORDER_STYLE2 = { borderWidth: "1px", borderStyle: "solid" };
function createSettingsPanel(ctx, deps) {
  const { createElement, useState, useEffect } = ctx.react;
  return function BillingSettingsPanel() {
    const [hasToken, setHasToken] = useState(false);
    const [tokenMask, setTokenMask] = useState("");
    const [draft, setDraft] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [data, setData] = useState(null);
    useEffect(() => {
      let alive = true;
      const sync = () => {
        const state = deps.getState();
        setData(state.status === "ready" ? state.report : null);
        setHasToken(Boolean(state.tokenMask));
        setTokenMask(state.tokenMask);
        setError(state.error);
      };
      const off = deps.subscribe(sync);
      sync();
      void deps.loadToken().then((token) => {
        if (!alive) return;
        setHasToken(Boolean(token));
        setTokenMask(token ? maskToken(token) : "");
        if (token) void deps.refresh(false).catch(() => void 0);
      }).catch(() => void 0);
      return () => {
        alive = false;
        off();
      };
    }, []);
    async function run(action) {
      setBusy(true);
      setError("");
      try {
        await action();
      } catch (cause) {
        setError(messageOf2(cause));
      } finally {
        setBusy(false);
      }
    }
    function save() {
      const token = draft.trim();
      if (busy || !token) return;
      void run(async () => {
        await deps.saveToken(token);
        setDraft("");
        setHasToken(true);
        setTokenMask(maskToken(token));
        setData(await deps.refresh(true));
      });
    }
    function clear() {
      if (busy || !hasToken) return;
      void run(async () => {
        await deps.clearToken();
        setHasToken(false);
        setTokenMask("");
        setData(null);
      });
    }
    function manualRefresh() {
      if (busy || !hasToken) return;
      void run(async () => {
        setData(await deps.refresh(true));
      });
    }
    const input = createElement("input", {
      type: "password",
      className: SETTINGS_INPUT_CLASS,
      style: BORDER_STYLE2,
      placeholder: hasToken ? "\u7C98\u8D34\u65B0\u4EE4\u724C\u4EE5\u66F4\u6362\uFF08sk-\u2026\uFF09" : "\u7C98\u8D34\u6A21\u578B\u7AD9 API \u4EE4\u724C\uFF08sk-\u2026\uFF09",
      value: draft,
      disabled: busy,
      autoComplete: "off",
      onChange: (event) => setDraft(event.target.value),
      onKeyDown: (event) => {
        if (event.key === "Enter") save();
      }
    });
    return createElement(
      "div",
      { className: "flex flex-col gap-3" },
      createElement(
        "section",
        { className: "flex flex-col gap-2 rounded-xl border-separator-border p-2.5", style: BORDER_STYLE2 },
        createElement(
          "div",
          { className: "flex items-center justify-between gap-2" },
          createElement("h3", { className: "text-title-3-semibold text-text-primary" }, "\u6A21\u578B\u7AD9\u8D26\u6237"),
          createElement(
            "button",
            {
              type: "button",
              className: SETTINGS_BUTTON_PLAIN,
              style: BORDER_STYLE2,
              disabled: busy || !hasToken,
              onClick: () => manualRefresh()
            },
            busy ? "\u67E5\u8BE2\u4E2D\u2026" : "\u5237\u65B0"
          )
        ),
        error !== "" ? createElement(
          "div",
          { className: "rounded-lg bg-background-tertiary-error px-3 py-2 text-caption-1-regular text-text-error-primary" },
          error
        ) : null,
        createElement(
          "p",
          { className: "text-caption-1-regular text-text-tertiary" },
          `\u53EA\u8BFB\u67E5\u8BE2 ${SITE.replace("https://", "")} \u7684\u4F59\u989D\u4E0E\u7528\u91CF\uFF0C\u4EE4\u724C\u4EC5\u4FDD\u5B58\u5728\u672C\u673A\u3002\u63A7\u5236\u53F0\u5730\u5740\uFF1A${CONSOLE_URL.replace("https://", "")}`
        ),
        hasToken ? createElement(
          "div",
          { className: "flex items-center gap-2" },
          createElement("span", { className: "text-caption-1-medium text-text-secondary" }, `\u5DF2\u914D\u7F6E\u4EE4\u724C ${tokenMask}`),
          createElement(
            "button",
            {
              type: "button",
              className: "rounded-full border-border-button-default px-2.5 py-2 text-caption-2-medium text-text-secondary transition-colors hover:bg-button-ghost-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50",
              style: BORDER_STYLE2,
              disabled: busy,
              onClick: () => clear()
            },
            "\u89E3\u9664\u7ED1\u5B9A"
          )
        ) : null,
        createElement(
          "div",
          { className: "flex gap-2" },
          input,
          createElement(
            "button",
            {
              type: "button",
              className: SETTINGS_BUTTON_PRIMARY,
              disabled: busy || !draft.trim(),
              onClick: () => save()
            },
            hasToken ? "\u66F4\u6362\u4EE4\u724C" : "\u4FDD\u5B58\u5E76\u67E5\u8BE2"
          )
        ),
        !hasToken ? createElement(
          "p",
          { className: "text-body-2-regular text-text-secondary" },
          "\u8FD8\u672A\u914D\u7F6E\u4EE4\u724C\uFF1A\u5728\u6A21\u578B\u7AD9\u63A7\u5236\u53F0\u521B\u5EFA\u4EE4\u724C\u540E\u7C98\u8D34\u5230\u4E0A\u65B9\uFF0C\u5373\u53EF\u663E\u793A\u4F59\u989D\u4E0E\u8FD1 7 \u5929\u6D88\u8D39\u3002"
        ) : null
      ),
      data && hasToken ? createStatsCard(createElement, data) : null
    );
  };
}
function createStatsCard(createElement, data) {
  const total = totalUsage(data.daily);
  const snapshot = data.billing;
  const formatYuan2 = (value) => formatAmount(value, snapshot);
  const balance = snapshot.balanceYuan;
  const balanceLow = snapshot.source === "v1" && snapshot.displayType === "CNY" && balance !== null && balance < LOW_BALANCE_YUAN;
  const note = balanceUsdNote(snapshot);
  const tokenLeftYuan = snapshot.tokenQuota === null ? null : quotaToYuan(snapshot.tokenQuota, displayDivisor(snapshot), snapshot.exchangeRate);
  return createElement(
    "section",
    { className: "flex flex-col gap-3 rounded-xl border-separator-border p-2.5", style: BORDER_STYLE2 },
    createElement(
      "div",
      { className: "flex items-end justify-between gap-3" },
      createElement(
        "div",
        { className: "flex flex-col gap-1.5" },
        createElement("span", { className: "text-caption-1-medium text-text-tertiary" }, snapshot.source === "v1" ? "\u5F53\u524D\u8D26\u6237\u4F59\u989D" : "\u4EE4\u724C\u989D\u5EA6\uFF08\u975E\u8D26\u6237\u4F59\u989D\uFF0C\u4F30\u7B97\uFF09"),
        createElement(
          "span",
          {
            className: balanceLow ? "text-title-2-medium text-text-error-primary" : "text-title-2-medium text-text-primary",
            style: { fontVariantNumeric: "tabular-nums" }
          },
          balance === null ? "\u4E0D\u9650\u989D\u4EE4\u724C" : formatYuan2(balance)
        ),
        note === "" && !balanceLow ? null : createElement(
          "span",
          {
            className: balanceLow ? "text-caption-1-medium text-text-error-primary" : "text-caption-1-regular text-text-tertiary"
          },
          balanceLow ? "\u4F59\u989D\u504F\u4F4E\uFF0C\u8BF7\u53CA\u65F6\u5145\u503C" : note
        )
      ),
      createElement(
        "div",
        { className: "flex flex-col items-end gap-1.5" },
        createElement("span", { className: "text-caption-1-medium text-text-tertiary" }, "\u8FD1 7 \u5929\u6D88\u8D39"),
        createElement(
          "span",
          { className: "text-body-2-medium text-text-primary", style: { fontVariantNumeric: "tabular-nums" } },
          formatYuan2(total.yuan)
        ),
        createElement("span", { className: "text-caption-2-medium text-text-tertiary" }, `\u5171 ${total.calls} \u6B21\u8C03\u7528`)
      )
    ),
    createElement(
      "span",
      { className: "text-caption-1-regular text-text-secondary" },
      tokenLeftYuan === null ? `\u4EE4\u724C\u7D2F\u8BA1\u5DF2\u7528 ${formatYuan2(snapshot.usedYuan)} \xB7 \u4EE4\u724C\u4E0D\u9650\u989D` : `\u4EE4\u724C\u7D2F\u8BA1\u5DF2\u7528 ${formatYuan2(snapshot.usedYuan)} \xB7 \u4EE4\u724C\u5269\u4F59 ${formatYuan2(tokenLeftYuan)}`
    ),
    data.warning !== "" ? createElement(
      "div",
      { className: "rounded-lg bg-background-secondary-default px-3 py-2 text-caption-1-regular text-text-primary" },
      data.warning
    ) : null,
    renderDailyChart(createElement, data.daily, snapshot),
    createElement(
      "p",
      { className: "text-caption-2-medium text-text-tertiary" },
      "\u6570\u636E\u6309\u5DF2\u7ED3\u7B97\u6D88\u8D39\u8BB0\u5F55\u7EDF\u8BA1\uFF1B\u60AC\u505C\u67F1\u5B50\u53EF\u67E5\u770B\u5F53\u5929\u6D88\u8D39\u3002"
    )
  );
}
export {
  activate as default
};
