// src/alpha.ts
var ALPHA_BASE = "https://alphalawyer.cn";
var STATIC_HEADERS = {
  Accept: "application/json",
  Referer: `${ALPHA_BASE}/`
};
var MAX_ERROR_TEXT = 200;
var QUOTA_PHRASE = "\u5F53\u65E5\u8BD5\u7528\u6B21\u6570\u5DF2\u7528\u5B8C";
var KIND_MESSAGE = {
  unauthorized: "Alpha \u767B\u5F55\u6388\u6743\u5DF2\u5931\u6548\uFF0C\u8BF7\u5728 \u8BBE\u7F6E\u2192\u63D2\u4EF6\u2192Alpha \u6CD5\u5F8B\u68C0\u7D22 \u91CD\u65B0\u767B\u5F55\u6388\u6743\u3002",
  forbidden: "\u4F60\u7684 Alpha \u8D26\u53F7\u6CA1\u6709\u8FD9\u9879\u68C0\u7D22\u7684\u6743\u9650\uFF0C\u8BF7\u8054\u7CFB Alpha \u786E\u8BA4\u5F00\u901A\u8303\u56F4\u3002",
  "rate-limited": "Alpha \u68C0\u7D22\u8FC7\u4E8E\u9891\u7E41\uFF0C\u8BF7\u7A0D\u7B49\u7247\u523B\u518D\u8BD5\u3002",
  "quota-exhausted": "\u4F60\u7684 Alpha \u8D26\u53F7\u4ECA\u5929\u7684\u68C0\u7D22\u6B21\u6570\u5DF2\u7528\u5B8C\uFF0C\u8BF7\u660E\u5929\u518D\u8BD5\uFF0C\u6216\u8054\u7CFB Alpha \u786E\u8BA4\u989D\u5EA6\u3002",
  unavailable: "\u6682\u65F6\u65E0\u6CD5\u8FDE\u63A5 Alpha\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002",
  "invalid-response": "Alpha \u8FD4\u56DE\u4E86\u65E0\u6CD5\u8BC6\u522B\u7684\u5185\u5BB9\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002"
};
var AlphaError = class extends Error {
  kind;
  constructor(kind, detail) {
    super(kind === "rejected" ? `Alpha \u672A\u5B8C\u6210\u8FD9\u6B21\u68C0\u7D22\uFF1A${detail || "\u672A\u8BF4\u660E\u539F\u56E0"}` : KIND_MESSAGE[kind]);
    this.kind = kind;
  }
};
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function clip(text) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX_ERROR_TEXT ? `${flat.slice(0, MAX_ERROR_TEXT)}\u2026` : flat;
}
function buildUrl(path, params) {
  const query = Object.entries(params).map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`).join("&");
  return `${ALPHA_BASE}${path}?${query}`;
}
function authHeaders(token) {
  return { Authorization: `Token ${token}`, token, ...STATIC_HEADERS };
}
function checkStatus(reply) {
  if (reply.status === 401) throw new AlphaError("unauthorized");
  if (reply.body.includes(QUOTA_PHRASE)) throw new AlphaError("quota-exhausted");
  if (reply.status === 403) throw new AlphaError("forbidden");
  if (reply.status === 429) throw new AlphaError("rate-limited");
  if (reply.status < 200 || reply.status >= 300) throw new AlphaError("unavailable");
}
function readReply(reply) {
  if (typeof reply?.status !== "number" || typeof reply?.body !== "string") throw new AlphaError("invalid-response");
  checkStatus(reply);
  let parsed;
  try {
    parsed = JSON.parse(reply.body);
  } catch {
    throw new AlphaError("invalid-response");
  }
  if (!isRecord(parsed)) throw new AlphaError("invalid-response");
  if (parsed.isSuccess === false || parsed.succeed === false) {
    const message = typeof parsed.resultMsg === "string" ? parsed.resultMsg : typeof parsed.message === "string" ? parsed.message : "";
    throw new AlphaError("rejected", clip(message));
  }
  return parsed;
}
async function alphaGet(transport, path, params) {
  let reply;
  try {
    reply = await transport(buildUrl(path, params));
  } catch {
    throw new AlphaError("unavailable");
  }
  return readReply(reply);
}

// src/auth.ts
var TOKEN_PATTERN = /^[\x21-\x7e]{20,4096}$/;
var DAY_MS = 24 * 60 * 60 * 1e3;
var EXPIRING_WITHIN_MS = 3 * DAY_MS;
var MIN_EPOCH_MS = 1e12;
var MAX_EPOCH_MS = 1e14;
var JWT_MS_THRESHOLD = 1e11;
var AuthFormatError = class extends Error {
  constructor() {
    super("\u767B\u5F55\u6CA1\u6709\u62FF\u5230\u6709\u6548\u7684\u6388\u6743\uFF0C\u8BF7\u91CD\u65B0\u767B\u5F55 Alpha\u3002");
  }
};
function isValidToken(value) {
  return typeof value === "string" && TOKEN_PATTERN.test(value);
}
function epochMsOrNull(value) {
  return Number.isFinite(value) && value >= MIN_EPOCH_MS && value < MAX_EPOCH_MS ? Math.trunc(value) : null;
}
function jwtExpiry(token) {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const bytes = Uint8Array.from(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
    const payload = JSON.parse(new TextDecoder().decode(bytes));
    const exp = typeof payload === "object" && payload !== null ? payload.exp : void 0;
    if (typeof exp !== "number") return null;
    return epochMsOrNull(exp >= JWT_MS_THRESHOLD ? exp : exp * 1e3);
  } catch {
    return null;
  }
}
function deriveExpiry(token, tokenExpireTime) {
  const raw = tokenExpireTime?.trim() ?? "";
  if (/^\d+$/.test(raw)) {
    const fromPage = epochMsOrNull(Number(raw));
    if (fromPage !== null) return fromPage;
  }
  return jwtExpiry(token);
}
function authFromLogin(values, now) {
  const record = typeof values === "object" && values !== null ? values : {};
  const token = typeof record.token === "string" ? record.token.trim() : "";
  if (!isValidToken(token)) throw new AuthFormatError();
  const expireTime = typeof record.tokenExpireTime === "string" ? record.tokenExpireTime : void 0;
  return { token, expiresAt: deriveExpiry(token, expireTime), savedAt: now };
}
function parseStoredAuth(raw) {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw;
  if (!isValidToken(record.token)) return null;
  const expiresAt = typeof record.expiresAt === "number" && Number.isFinite(record.expiresAt) ? record.expiresAt : null;
  const savedAt = typeof record.savedAt === "number" ? record.savedAt : 0;
  return { token: record.token, expiresAt, savedAt };
}
function authStatus(auth, now) {
  if (!auth) return "none";
  if (auth.expiresAt === null) return "unknown-expiry";
  if (auth.expiresAt <= now) return "expired";
  return auth.expiresAt - now <= EXPIRING_WITHIN_MS ? "expiring" : "valid";
}
var pad = (value) => String(value).padStart(2, "0");
function formatDateTime(epochMs) {
  const d = new Date(epochMs);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
var daysLeft = (expiresAt, now) => Math.ceil((expiresAt - now) / DAY_MS);
function describeAuth(auth, now) {
  const status = authStatus(auth, now);
  if (status === "none" || !auth) return "\u672A\u6388\u6743";
  if (status === "unknown-expiry" || auth.expiresAt === null) return "\u5DF2\u6388\u6743\uFF08\u6709\u6548\u671F\u672A\u77E5\uFF09";
  if (status === "expired") return "\u6388\u6743\u5DF2\u8FC7\u671F\uFF0C\u8BF7\u91CD\u65B0\u767B\u5F55\u6388\u6743";
  const days = daysLeft(auth.expiresAt, now);
  if (status === "expiring") return `\u6388\u6743\u5C06\u5728 ${days} \u5929\u540E\u5230\u671F\uFF0C\u5EFA\u8BAE\u91CD\u65B0\u767B\u5F55`;
  return `\u5DF2\u6388\u6743\uFF0C\u6709\u6548\u671F\u81F3 ${formatDateTime(auth.expiresAt)}\uFF08\u8FD8\u5269 ${days} \u5929\uFF09`;
}

// src/query.ts
var MAX_KEYWORD = 200;
var MAX_PAGE = 100;
var MAX_SIZE = 20;
var LID_PATTERN = /^[0-9a-fA-F]{32}$/;
var SEPARATOR_PATTERN = /[,，:：]/;
var CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;
var FIELDS = ["\u5168\u6587", "\u6807\u9898"];
var EFF_LEVELS = [
  "\u6CD5\u5F8B",
  "\u884C\u653F\u6CD5\u89C4",
  "\u53F8\u6CD5\u89E3\u91CA",
  "\u90E8\u95E8\u89C4\u7AE0",
  "\u5730\u65B9\u89C4\u8303\u6027\u6587\u4EF6",
  "\u5730\u65B9\u6027\u6CD5\u89C4",
  "\u81EA\u6CBB\u6761\u4F8B",
  "\u5730\u65B9\u653F\u5E9C\u89C4\u7AE0",
  "\u515A\u5185\u6CD5\u89C4",
  "\u884C\u4E1A\u89C4\u5B9A",
  "\u56E2\u4F53\u89C4\u5B9A",
  "\u519B\u4E8B\u6CD5\u89C4",
  "\u76D1\u5BDF\u6CD5\u89C4",
  "\u56FD\u5BB6\u6807\u51C6",
  "\u5730\u65B9\u53F8\u6CD5\u6587\u4EF6"
];
var InputError = class extends Error {
};
function readKeyword(input, name = "keyword", label = "\u68C0\u7D22\u8BCD") {
  const raw = input[name];
  const text = typeof raw === "string" ? raw.trim() : "";
  if (text === "") throw new InputError(`${label}\u4E0D\u80FD\u4E3A\u7A7A\u3002`);
  if (text.length > MAX_KEYWORD) throw new InputError(`${label}\u8FC7\u957F\uFF0C\u8BF7\u7F29\u77ED\u5230 ${MAX_KEYWORD} \u5B57\u4EE5\u5185\u3002`);
  if (SEPARATOR_PATTERN.test(text)) throw new InputError(`${label}\u91CC\u4E0D\u80FD\u6709\u9017\u53F7\u6216\u5192\u53F7\uFF0C\u591A\u4E2A\u8BCD\u8BF7\u7528\u7A7A\u683C\u5206\u9694\u3002`);
  if (CONTROL_PATTERN.test(text)) throw new InputError(`${label}\u91CC\u4E0D\u80FD\u6709\u6362\u884C\u7B49\u7279\u6B8A\u5B57\u7B26\u3002`);
  return text;
}
function readInteger(input, name, label, fallback, max) {
  const raw = input[name];
  if (raw === void 0 || raw === null) return fallback;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > max) {
    throw new InputError(`${label}\u5E94\u4E3A 1 \u5230 ${max} \u4E4B\u95F4\u7684\u6574\u6570\u3002`);
  }
  return raw;
}
var readPage = (input) => readInteger(input, "page", "\u9875\u7801", 1, MAX_PAGE);
var readSize = (input) => readInteger(input, "size", "\u6BCF\u9875\u6761\u6570", 10, MAX_SIZE);
function readField(input) {
  const raw = input.field;
  if (raw === void 0 || raw === null || raw === "") return "\u5168\u6587";
  const found = FIELDS.find((item) => item === raw);
  if (!found) throw new InputError("\u68C0\u7D22\u8303\u56F4\u53EA\u80FD\u662F\u300C\u5168\u6587\u300D\u6216\u300C\u6807\u9898\u300D\u3002");
  return found;
}
function readEffLevel(input) {
  const raw = input.eff_level;
  if (raw === void 0 || raw === null || raw === "") return null;
  const found = EFF_LEVELS.find((item) => item === raw);
  if (!found) throw new InputError(`\u6548\u529B\u7EA7\u522B\u53EA\u80FD\u662F\uFF1A${EFF_LEVELS.join("\u3001")}\u3002`);
  return found;
}
function readLid(input) {
  const raw = typeof input.lid === "string" ? input.lid.trim() : "";
  if (!LID_PATTERN.test(raw)) throw new InputError("\u6CD5\u89C4\u7F16\u53F7\u4E0D\u5BF9\uFF1A\u8BF7\u5148\u7528\u6CD5\u89C4\u68C0\u7D22\u62FF\u5230 32 \u4F4D\u7684 lid \u518D\u67E5\u6761\u6587\u3002");
  return raw;
}
function buildQuery(keyword, field = "\u5168\u6587", fuzzy = false) {
  return `${field}${fuzzy ? "\u6A21\u7CCA" : ""}:${keyword}`;
}
function strip(text) {
  if (typeof text !== "string") return "";
  return text.replace(/<[^>]+>/g, "").replaceAll("&nbsp;", " ").trim();
}
function plain(value) {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}
function isRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
var WALK_KEYS = ["l", "text", "sentences", "subParagraphs", "paragraphs"];
function walkNested(node, parts, limit) {
  if (parts.join("").length >= limit) return;
  if (Array.isArray(node)) {
    for (const item of node) walkNested(item, parts, limit);
  } else if (typeof node === "string") {
    const text = strip(node);
    if (text) parts.push(text);
  } else if (isRecord2(node)) {
    const label = node.lableName || node.labelName;
    if (label && node.labelType !== void 0 && node.labelType !== null) parts.push(`\u3010${String(label)}\u3011`);
    for (const key of WALK_KEYS) if (key in node) walkNested(node[key], parts, limit);
    if (!WALK_KEYS.some((key) => key in node)) for (const value of Object.values(node)) walkNested(value, parts, limit);
  }
}
function nestedText(value, limit = 400) {
  if (value === null || value === void 0) return "";
  if (typeof value === "string") {
    const text = value.trim();
    if (text.startsWith("{") || text.startsWith("[")) {
      try {
        return nestedText(JSON.parse(text), limit);
      } catch {
        return strip(text).slice(0, limit);
      }
    }
    return strip(text).slice(0, limit);
  }
  const parts = [];
  walkNested(value, parts, limit);
  return parts.join("").replace(/\s+/g, " ").slice(0, limit);
}
function dropLeadingName(body, name) {
  if (!name) return body;
  return body.replace(new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*`), "");
}

// src/settings.ts
var BUTTON_PRIMARY = "rounded-full bg-blue-600 px-3 py-2 text-caption-1-medium text-white shadow-sm transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50";
var BUTTON_PLAIN = "rounded-full border-border-button-default px-3 py-2 text-caption-1-medium text-text-secondary transition-colors hover:bg-button-ghost-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50";
var BORDER_STYLE = { borderWidth: "1px", borderStyle: "solid" };
var WAITING = "\u8BF7\u5728\u5F39\u51FA\u7684\u7A97\u53E3\u4E2D\u767B\u5F55 Alpha\u2026";
function loginErrorText(error) {
  if (error instanceof AuthFormatError) return error.message;
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("cancelled")) return "\u5DF2\u53D6\u6D88\u767B\u5F55";
  if (message.includes("timeout")) return "\u767B\u5F55\u8D85\u65F6\uFF0C\u8BF7\u91CD\u8BD5";
  if (message.includes("unknown bridge command")) return "\u5F53\u524D\u7248\u672C\u4E0D\u652F\u6301\u767B\u5F55\u6388\u6743\uFF0C\u8BF7\u5148\u5347\u7EA7 LawyerCopilot";
  return "\u767B\u5F55\u6CA1\u6709\u5B8C\u6210\uFF0C\u8BF7\u91CD\u8BD5\u3002";
}
function useStoredAuth(react, account, setAuth, setError) {
  react.useEffect(() => {
    let alive = true;
    void account.loadAuth().then((stored) => {
      if (alive) setAuth(stored);
    }).catch(() => {
      if (alive) setError("\u65E0\u6CD5\u8BFB\u53D6\u672C\u673A\u4FDD\u5B58\u7684\u6388\u6743\uFF0C\u8BF7\u91CD\u65B0\u6253\u5F00\u63D2\u4EF6\u8BBE\u7F6E\u3002");
    });
    return () => {
      alive = false;
    };
  }, []);
}
function usePanelState(react, account) {
  const [auth, setAuth] = react.useState(null);
  const [busy, setBusy] = react.useState(false);
  const [error, setError] = react.useState("");
  const [notice, setNotice] = react.useState("");
  useStoredAuth(react, account, setAuth, setError);
  async function run(waiting, action, failure) {
    setBusy(true);
    setError("");
    setNotice(waiting);
    try {
      setNotice(await action());
    } catch (cause) {
      setNotice("");
      setError(failure(cause));
    } finally {
      setBusy(false);
    }
  }
  const login = () => {
    if (busy) return;
    void run(WAITING, async () => {
      setAuth(await account.login());
      return "\u767B\u5F55\u6210\u529F\u3002\u6388\u6743\u53EA\u4FDD\u5B58\u5728\u8FD9\u53F0\u7535\u8111\u4E0A\u3002";
    }, loginErrorText);
  };
  const clear = () => {
    if (busy || !auth) return;
    void run("", async () => {
      await account.clear();
      setAuth(null);
      return "\u5DF2\u89E3\u9664\u6388\u6743\uFF0C\u672C\u673A\u4E0D\u518D\u4FDD\u5B58 Alpha \u7684\u767B\u5F55\u6388\u6743\u3002";
    }, () => "\u89E3\u9664\u6388\u6743\u6CA1\u6709\u5B8C\u6210\uFF0C\u8BF7\u91CD\u8BD5\u3002");
  };
  return { auth, status: describeAuth(auth, account.now()), busy, error, notice, login, clear };
}
function renderPanel(createElement, view) {
  return createElement(
    "section",
    { className: "flex flex-col gap-2 rounded-xl border-separator-border p-2.5", style: BORDER_STYLE },
    createElement("h3", { className: "text-title-3-semibold text-text-primary" }, "Alpha \u8D26\u53F7"),
    createElement(
      "p",
      { className: "text-caption-1-regular text-text-tertiary" },
      "\u4F7F\u7528\u4F60\u81EA\u5DF1\u7684 Alpha \u8D26\u53F7\u767B\u5F55\u6388\u6743\u540E\uFF0C\u5373\u53EF\u5728\u5BF9\u8BDD\u91CC\u68C0\u7D22\u6CD5\u89C4\u3001\u6761\u6587\u3001\u6848\u4F8B\u7B49\u3002\u6388\u6743\u53EA\u4FDD\u5B58\u5728\u8FD9\u53F0\u7535\u8111\u4E0A\uFF0C\u68C0\u7D22\u6B21\u6570\u548C\u6743\u9650\u7531 Alpha \u6309\u4F60\u7684\u8D26\u53F7\u8BA1\u7B97\u3002"
    ),
    createElement("p", { className: "text-caption-1-medium text-text-secondary" }, view.status),
    view.error !== "" ? createElement(
      "div",
      { className: "rounded-lg bg-background-tertiary-error px-3 py-2 text-caption-1-regular text-text-error-primary" },
      view.error
    ) : null,
    view.notice !== "" ? createElement("p", { className: "text-caption-1-regular text-text-secondary" }, view.notice) : null,
    createElement(
      "div",
      { className: "flex items-center gap-2" },
      createElement(
        "button",
        { type: "button", className: BUTTON_PRIMARY, disabled: view.busy, onClick: view.login },
        view.auth ? "\u91CD\u65B0\u767B\u5F55\u6388\u6743" : "\u767B\u5F55 Alpha \u6388\u6743"
      ),
      view.auth ? createElement(
        "button",
        { type: "button", className: BUTTON_PLAIN, style: BORDER_STYLE, disabled: view.busy, onClick: view.clear },
        "\u89E3\u9664\u6388\u6743"
      ) : null
    )
  );
}
function createSettingsPanel(ctx, account) {
  return function AlphaSettingsPanel() {
    return renderPanel(ctx.react.createElement, usePanelState(ctx.react, account));
  };
}

// src/format.ts
function rootOf(body, key) {
  const root = body[key];
  if (!isRecord(root)) throw new AlphaError("invalid-response");
  return root;
}
function rowsOf(value) {
  if (value === void 0 || value === null) return [];
  if (!Array.isArray(value)) throw new AlphaError("invalid-response");
  return value.filter(isRecord);
}
var totalOf = (root) => typeof root.totalCount === "number" ? root.totalCount : 0;
var orDash = (value) => value || "-";
function formatLawSearch(body, args) {
  const root = rootOf(body, "data");
  const rows = rowsOf(root.lawRegus);
  const scope = `${args.field}${args.fuzzy ? "\u6A21\u7CCA" : ""}`;
  const lines = [`\u6CD5\u89C4\u68C0\u7D22\u300C${args.keyword}\u300D\uFF08${scope}\uFF09\u547D\u4E2D ${totalOf(root)} \u6761\uFF0C\u672C\u9875 ${rows.length} \u6761`];
  rows.forEach((row, index) => {
    const hits = rowsOf(row.hitWords);
    const hitCount = plain(hits[0]?.hitWordCount) || "0";
    lines.push(
      "",
      `${index + 1}. \u300A${strip(row.title)}\u300B`,
      `   \u6548\u529B\u7EA7\u522B\uFF1A${orDash(plain(row.eff_level))} \uFF5C \u53D1\u6587\u673A\u5173\uFF1A${orDash(strip(row.dispatch_authority))} \uFF5C \u53D1\u5E03\uFF1A${orDash(plain(row.posting_date))}`,
      `   \u65F6\u6548\uFF1A${orDash(plain(row.time_limited))} \uFF5C \u65BD\u884C\uFF1A${orDash(plain(row.effective_date))} \uFF5C \u547D\u4E2D\u300C${args.keyword}\u300D${hitCount} \u6B21`,
      `   lid\uFF1A${plain(row.lid)}`
    );
  });
  if (rows.length === 0) lines.push("\uFF08\u65E0\u7ED3\u679C\uFF09");
  lines.push("", "\u63D0\u793A\uFF1A\u7528 alpha_law_articles \u4F20\u5165 lid \u548C\u5173\u952E\u8BCD\uFF0C\u53EF\u53D6\u8BE5\u6CD5\u89C4\u91CC\u547D\u4E2D\u6761\u6587\u7684\u5B8C\u6574\u539F\u6587\u3002");
  return lines.join("\n");
}
function formatLawArticles(body, lid, keyword) {
  const rows = rowsOf(body.data);
  const lines = [`\u6761\u6587\u547D\u4E2D ${rows.length} \u6761\uFF08lid=${lid}\uFF0C\u5173\u952E\u8BCD\u300C${keyword}\u300D\uFF09`];
  rows.forEach((row, index) => {
    const name = plain(row.fullName) || plain(row.name);
    lines.push("", `[${index + 1}] ${name}`, dropLeadingName(strip(row.text), name));
  });
  if (rows.length === 0) lines.push("\uFF08\u8BE5\u6CD5\u89C4\u6B63\u6587\u4E2D\u65E0\u6B64\u5173\u952E\u8BCD\uFF09");
  return lines.join("\n");
}
function applicableLawOf(value) {
  if (Array.isArray(value)) {
    return value.slice(0, 4).map((item) => strip(typeof item === "string" ? item : isRecord(item) ? item.title : "")).join("\u3001").slice(0, 200);
  }
  return plain(value).slice(0, 200);
}
function caseLines(row, index) {
  const lines = [
    "",
    `${index + 1}. ${strip(row.title) || strip(row.caseNumber)}`,
    `   \u6848\u53F7\uFF1A${orDash(plain(row.caseNumber))} \uFF5C \u6CD5\u9662\uFF1A${orDash(plain(row.courtName))} \uFF5C \u6848\u7531\uFF1A${orDash(strip(row.allTextCause))}`,
    `   \u5224\u51B3\u65E5\u671F\uFF1A${orDash(plain(row.courtDate) || plain(row.judgment_date))} \uFF5C \u7C7B\u578B\uFF1A${orDash(plain(row.caseType))}`
  ];
  const focus = nestedText(row.dispute_focus_new || row.dispute_focus, 220);
  if (focus) lines.push(`   \u4E89\u8BAE\u7126\u70B9\uFF1A${focus}`);
  const opinion = nestedText(row.courtOpinion, 320);
  if (opinion) lines.push(`   \u6CD5\u9662\u89C2\u70B9\uFF1A${opinion}`);
  const summary = nestedText(row.caseSummary, 180);
  if (summary && !opinion) lines.push(`   \u57FA\u672C\u6848\u60C5\uFF1A${summary}`);
  const laws = applicableLawOf(row.applicableLaw);
  if (laws) lines.push(`   \u9002\u7528\u6CD5\uFF1A${laws}`);
  lines.push(`   jid\uFF1A${plain(row.jid)}`);
  return lines;
}
function formatCaseSearch(body, keyword) {
  const root = rootOf(body, "result");
  const rows = rowsOf(root.judgements);
  const lines = [`\u6848\u4F8B\u68C0\u7D22\u300C${keyword}\u300D\u547D\u4E2D ${totalOf(root)} \u7BC7\uFF0C\u672C\u9875 ${rows.length} \u7BC7`];
  rows.forEach((row, index) => lines.push(...caseLines(row, index)));
  if (rows.length === 0) lines.push("\uFF08\u65E0\u7ED3\u679C\uFF09");
  return lines.join("\n");
}
function formatJudicialSearch(body, keyword) {
  const root = rootOf(body, "data");
  const rows = rowsOf(root.judicialViews);
  const lines = [`\u53F8\u6CD5\u89C2\u70B9\u68C0\u7D22\u300C${keyword}\u300D\u547D\u4E2D ${totalOf(root)} \u6761\uFF0C\u672C\u9875 ${rows.length} \u6761`];
  rows.forEach((row, index) => {
    lines.push("", `${index + 1}. ${(strip(row.viewTitle) || strip(row.rollTitle) || "-").slice(0, 120)}`);
    const source = strip(row.sourceInfo);
    if (source) lines.push(`   \u6765\u6E90\uFF1A${source}`);
    const content = strip(row.content);
    if (content) lines.push(`   \u89C2\u70B9\uFF1A${content.slice(0, 400)}`);
    if (plain(row.vid)) lines.push(`   vid\uFF1A${plain(row.vid)}`);
  });
  if (rows.length === 0) lines.push("\uFF08\u65E0\u7ED3\u679C\uFF09");
  return lines.join("\n");
}
function formatGenericSearch(body, keyword, layout) {
  const root = rootOf(body, "data");
  const rows = rowsOf(root[layout.listField]);
  const [titleKey, orgKey, dateKey, numberKey] = layout.fields;
  const lines = [`${layout.label}\u68C0\u7D22\u300C${keyword}\u300D\u547D\u4E2D ${totalOf(root)} \u6761\uFF0C\u672C\u9875 ${rows.length} \u6761`];
  rows.forEach((row, index) => {
    const title = strip(row[titleKey]) || strip(row.name) || strip(row.viewTitle) || "-";
    lines.push("", `${index + 1}. ${title.slice(0, 140)}`);
    const hitCount = plain(row.hitWordCount);
    const meta = [strip(row[orgKey]), plain(row[dateKey]), strip(row[numberKey]), hitCount && hitCount !== "0" ? `\u547D\u4E2D ${hitCount} \u6B21` : ""].filter(Boolean).join(" \uFF5C ");
    if (meta) lines.push(`   ${meta.slice(0, 240)}`);
    const hit = strip(row.hitResult);
    if (hit) lines.push(`   \u547D\u4E2D\u7247\u6BB5\uFF1A${hit.slice(0, 300)}`);
  });
  if (rows.length === 0) lines.push("\uFF08\u65E0\u7ED3\u679C\uFF09");
  return lines.join("\n");
}

// src/tools.ts
var LAW = "/ilawregu-search/api/v1/lawregu";
var KEYWORD = { type: "string", description: "\u68C0\u7D22\u8BCD\uFF0C\u53EF\u7528\u7A7A\u683C\u5206\u9694\u591A\u4E2A\u8BCD\uFF1B\u4E0D\u8981\u5E26\u9017\u53F7\u6216\u5192\u53F7\u3002" };
var FIELD = { type: "string", enum: FIELDS, description: "\u68C0\u7D22\u8303\u56F4\uFF1A\u5168\u6587\uFF08\u9ED8\u8BA4\uFF09\u6216 \u6807\u9898\u3002" };
var PAGE = { type: "integer", minimum: 1, maximum: 100, description: "\u9875\u7801\uFF0C\u9ED8\u8BA4 1\u3002" };
var SIZE = { type: "integer", minimum: 1, maximum: 20, description: "\u6BCF\u9875\u6761\u6570\uFF0C\u9ED8\u8BA4 10\uFF0C\u6700\u591A 20\u3002" };
function schema(properties, required) {
  return { type: "object", properties, required, additionalProperties: false };
}
function pageParams(input, query) {
  return { query, pageIndex: readPage(input), pageSize: readSize(input) };
}
function simpleSearch(name, description, path, render) {
  return {
    name,
    description,
    inputSchema: schema({ keyword: KEYWORD, page: PAGE, size: SIZE }, ["keyword"]),
    prepare(input) {
      const keyword = readKeyword(input);
      return { path, params: pageParams(input, buildQuery(keyword)), render: (body) => render(body, keyword) };
    }
  };
}
function genericSearch(name, description, path, layout) {
  return simpleSearch(name, description, path, (body, keyword) => formatGenericSearch(body, keyword, layout));
}
var lawSearch = {
  name: "alpha_law_search",
  description: "\u5728 Alpha \u6CD5\u89C4\u5E93\u68C0\u7D22\u6CD5\u5F8B\u3001\u884C\u653F\u6CD5\u89C4\u3001\u53F8\u6CD5\u89E3\u91CA\u3001\u90E8\u95E8\u89C4\u7AE0\u3001\u5730\u65B9\u6027\u6CD5\u89C4\u548C\u5730\u65B9\u89C4\u8303\u6027\u6587\u4EF6\u7B49\u3002\u6309\u5173\u952E\u8BCD\u627E\u6CD5\u5F8B\u4F9D\u636E\u65F6\u5148\u7528\u5B83\uFF1B\u7ED3\u679C\u91CC\u6BCF\u90E8\u6CD5\u89C4\u5E26\u4E00\u4E2A lid\uFF0C\u8981\u770B\u547D\u4E2D\u6761\u6587\u7684\u539F\u6587\uFF0C\u628A lid \u548C\u5173\u952E\u8BCD\u4EA4\u7ED9 alpha_law_articles\u3002",
  inputSchema: schema(
    {
      keyword: KEYWORD,
      field: FIELD,
      fuzzy: { type: "boolean", description: "\u662F\u5426\u6A21\u7CCA\u68C0\u7D22\uFF0C\u9ED8\u8BA4\u5426\u3002" },
      page: PAGE,
      size: SIZE,
      eff_level: { type: "string", enum: EFF_LEVELS, description: "\u53EA\u770B\u67D0\u4E00\u6548\u529B\u7EA7\u522B\u65F6\u586B\u5199\uFF1B\u4E0D\u9650\u5236\u65F6\u7701\u7565\u3002" }
    },
    ["keyword"]
  ),
  prepare(input) {
    const keyword = readKeyword(input);
    const field = readField(input);
    const fuzzy = input.fuzzy === true;
    const effLevel = readEffLevel(input);
    const base = buildQuery(keyword, field, fuzzy);
    const query = effLevel ? `${base},\u6548\u529B\u7EA7\u522B:${effLevel}` : base;
    return {
      path: `${LAW}/lawReguList`,
      params: { ...pageParams(input, query), order: "\u76F8\u5173\u6027" },
      render: (body) => formatLawSearch(body, { keyword, field, fuzzy })
    };
  }
};
var lawArticles = {
  name: "alpha_law_articles",
  description: "\u5728\u4E00\u90E8\u6CD5\u89C4\u91CC\u627E\u51FA\u542B\u6709\u5173\u952E\u8BCD\u7684\u6761\u6587\uFF0C\u8FD4\u56DE\u5E26\u6761\u53F7\u7684\u5B8C\u6574\u6761\u6587\u539F\u6587\uFF0C\u9002\u5408\u5F15\u7528\u548C\u6838\u5BF9\u6761\u6587\u3002lid \u5FC5\u987B\u6765\u81EA alpha_law_search \u7684\u7ED3\u679C\u3002",
  inputSchema: schema(
    { lid: { type: "string", description: "\u6CD5\u89C4\u7684 lid\uFF0832 \u4F4D\uFF09\uFF0C\u4ECE alpha_law_search \u7ED3\u679C\u4E2D\u53D6\u3002" }, keyword: KEYWORD },
    ["lid", "keyword"]
  ),
  prepare(input) {
    const lid = readLid(input);
    const keyword = readKeyword(input);
    return {
      path: `${LAW}/getHitTiao`,
      params: { lid, query: buildQuery(keyword) },
      render: (body) => formatLawArticles(body, lid, keyword)
    };
  }
};
var caseSearch = {
  name: "alpha_case_search",
  description: "\u5728 Alpha \u88C1\u5224\u6848\u4F8B\u5E93\u68C0\u7D22\u7C7B\u6848\u3002\u8FD4\u56DE\u6848\u53F7\u3001\u6CD5\u9662\u3001\u6848\u7531\u3001\u4E89\u8BAE\u7126\u70B9\u3001\u6CD5\u9662\u89C2\u70B9\u548C\u9002\u7528\u6CD5\uFF0C\u9002\u5408\u6309\u5173\u952E\u8BCD\u627E\u88C1\u5224\u5148\u4F8B\u3002",
  inputSchema: schema({ keyword: KEYWORD, field: FIELD, page: PAGE, size: SIZE }, ["keyword"]),
  prepare(input) {
    const keyword = readKeyword(input);
    const query = buildQuery(keyword, readField(input));
    return {
      path: "/judgement-search/api/v1/search/caseList",
      params: pageParams(input, query),
      render: (body) => formatCaseSearch(body, keyword)
    };
  }
};
var TOOL_SPECS = [
  lawSearch,
  lawArticles,
  caseSearch,
  simpleSearch(
    "alpha_judicial_search",
    "\u5728 Alpha \u53F8\u6CD5\u89C2\u70B9\u5E93\u68C0\u7D22\u6700\u9AD8\u4EBA\u6C11\u6CD5\u9662\u7B49\u51FA\u7248\u7684\u53F8\u6CD5\u89C2\u70B9\u548C\u88C1\u5224\u89C4\u5219\u89E3\u8BFB\uFF0C\u8FD4\u56DE\u89C2\u70B9\u6807\u9898\u3001\u6765\u6E90\u4E66\u76EE\u548C\u89C2\u70B9\u6B63\u6587\u3002",
    "/judicialview/api/v1/judicialview/search",
    formatJudicialSearch
  ),
  genericSearch(
    "alpha_penalty_search",
    "\u5728 Alpha \u884C\u653F\u5904\u7F5A\u5E93\u68C0\u7D22\u884C\u653F\u5904\u7F5A\u51B3\u5B9A\uFF0C\u8FD4\u56DE\u5904\u7F5A\u6848\u540D\u3001\u5904\u7F5A\u673A\u5173\u3001\u65E5\u671F\u3001\u6587\u53F7\u548C\u547D\u4E2D\u7247\u6BB5\uFF0C\u9002\u5408\u67E5\u76D1\u7BA1\u5904\u7F5A\u5148\u4F8B\u3002",
    "/penalty/api/v1/search/penaltyList",
    { label: "\u884C\u653F\u5904\u7F5A", listField: "penaltyDtoList", fields: ["title", "institution", "penaltyDate", "caseNum"] }
  ),
  genericSearch(
    "alpha_inspection_search",
    "\u5728 Alpha \u68C0\u5BDF\u6587\u4E66\u5E93\u68C0\u7D22\u8D77\u8BC9\u4E66\u3001\u4E0D\u8D77\u8BC9\u51B3\u5B9A\u4E66\u7B49\u68C0\u5BDF\u6587\u4E66\uFF0C\u8FD4\u56DE\u6587\u4E66\u540D\u3001\u547D\u4E2D\u6B21\u6570\u548C\u547D\u4E2D\u7247\u6BB5\u3002",
    "/inspection/api/v1/search/inspectionList",
    { label: "\u68C0\u5BDF\u6587\u4E66", listField: "inspectionDtoList", fields: ["title", "inspectionOrg", "inspectionDate", "caseNum"] }
  )
];

// src/index.ts
var AUTH_KEY = "alpha-auth";
var SETTINGS_KEY = "lawyer-alpha";
var LOGIN_URL = "https://alphalawyer.cn/";
var NOT_AUTHORIZED = "\u8FD8\u6CA1\u6709\u767B\u5F55 Alpha \u6388\u6743\uFF1A\u8BF7\u5728 \u8BBE\u7F6E\u2192\u63D2\u4EF6\u2192Alpha \u6CD5\u5F8B\u68C0\u7D22 \u70B9\u51FB\u300C\u767B\u5F55 Alpha \u6388\u6743\u300D\u3002";
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}
function textResult(text, isError = false) {
  return isError ? { content: [{ type: "text", text }], isError } : { content: [{ type: "text", text }] };
}
var expiredGuidance = (expiresAt) => `Alpha \u6388\u6743\u5DF2\u4E8E ${formatDateTime(expiresAt)} \u8FC7\u671F\uFF0C\u8BF7\u5728 \u8BBE\u7F6E\u2192\u63D2\u4EF6\u2192Alpha \u6CD5\u5F8B\u68C0\u7D22 \u91CD\u65B0\u767B\u5F55\u6388\u6743\u3002`;
function createAccount(ctx, now) {
  return {
    loadAuth: async () => parseStoredAuth(await ctx.storage.get(AUTH_KEY)),
    async login() {
      const values = await ctx.bridge.invoke("plugin_web_login", {
        url: LOGIN_URL,
        requiredKeys: ["token"],
        optionalKeys: ["tokenExpireTime"],
        reset: true
      });
      const auth = authFromLogin(values, now());
      await ctx.storage.set(AUTH_KEY, auth);
      return auth;
    },
    clear: () => ctx.storage.delete(AUTH_KEY),
    now
  };
}
function createRunner(ctx, account, now) {
  function transport(token) {
    return (url) => ctx.bridge.invoke("plugin_http_request", { method: "GET", url, headers: authHeaders(token) });
  }
  async function markInvalid(auth) {
    await ctx.storage.set(AUTH_KEY, { ...auth, expiresAt: now() });
  }
  async function run(spec, input) {
    const request = spec.prepare(input);
    const auth = await account.loadAuth();
    if (!auth) return textResult(NOT_AUTHORIZED);
    if (authStatus(auth, now()) === "expired" && auth.expiresAt !== null) return textResult(expiredGuidance(auth.expiresAt));
    try {
      return textResult(request.render(await alphaGet(transport(auth.token), request.path, request.params)));
    } catch (error) {
      if (error instanceof AlphaError && error.kind === "unauthorized") await markInvalid(auth);
      throw error;
    }
  }
  return run;
}
function activateWith(ctx, now) {
  const account = createAccount(ctx, now);
  const run = createRunner(ctx, account, now);
  const disposers = TOOL_SPECS.map(
    (spec) => ctx.tools.register({
      name: spec.name,
      description: spec.description,
      inputSchema: spec.inputSchema,
      async execute(input) {
        try {
          return await run(spec, input);
        } catch (error) {
          const prefix = error instanceof InputError ? "\u68C0\u7D22\u672A\u53D1\u51FA\uFF1A" : "";
          return textResult(`${prefix}${messageOf(error)}`, true);
        }
      }
    })
  );
  disposers.push(
    ctx.ui.registerSettingsSection({
      key: SETTINGS_KEY,
      label: () => "Alpha \u6CD5\u5F8B\u68C0\u7D22",
      component: createSettingsPanel(ctx, account)
    })
  );
  return () => {
    for (const dispose of disposers.splice(0)) dispose();
  };
}
function activate(ctx) {
  return activateWith(ctx, () => Date.now());
}
export {
  LOGIN_URL,
  activateWith,
  activate as default
};
