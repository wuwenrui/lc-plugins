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

// src/index.ts
var STORAGE_KEY = "records";
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
    })
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
        const items = await api.list(status);
        return textResult(renderList(status, items));
      }
    })
  );
  disposers.push(
    ctx.tools.register({
      name: "memos_create",
      description: "\u65B0\u5EFA\u4E00\u6761\u5907\u5FD8\uFF08\u5F85\u529E\uFF09\u3002\u9002\u5408\u5728\u5BF9\u8BDD\u4E2D\u8BB0\u5F55\u5F85\u529E\u4E8B\u9879\u3001\u671F\u9650\u6216\u540E\u7EED\u52A8\u4F5C\uFF1B\u7EAF\u8FFD\u52A0\uFF0C\u4E0D\u5F71\u54CD\u5DF2\u6709\u5907\u5FD8\u3002",
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
        const item = await api.create(input.text);
        return textResult(`\u5DF2\u521B\u5EFA\u5907\u5FD8 #${item.id}\uFF1A${item.text}`);
      }
    })
  );
  disposers.push(
    ctx.tools.register({
      name: "memos_complete",
      description: "\u628A\u4E00\u6761\u5907\u5FD8\u6807\u8BB0\u4E3A\u5DF2\u5B8C\u6210\u3002id \u6765\u81EA memos_list \u8FD4\u56DE\u7684\u7F16\u53F7\uFF1B\u91CD\u590D\u5B8C\u6210\u662F\u5B89\u5168\u7684\uFF0C\u4E0D\u4F1A\u5220\u9664\u4EFB\u4F55\u6570\u636E\u3002",
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
        const outcome = await api.complete(input.id);
        return textResult(
          outcome.alreadyDone ? `\u5907\u5FD8 #${outcome.item.id} \u6B64\u524D\u5DF2\u5B8C\u6210\uFF0C\u4FDD\u6301\u4E0D\u53D8\uFF1A${outcome.item.text}` : `\u5DF2\u5B8C\u6210\u5907\u5FD8 #${outcome.item.id}\uFF1A${outcome.item.text}`
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
function createSettingsPanel(ctx, api) {
  const { createElement, useState, useEffect } = ctx.react;
  return function MemosSettingsPanel() {
    const [items, setItems] = useState([]);
    const [draft, setDraft] = useState("");
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);
    useEffect(() => {
      void api.all().then((loaded) => setItems(loaded)).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
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
      });
    }
    const open = items.filter((item) => !item.done).sort((a, b) => b.id - a.id);
    const done = items.filter((item) => item.done).sort((a, b) => b.id - a.id);
    const ordered = [...open, ...done];
    return createElement(
      "div",
      { className: "flex flex-col gap-3 p-4" },
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
