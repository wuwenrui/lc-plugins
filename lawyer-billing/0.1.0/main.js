// src/newapi.ts
var SITE = "https://model.codingrui.work";
var CONSOLE_URL = `${SITE}/console/token`;
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
    balanceQuota: account.remaining_quota,
    tokenQuota,
    usedQuota: token.used_quota,
    quotaPerUnit,
    exchangeRate,
    balanceYuan: quotaToYuan(account.remaining_quota, quotaPerUnit, exchangeRate),
    usedYuan: quotaToYuan(token.used_quota, quotaPerUnit, exchangeRate),
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
function dateKey(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
function formatDateTime(ms) {
  const date = new Date(ms);
  const pad = (value) => String(value).padStart(2, "0");
  return `${dateKey(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
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
function renderStatusText(snapshot, daily, refreshedAt) {
  const total = totalUsage(daily);
  const lines = [];
  if (snapshot.balanceYuan === null) {
    lines.push("\u6A21\u578B\u7AD9\u4F59\u989D\uFF1A\u8BE5\u4EE4\u724C\u4E3A\u4E0D\u9650\u989D\u4EE4\u724C\uFF0C\u65E0\u6CD5\u663E\u793A\u4F59\u989D\u3002");
  } else {
    const usd = snapshot.balanceQuota === null ? null : snapshot.balanceQuota / snapshot.quotaPerUnit;
    const showUsd = usd !== null && snapshot.balanceYuan !== null && usd < snapshot.balanceYuan * 0.9;
    lines.push(
      showUsd ? `\u6A21\u578B\u7AD9\u4F59\u989D\uFF1A${formatYuan(snapshot.balanceYuan)}\uFF08\u7EA6 ${formatUsd(usd)}\uFF09` : `\u6A21\u578B\u7AD9\u4F59\u989D\uFF1A${formatYuan(snapshot.balanceYuan)}`
    );
  }
  lines.push(`\u8FD1 ${daily.length} \u5929\u6D88\u8D39\uFF1A${formatYuan(total.yuan)}\uFF0C\u5171 ${total.calls} \u6B21\u8C03\u7528`);
  lines.push(`\u4EE4\u724C\u7D2F\u8BA1\u5DF2\u7528\uFF1A${formatYuan(snapshot.usedYuan)}`);
  lines.push(`\u66F4\u65B0\u4E8E ${formatDateTime(refreshedAt)}`);
  if (snapshot.balanceYuan !== null && snapshot.balanceYuan < LOW_BALANCE_YUAN) {
    lines.push(`\u63D0\u793A\uFF1A\u4F59\u989D\u5DF2\u4F4E\u4E8E ${formatYuan(LOW_BALANCE_YUAN)}\uFF0C\u8BF7\u5230\u6A21\u578B\u7AD9\u63A7\u5236\u53F0\u53CA\u65F6\u5145\u503C\u3002`);
  }
  return lines.join("\n");
}
function renderUsageText(daily) {
  const total = totalUsage(daily);
  const lines = [`\u8FD1 ${daily.length} \u5929\u9010\u65E5\u6D88\u8D39\uFF08\u6A21\u578B\u7AD9\uFF0C\u4EBA\u6C11\u5E01\uFF09\uFF1A`];
  for (const day of daily) {
    lines.push(day.calls > 0 ? `- ${day.date}\uFF1A${formatYuan(day.yuan)}\uFF08${day.calls} \u6B21\u8C03\u7528\uFF09` : `- ${day.date}\uFF1A\u65E0\u6D88\u8D39`);
  }
  lines.push(`\u5408\u8BA1\uFF1A${formatYuan(total.yuan)}\uFF08${total.calls} \u6B21\u8C03\u7528\uFF09`);
  return lines.join("\n");
}

// src/index.ts
var TOKEN_KEY = "api-token";
var SETTINGS_KEY = "lawyer-billing";
var CACHE_TTL_MS = 6e4;
var NOT_CONFIGURED_MESSAGE = "\u8BF7\u5148\u5728 \u8BBE\u7F6E\u2192\u63D2\u4EF6\u2192\u6A21\u578B\u7AD9\u8BA1\u8D39 \u586B\u5199 API \u4EE4\u724C\uFF08\u5728\u6A21\u578B\u7AD9\u63A7\u5236\u53F0\u521B\u5EFA\u540E\u7C98\u8D34\uFF09\u3002";
var NotConfiguredError = class extends Error {
  constructor() {
    super(NOT_CONFIGURED_MESSAGE);
    this.name = "NotConfiguredError";
  }
};
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}
function kindMessage(kind) {
  if (kind === "unauthorized") return "API \u4EE4\u724C\u65E0\u6548\u6216\u5DF2\u8FC7\u671F\uFF1A\u8BF7\u5728 \u8BBE\u7F6E\u2192\u63D2\u4EF6\u2192\u6A21\u578B\u7AD9\u8BA1\u8D39 \u91CD\u65B0\u586B\u5199\u3002";
  if (kind === "rate-limited") return "\u6A21\u578B\u7AD9\u8BF7\u6C42\u8FC7\u4E8E\u9891\u7E41\uFF0C\u8BF7\u7A0D\u540E\u518D\u8BD5\u3002";
  return "\u6682\u65F6\u65E0\u6CD5\u8FDE\u63A5\u6A21\u578B\u7AD9\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002";
}
function activate(ctx) {
  const disposers = [];
  const listeners = /* @__PURE__ */ new Set();
  let cache = null;
  let inflight = null;
  function notify() {
    for (const listener of listeners) listener();
  }
  async function loadToken() {
    const raw = await ctx.storage.get(TOKEN_KEY);
    return typeof raw === "string" ? raw.trim() : "";
  }
  function makeTransport(token) {
    return async function transport(path) {
      const reply = await ctx.bridge.invoke("plugin_http_request", {
        method: "GET",
        url: `${SITE}${path}`,
        headers: { Authorization: `Bearer ${token}`, accept: "application/json" }
      });
      const status = typeof reply?.status === "number" ? reply.status : 0;
      const body = typeof reply?.body === "string" ? reply.body : JSON.stringify(reply?.body ?? null);
      return { status, body };
    };
  }
  async function build() {
    const token = await loadToken();
    if (!token) {
      cache = null;
      notify();
      throw new NotConfiguredError();
    }
    const transport = makeTransport(token);
    const billing = await fetchBillingSnapshot(transport);
    if (!billing.ok) throw new Error(kindMessage(billing.kind));
    const at = Date.now();
    const { snapshot } = billing;
    const logs = await fetchUsageRows(transport);
    if (!logs.ok) {
      return {
        at,
        billing: snapshot,
        rows: [],
        daily: summarizeDaily([], new Date(at), DEFAULT_DAYS, snapshot.quotaPerUnit, snapshot.exchangeRate),
        warning: "\u6D88\u8D39\u8BB0\u5F55\u6682\u65F6\u65E0\u6CD5\u83B7\u53D6\uFF0C\u4EC5\u663E\u793A\u4F59\u989D\u3002"
      };
    }
    return {
      at,
      billing: snapshot,
      rows: logs.rows,
      daily: summarizeDaily(logs.rows, new Date(at), DEFAULT_DAYS, snapshot.quotaPerUnit, snapshot.exchangeRate),
      warning: ""
    };
  }
  function invalidate() {
    cache = null;
    notify();
  }
  function textResult(text2) {
    return { content: [{ type: "text", text: text2 }] };
  }
  function failure(error) {
    if (error instanceof NotConfiguredError) return textResult(messageOf(error));
    return { content: [{ type: "text", text: `\u67E5\u8BE2\u5931\u8D25\uFF1A${messageOf(error)}` }], isError: true };
  }
  async function refresh(force) {
    if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) {
      const token = await loadToken();
      if (!token) {
        cache = null;
        notify();
        throw new NotConfiguredError();
      }
      return cache;
    }
    inflight ??= build().then(
      (fresh) => {
        cache = fresh;
        inflight = null;
        notify();
        return fresh;
      },
      (error) => {
        inflight = null;
        throw error;
      }
    );
    return inflight;
  }
  function dailyFor(fresh, days) {
    if (days === DEFAULT_DAYS) return fresh.daily;
    return summarizeDaily(fresh.rows, new Date(fresh.at), days, fresh.billing.quotaPerUnit, fresh.billing.exchangeRate);
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
          return textResult(renderUsageText(dailyFor(fresh, days)));
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
      component: createSettingsPanel(ctx, {
        loadToken,
        saveToken: (token) => ctx.storage.set(TOKEN_KEY, token),
        clearToken: () => ctx.storage.delete(TOKEN_KEY),
        refresh,
        invalidate
      })
    })
  );
  disposers.push(
    ctx.ui.registerStatusBarItem({
      key: SETTINGS_KEY,
      component: createStatusPill(ctx, { refresh, openSettings: () => openSettings(ctx) })
    })
  );
  return () => {
    for (const dispose of disposers.splice(0)) dispose();
    listeners.clear();
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
      const listener = () => {
        void deps.refresh(false).then((fresh) => {
          if (alive) setData(fresh);
        }).catch(() => {
          if (alive) setData(null);
        });
      };
      void deps.loadToken().then((token) => {
        if (!alive) return;
        setHasToken(Boolean(token));
        setTokenMask(token ? maskToken(token) : "");
        if (token) listener();
      }).catch(() => void 0);
      return () => {
        alive = false;
      };
    }, []);
    async function run(action) {
      setBusy(true);
      setError("");
      try {
        await action();
      } catch (cause) {
        setError(messageOf(cause));
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
        deps.invalidate();
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
      className: "flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500 disabled:opacity-50",
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
      { className: "flex flex-col gap-4 p-4" },
      createElement(
        "section",
        { className: "flex flex-col gap-3 rounded-lg border border-gray-200 p-4" },
        createElement(
          "div",
          { className: "flex items-center justify-between" },
          createElement("h3", { className: "text-sm font-semibold text-gray-800" }, "\u6A21\u578B\u7AD9\u8D26\u6237"),
          createElement(
            "button",
            {
              type: "button",
              className: "rounded-md border border-gray-300 px-3 py-1.5 text-xs text-gray-600 disabled:cursor-not-allowed disabled:opacity-50",
              disabled: busy || !hasToken,
              onClick: () => manualRefresh()
            },
            busy ? "\u67E5\u8BE2\u4E2D\u2026" : "\u5237\u65B0"
          )
        ),
        error ? createElement("div", { className: "rounded-md bg-red-50 px-3 py-2 text-sm text-red-600" }, error) : null,
        createElement(
          "p",
          { className: "text-xs text-gray-400" },
          `\u53EA\u8BFB\u67E5\u8BE2 ${SITE.replace("https://", "")} \u7684\u4F59\u989D\u4E0E\u7528\u91CF\uFF0C\u4EE4\u724C\u4EC5\u4FDD\u5B58\u5728\u672C\u673A\u3002\u63A7\u5236\u53F0\u5730\u5740\uFF1A${CONSOLE_URL.replace("https://", "")}`
        ),
        hasToken ? createElement("div", { className: "flex items-center gap-2" }, createElement("span", { className: "text-xs text-gray-500" }, `\u5DF2\u914D\u7F6E\u4EE4\u724C ${tokenMask}`), createElement("button", { type: "button", className: "rounded-md border border-gray-300 px-2 py-1 text-xs text-gray-500 disabled:opacity-50", disabled: busy, onClick: () => clear() }, "\u89E3\u9664\u7ED1\u5B9A")) : null,
        createElement("div", { className: "flex gap-2" }, input, createElement("button", { type: "button", className: "rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50", disabled: busy || !draft.trim(), onClick: () => save() }, hasToken ? "\u66F4\u6362\u4EE4\u724C" : "\u4FDD\u5B58\u5E76\u67E5\u8BE2")),
        !hasToken ? createElement(
          "p",
          { className: "text-sm text-gray-500" },
          "\u8FD8\u672A\u914D\u7F6E\u4EE4\u724C\uFF1A\u5728\u6A21\u578B\u7AD9\u63A7\u5236\u53F0\u521B\u5EFA\u4EE4\u724C\u540E\u7C98\u8D34\u5230\u4E0A\u65B9\uFF0C\u5373\u53EF\u663E\u793A\u4F59\u989D\u4E0E\u8FD1 7 \u5929\u6D88\u8D39\u3002"
        ) : null
      ),
      data && hasToken ? createStatsCard(createElement, data) : null
    );
  };
}
function createStatsCard(createElement, data) {
  const total = totalUsage(data.daily);
  const max = Math.max(...data.daily.map((day) => day.yuan), 0);
  const snapshot = data.billing;
  const balanceLow = snapshot.balanceYuan !== null && snapshot.balanceYuan < LOW_BALANCE_YUAN;
  return createElement(
    "section",
    { className: "flex flex-col gap-4 rounded-lg border border-gray-200 p-4" },
    createElement(
      "div",
      { className: "flex flex-wrap items-end justify-between gap-3" },
      createElement(
        "div",
        { className: "flex flex-col gap-1" },
        createElement("span", { className: "text-xs text-gray-500" }, "\u5F53\u524D\u4F59\u989D\uFF08\u4EBA\u6C11\u5E01\uFF09"),
        createElement(
          "span",
          {
            className: balanceLow ? "text-2xl font-semibold text-orange-600" : "text-2xl font-semibold text-gray-900"
          },
          snapshot.balanceYuan === null ? "\u4E0D\u9650\u989D\u4EE4\u724C" : `${formatYuan(snapshot.balanceYuan)}${snapshot.balanceQuota === null ? "" : `\uFF08\u7EA6 ${formatUsd(snapshot.balanceQuota / snapshot.quotaPerUnit)}\uFF09`}`
        ),
        balanceLow ? createElement("span", { className: "text-xs text-orange-600" }, "\u4F59\u989D\u504F\u4F4E\uFF0C\u8BF7\u53CA\u65F6\u5145\u503C") : null
      ),
      createElement(
        "div",
        { className: "flex flex-col gap-1 text-right" },
        createElement("span", { className: "text-xs text-gray-500" }, "\u8FD1 7 \u5929\u6D88\u8D39"),
        createElement("span", { className: "text-lg font-medium text-gray-800" }, formatYuan(total.yuan)),
        createElement("span", { className: "text-xs text-gray-400" }, `\u5171 ${total.calls} \u6B21\u8C03\u7528`)
      )
    ),
    data.warning ? createElement("div", { className: "rounded-md bg-yellow-50 px-3 py-2 text-xs text-yellow-700" }, data.warning) : null,
    createElement(
      "div",
      { className: "flex flex-col gap-1.5" },
      createElement("span", { className: "text-xs text-gray-500" }, "\u8FD1 7 \u5929\u9010\u65E5\u6D88\u8D39"),
      ...data.daily.map(
        (day) => createElement(
          "div",
          { key: day.date, className: "flex items-center gap-2" },
          createElement("span", { className: "w-14 shrink-0 text-xs text-gray-500" }, day.date.slice(5)),
          createElement(
            "div",
            { className: "h-2 flex-1 rounded bg-gray-100" },
            createElement("div", {
              className: "h-2 rounded bg-blue-500",
              style: { width: `${max > 0 ? Math.max(2, Math.round(day.yuan / max * 100)) : 0}%` }
            })
          ),
          createElement("span", { className: "w-16 shrink-0 text-right text-xs text-gray-600" }, formatYuan(day.yuan))
        )
      ),
      createElement("span", { className: "text-xs text-gray-400" }, "\u6570\u636E\u6309\u5DF2\u7ED3\u7B97\u6D88\u8D39\u8BB0\u5F55\u7EDF\u8BA1\uFF0C\u91D1\u989D\u6309 500,000 quota = $1 \u6298\u7B97\u4EBA\u6C11\u5E01\u3002")
    )
  );
}
function createStatusPill(ctx, deps) {
  const { createElement, useState, useEffect } = ctx.react;
  return function BillingStatusPill() {
    const [state, setState] = useState({ text: "\u2026", tone: "muted", title: "\u6A21\u578B\u7AD9\u4F59\u989D" });
    useEffect(() => {
      const listener = () => {
        void deps.refresh(false).then((fresh) => {
          const balance = fresh.billing.balanceYuan;
          setState({
            text: balance === null ? "\u4E0D\u9650\u989D" : formatYuan(balance),
            tone: balance !== null && balance < LOW_BALANCE_YUAN ? "low" : "normal",
            title: "\u6A21\u578B\u7AD9\u4F59\u989D\uFF0C\u70B9\u51FB\u6253\u5F00\u8BBE\u7F6E"
          });
        }).catch((error) => {
          const message = messageOf(error);
          setState({
            text: message.includes("\u8BBE\u7F6E") ? "\u672A\u914D\u7F6E" : "\u4E0D\u53EF\u7528",
            tone: "muted",
            title: message
          });
        });
      };
      listener();
      return void 0;
    }, []);
    const className = state.tone === "low" ? "rounded-full bg-orange-100 px-2 py-0.5 text-xs font-medium text-orange-600" : state.tone === "muted" ? "rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-400" : "rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600";
    return createElement(
      "button",
      { type: "button", className, title: state.title, onClick: () => deps.openSettings() },
      state.text
    );
  };
}
export {
  activate as default
};
