// src/token.ts
var TOKEN_PATTERN = /^[\x21-\x7e]{8,512}$/;
var TokenFormatError = class extends Error {
  constructor() {
    super("\u6388\u6743\u7801\u683C\u5F0F\u4E0D\u5BF9\uFF1A\u8BF7\u7C98\u8D34\u5A01\u79D1\u5148\u884C\u63D0\u4F9B\u7684\u5B8C\u6574\u6388\u6743\u7801\uFF0C\u4E2D\u95F4\u4E0D\u80FD\u6709\u7A7A\u683C\u6216\u6362\u884C\u3002");
  }
};
function normalizeToken(input) {
  const token = input.trim().replace(/^Bearer\s+/i, "");
  if (!TOKEN_PATTERN.test(token)) throw new TokenFormatError();
  return token;
}
function maskToken(token) {
  return token.length <= 4 ? "\u2022\u2022\u2022\u2022" : `\u2022\u2022\u2022\u2022${token.slice(-4)}`;
}

// src/settings.ts
var INPUT_CLASS = "min-w-0 flex-1 rounded-md border-border-button-default bg-background-full px-3 py-2 text-body-2-regular text-text-primary disabled:cursor-not-allowed disabled:opacity-50";
var BUTTON_PRIMARY = "rounded-full bg-blue-600 px-3 py-2 text-caption-1-medium text-white shadow-sm transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50";
var BUTTON_PLAIN = "rounded-full border-border-button-default px-3 py-2 text-caption-1-medium text-text-secondary transition-colors hover:bg-button-ghost-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50";
var BORDER_STYLE = { borderWidth: "1px", borderStyle: "solid" };
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}
function createSettingsPanel(ctx, account) {
  const { createElement, useState, useEffect } = ctx.react;
  return function WkSettingsPanel() {
    const [tokenMask, setTokenMask] = useState("");
    const [draft, setDraft] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    useEffect(() => {
      let alive = true;
      void account.loadToken().then((token) => {
        if (alive) setTokenMask(token ? maskToken(token) : "");
      }).catch(() => {
        if (alive) setError("\u65E0\u6CD5\u8BFB\u53D6\u672C\u673A\u4FDD\u5B58\u7684\u6388\u6743\u7801\uFF0C\u8BF7\u91CD\u65B0\u6253\u5F00\u63D2\u4EF6\u8BBE\u7F6E\u3002");
      });
      return () => {
        alive = false;
      };
    }, []);
    async function run(action) {
      setBusy(true);
      setError("");
      setNotice("");
      try {
        await action();
      } catch (cause) {
        setError(messageOf(cause));
      } finally {
        setBusy(false);
      }
    }
    function save() {
      if (busy || !draft.trim()) return;
      void run(async () => {
        const token = await account.saveToken(draft);
        setDraft("");
        setTokenMask(maskToken(token));
        setNotice("\u5DF2\u4FDD\u5B58\u3002\u6388\u6743\u7801\u53EA\u4FDD\u5B58\u5728\u8FD9\u53F0\u7535\u8111\u4E0A\u3002");
      });
    }
    function clear() {
      if (busy || !tokenMask) return;
      void run(async () => {
        await account.clearToken();
        setTokenMask("");
        setNotice("\u5DF2\u6E05\u9664\u672C\u673A\u4FDD\u5B58\u7684\u6388\u6743\u7801\u3002");
      });
    }
    function check() {
      if (busy || !tokenMask) return;
      void run(async () => {
        await account.check();
        setNotice("\u8FDE\u63A5\u6B63\u5E38\uFF0C\u53EF\u4EE5\u5728\u5BF9\u8BDD\u91CC\u68C0\u7D22\u4E86\u3002");
      });
    }
    const hasToken = tokenMask !== "";
    return createElement(
      "section",
      { className: "flex flex-col gap-2 rounded-xl border-separator-border p-2.5", style: BORDER_STYLE },
      createElement("h3", { className: "text-title-3-semibold text-text-primary" }, "\u5A01\u79D1\u5148\u884C\u8D26\u53F7"),
      createElement(
        "p",
        { className: "text-caption-1-regular text-text-tertiary" },
        "\u4F7F\u7528\u4F60\u81EA\u5DF1\u8D2D\u4E70\u7684\u5A01\u79D1\u5148\u884C\u6388\u6743\u7801\u68C0\u7D22\u6CD5\u89C4\u548C\u6848\u4F8B\u3002\u6388\u6743\u7801\u53EA\u4FDD\u5B58\u5728\u8FD9\u53F0\u7535\u8111\u4E0A\uFF0C\u68C0\u7D22\u6B21\u6570\u548C\u6743\u9650\u7531\u5A01\u79D1\u5148\u884C\u6309\u4F60\u7684\u8D26\u53F7\u8BA1\u7B97\u3002"
      ),
      error !== "" ? createElement(
        "div",
        { className: "rounded-lg bg-background-tertiary-error px-3 py-2 text-caption-1-regular text-text-error-primary" },
        error
      ) : null,
      notice !== "" ? createElement("p", { className: "text-caption-1-regular text-text-secondary" }, notice) : null,
      hasToken ? createElement(
        "div",
        { className: "flex items-center gap-2" },
        createElement("span", { className: "text-caption-1-medium text-text-secondary" }, `\u5DF2\u586B\u5199\u6388\u6743\u7801 ${tokenMask}`),
        createElement(
          "button",
          { type: "button", className: BUTTON_PLAIN, style: BORDER_STYLE, disabled: busy, onClick: () => check() },
          busy ? "\u5904\u7406\u4E2D\u2026" : "\u68C0\u67E5\u8FDE\u63A5"
        ),
        createElement(
          "button",
          { type: "button", className: BUTTON_PLAIN, style: BORDER_STYLE, disabled: busy, onClick: () => clear() },
          "\u6E05\u9664"
        )
      ) : null,
      createElement(
        "div",
        { className: "flex gap-2" },
        createElement("input", {
          type: "password",
          className: INPUT_CLASS,
          style: BORDER_STYLE,
          placeholder: hasToken ? "\u7C98\u8D34\u65B0\u7684\u6388\u6743\u7801\u4EE5\u66F4\u6362" : "\u7C98\u8D34\u5A01\u79D1\u5148\u884C\u6388\u6743\u7801",
          value: draft,
          disabled: busy,
          autoComplete: "off",
          onChange: (event) => setDraft(event.target.value),
          onKeyDown: (event) => {
            if (event.key === "Enter") save();
          }
        }),
        createElement(
          "button",
          { type: "button", className: BUTTON_PRIMARY, disabled: busy || !draft.trim(), onClick: () => save() },
          hasToken ? "\u66F4\u6362" : "\u4FDD\u5B58"
        )
      )
    );
  };
}

// src/tools.ts
var MAX_TEXT = 2e3;
var DATE_PATTERN = /^\d{4}\.\d{2}\.\d{2}$/;
var ANY_DATE = "*";
var InputError = class extends Error {
};
var TOOL_SPECS = [
  {
    name: "search_law",
    description: "\u5728\u5A01\u79D1\u5148\u884C\u91CC\u7528\u4E00\u53E5\u8BDD\u68C0\u7D22\u6CD5\u5F8B\u6CD5\u89C4\u3001\u90E8\u95E8\u89C4\u7AE0\u3001\u5730\u65B9\u6027\u6CD5\u89C4\u548C\u5177\u4F53\u6761\u6587\u3002\u9002\u5408\u6309\u6CD5\u5F8B\u95EE\u9898\u6216\u4E1A\u52A1\u573A\u666F\u627E\u6CD5\u5F8B\u4F9D\u636E\u3002",
    textParam: "question",
    textHint: "\u7528\u81EA\u7136\u8BED\u8A00\u63CF\u8FF0\u6CD5\u5F8B\u95EE\u9898\u3001\u4E1A\u52A1\u573A\u666F\u3001\u6CD5\u89C4\u540D\u79F0\u6216\u6761\u6587\u7EBF\u7D22\u3002"
  },
  {
    name: "search_law_keyword",
    description: "\u5728\u5A01\u79D1\u5148\u884C\u91CC\u7528\u5173\u952E\u8BCD\u68C0\u7D22\u6CD5\u5F8B\u6CD5\u89C4\u3002\u9002\u5408\u5DF2\u77E5\u6CD5\u89C4\u540D\u79F0\u3001\u53D1\u5E03\u673A\u5173\u3001\u53D1\u6587\u5B57\u53F7\u65F6\u7CBE\u786E\u67E5\u627E\uFF0C\u53EF\u9650\u5B9A\u53D1\u5E03\u65E5\u671F\u548C\u751F\u6548\u65E5\u671F\u3002",
    textParam: "query",
    textHint: "\u7528\u7A7A\u683C\u5206\u9694\u7684\u5173\u952E\u8BCD\uFF0C\u4F8B\u5982\uFF1A\u52B3\u52A8 \u5408\u540C\u3002",
    dateParams: {
      promulgating_start_date: "\u53D1\u5E03\u65E5\u671F\u8D77",
      promulgating_end_date: "\u53D1\u5E03\u65E5\u671F\u6B62",
      effective_start_date: "\u751F\u6548\u65E5\u671F\u8D77",
      effective_end_date: "\u751F\u6548\u65E5\u671F\u6B62"
    }
  },
  {
    name: "search_law_article",
    description: "\u5728\u5A01\u79D1\u5148\u884C\u91CC\u6309\u300C\u6CD5\u89C4\u540D + \u7B2C\u51E0\u6761\u300D\u67E5\u627E\u5177\u4F53\u6CD5\u6761\u539F\u6587\uFF0C\u6CD5\u89C4\u540D\u652F\u6301\u6A21\u7CCA\u5339\u914D\u3002",
    textParam: "query",
    textHint: "\u6CD5\u89C4\u540D\u52A0\u6761\u6B3E\uFF0C\u4F8B\u5982\uFF1A\u6C11\u6CD5\u5178 \u7B2C\u4E94\u767E\u4E03\u5341\u4E03\u6761\uFF1B\u4E5F\u53EF\u5199\u5230\u6B3E\u3001\u9879\u3002"
  },
  {
    name: "search_case",
    description: "\u5728\u5A01\u79D1\u5148\u884C\u91CC\u7528\u4E00\u53E5\u8BDD\u68C0\u7D22\u7C7B\u6848\u3002\u9002\u5408\u6309\u6848\u60C5\u3001\u4E89\u8BAE\u7126\u70B9\u6216\u88C1\u5224\u89C2\u70B9\u627E\u6848\u4F8B\uFF0C\u7ED3\u679C\u542B\u6848\u53F7\u3001\u6848\u7531\u3001\u6CD5\u9662\u3001\u672C\u9662\u8BA4\u4E3A\u548C\u88C1\u5224\u7ED3\u679C\u3002",
    textParam: "question",
    textHint: "\u7528\u81EA\u7136\u8BED\u8A00\u6982\u62EC\u6848\u4EF6\u4E8B\u5B9E\u3001\u4E89\u8BAE\u7126\u70B9\u3001\u6848\u7531\u6216\u5F53\u4E8B\u4EBA\u8BC9\u6C42\u3002"
  },
  {
    name: "search_case_keyword",
    description: "\u5728\u5A01\u79D1\u5148\u884C\u91CC\u7528\u5173\u952E\u8BCD\u68C0\u7D22\u88C1\u5224\u6848\u4F8B\u3002\u9002\u5408\u5DF2\u77E5\u6848\u53F7\u3001\u6848\u7531\u6216\u6B63\u6587\u5173\u952E\u8BCD\u65F6\u7CBE\u786E\u67E5\u627E\uFF0C\u53EF\u9650\u5B9A\u88C1\u5224\u65E5\u671F\u3002",
    textParam: "query",
    textHint: "\u7528\u7A7A\u683C\u5206\u9694\u7684\u5173\u952E\u8BCD\uFF0C\u4F8B\u5982\uFF1A\u52B3\u52A8 \u5DE5\u8D44\u3002",
    dateParams: { start_date: "\u88C1\u5224\u65E5\u671F\u8D77", end_date: "\u88C1\u5224\u65E5\u671F\u6B62" }
  },
  {
    name: "legal_citation",
    description: "\u5728\u5A01\u79D1\u5148\u884C\u91CC\u6838\u5BF9\u4E00\u6BB5\u6587\u5B57\u4E2D\u5F15\u7528\u7684\u6CD5\u89C4\u3001\u6CD5\u6761\u3001\u6848\u53F7\u548C\u884C\u653F\u5904\u7F5A\u6587\u53F7\uFF0C\u8FD4\u56DE\u5339\u914D\u5230\u7684\u51FA\u5904\u3002",
    textParam: "query",
    textHint: "\u9700\u8981\u6838\u5BF9\u5F15\u7528\u7684\u6587\u5B57\uFF0C\u6CD5\u89C4\u540D\u79F0\u8BF7\u7528\u300A\u300B\u62EC\u8D77\u6765\u3002"
  }
];
function inputSchemaOf(spec) {
  const properties = { [spec.textParam]: { type: "string", description: spec.textHint } };
  for (const [name, label] of Object.entries(spec.dateParams ?? {})) {
    properties[name] = { type: "string", description: `${label}\uFF0C\u683C\u5F0F YYYY.MM.DD\uFF1B\u4E0D\u9650\u5236\u65F6\u7701\u7565\u3002` };
  }
  return { type: "object", properties, required: [spec.textParam], additionalProperties: false };
}
function buildArguments(spec, input) {
  const raw = input[spec.textParam];
  const text = typeof raw === "string" ? raw.trim() : "";
  if (text === "") throw new InputError("\u68C0\u7D22\u5185\u5BB9\u4E0D\u80FD\u4E3A\u7A7A\u3002");
  if (text.length > MAX_TEXT) throw new InputError(`\u68C0\u7D22\u5185\u5BB9\u8FC7\u957F\uFF0C\u8BF7\u7F29\u77ED\u5230 ${MAX_TEXT} \u5B57\u4EE5\u5185\u3002`);
  const args = { [spec.textParam]: text, output_format: "text" };
  for (const [name, label] of Object.entries(spec.dateParams ?? {})) {
    const value = input[name];
    if (value === void 0 || value === null || value === "" || value === ANY_DATE) {
      args[name] = ANY_DATE;
      continue;
    }
    if (typeof value !== "string" || !DATE_PATTERN.test(value.trim())) {
      throw new InputError(`${label}\u683C\u5F0F\u4E0D\u5BF9\uFF0C\u5E94\u4E3A YYYY.MM.DD\uFF0C\u4F8B\u5982 2024.01.31\u3002`);
    }
    args[name] = value.trim();
  }
  return args;
}

// src/wk.ts
var WK_ENDPOINT = "https://mcp.wkinfo.com.cn/mcp-servers/integrated/";
var PROTOCOL_VERSION = "2025-03-26";
var MAX_ERROR_TEXT = 300;
var KIND_MESSAGE = {
  unauthorized: "\u5A01\u79D1\u5148\u884C\u6388\u6743\u7801\u65E0\u6548\u6216\u5DF2\u8FC7\u671F\uFF1A\u8BF7\u5728 \u8BBE\u7F6E\u2192\u63D2\u4EF6\u2192\u5A01\u79D1\u5148\u884C \u91CD\u65B0\u586B\u5199\u3002",
  forbidden: "\u4F60\u7684\u5A01\u79D1\u5148\u884C\u8D26\u53F7\u6CA1\u6709\u8FD9\u9879\u68C0\u7D22\u7684\u6743\u9650\uFF0C\u8BF7\u8054\u7CFB\u5A01\u79D1\u5148\u884C\u786E\u8BA4\u5F00\u901A\u8303\u56F4\u3002",
  "rate-limited": "\u5A01\u79D1\u5148\u884C\u7684\u8C03\u7528\u6B21\u6570\u6216\u9891\u7387\u5DF2\u8FBE\u4E0A\u9650\uFF0C\u8BF7\u7A0D\u540E\u518D\u8BD5\uFF0C\u6216\u8054\u7CFB\u5A01\u79D1\u5148\u884C\u786E\u8BA4\u5269\u4F59\u6B21\u6570\u3002",
  unavailable: "\u6682\u65F6\u65E0\u6CD5\u8FDE\u63A5\u5A01\u79D1\u5148\u884C\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002",
  "invalid-response": "\u5A01\u79D1\u5148\u884C\u8FD4\u56DE\u4E86\u65E0\u6CD5\u8BC6\u522B\u7684\u5185\u5BB9\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002"
};
var WkError = class extends Error {
  kind;
  constructor(kind, detail) {
    super(kind === "rejected" ? `\u5A01\u79D1\u5148\u884C\u672A\u5B8C\u6210\u8FD9\u6B21\u68C0\u7D22\uFF1A${detail ?? "\u672A\u8BF4\u660E\u539F\u56E0"}` : KIND_MESSAGE[kind]);
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
function parseBody(body) {
  try {
    return JSON.parse(body);
  } catch {
    const lines = body.split(/\r?\n/).filter((line) => line.startsWith("data:"));
    const last = lines[lines.length - 1];
    if (last === void 0) throw new WkError("invalid-response");
    try {
      return JSON.parse(last.slice(5).trim());
    } catch {
      throw new WkError("invalid-response");
    }
  }
}
function readResult(reply) {
  if (typeof reply?.status !== "number" || typeof reply?.body !== "string") throw new WkError("invalid-response");
  if (reply.status === 401) throw new WkError("unauthorized");
  if (reply.status === 403) throw new WkError("forbidden");
  if (reply.status === 429) throw new WkError("rate-limited");
  if (reply.status < 200 || reply.status >= 300) throw new WkError("unavailable");
  const envelope = parseBody(reply.body);
  if (!isRecord(envelope)) throw new WkError("invalid-response");
  if (isRecord(envelope.error)) {
    const message = typeof envelope.error.message === "string" ? envelope.error.message : "";
    throw new WkError("rejected", clip(message) || void 0);
  }
  if (!isRecord(envelope.result)) throw new WkError("invalid-response");
  return envelope.result;
}
function textOf(result) {
  if (!Array.isArray(result.content)) throw new WkError("invalid-response");
  const parts = result.content.filter((item) => isRecord(item) && item.type === "text" && typeof item.text === "string").map((item) => item.text);
  return parts.join("\n").trim();
}
async function send(transport, message) {
  let reply;
  try {
    reply = await transport({ jsonrpc: "2.0", id: 1, ...message });
  } catch {
    throw new WkError("unavailable");
  }
  return readResult(reply);
}
async function callTool(transport, name, args) {
  const result = await send(transport, { method: "tools/call", params: { name, arguments: args } });
  const text = textOf(result);
  if (result.isError === true) throw new WkError("rejected", clip(text) || void 0);
  if (text === "") throw new WkError("invalid-response");
  return text;
}
async function checkConnection(transport) {
  const result = await send(transport, {
    method: "initialize",
    params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "lawyer-copilot", version: "0.1.0" } }
  });
  const info = result.serverInfo;
  if (!isRecord(info) || typeof info.name !== "string") throw new WkError("invalid-response");
  return info.name;
}

// src/index.ts
var TOKEN_KEY = "wk-token";
var SETTINGS_KEY = "lawyer-wk";
var NOT_CONFIGURED = "\u8FD8\u6CA1\u6709\u586B\u5199\u5A01\u79D1\u5148\u884C\u6388\u6743\u7801\uFF1A\u8BF7\u5728 \u8BBE\u7F6E\u2192\u63D2\u4EF6\u2192\u5A01\u79D1\u5148\u884C \u7C98\u8D34\u4F60\u81EA\u5DF1\u7684\u6388\u6743\u7801\u540E\u518D\u68C0\u7D22\u3002";
function messageOf2(error) {
  return error instanceof Error ? error.message : String(error);
}
function textResult(text) {
  return { content: [{ type: "text", text }] };
}
function activate(ctx) {
  function transport(token) {
    return (message) => ctx.bridge.invoke("plugin_http_request", {
      method: "POST",
      url: WK_ENDPOINT,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream"
      },
      body: JSON.stringify(message)
    });
  }
  async function loadToken() {
    const raw = await ctx.storage.get(TOKEN_KEY);
    return typeof raw === "string" ? raw.trim() : "";
  }
  const account = {
    loadToken,
    async saveToken(input) {
      const token = normalizeToken(input);
      await ctx.storage.set(TOKEN_KEY, token);
      return token;
    },
    clearToken: () => ctx.storage.delete(TOKEN_KEY),
    async check() {
      const token = await loadToken();
      if (!token) throw new Error(NOT_CONFIGURED);
      return checkConnection(transport(token));
    }
  };
  const disposers = TOOL_SPECS.map(
    (spec) => ctx.tools.register({
      name: spec.name,
      description: spec.description,
      inputSchema: inputSchemaOf(spec),
      async execute(input) {
        try {
          const args = buildArguments(spec, input);
          const token = await loadToken();
          if (!token) return textResult(NOT_CONFIGURED);
          return textResult(await callTool(transport(token), spec.name, args));
        } catch (error) {
          const prefix = error instanceof InputError ? "\u68C0\u7D22\u672A\u53D1\u51FA\uFF1A" : "";
          return { content: [{ type: "text", text: `${prefix}${messageOf2(error)}` }], isError: true };
        }
      }
    })
  );
  disposers.push(
    ctx.ui.registerSettingsSection({
      key: SETTINGS_KEY,
      label: () => "\u5A01\u79D1\u5148\u884C",
      component: createSettingsPanel(ctx, account)
    })
  );
  return () => {
    for (const dispose of disposers.splice(0)) dispose();
  };
}
export {
  activate as default
};
