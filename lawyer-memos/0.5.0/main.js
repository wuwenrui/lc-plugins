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
function createMemosNotebook(ctx, api) {
  const { createElement: el } = ctx.react;
  const NotesPanel = createNotesPanel(ctx, api);
  return function MemosNotebook(props) {
    return el(
      "div",
      { className: "flex h-full min-h-0 flex-col" },
      el("div", { className: "min-h-0 flex-1" }, el(NotesPanel, props))
    );
  };
}

// src/index.ts
function activate(ctx) {
  const disposers = [];
  if (typeof ctx.ui.registerPanelTab === "function") {
    disposers.push(
      ctx.ui.registerPanelTab({
        key: "lawyer-memos",
        label: () => "\u5907\u5FD8",
        component: createMemosNotebook(ctx, createNotesApi(ctx.bridge))
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
