// src/logic.ts
var DEFAULT_SETTINGS = { enabled: true, sound: false, scope: "all" };
var SETTINGS_KEY = "settings";
var LAST_KEY = "last-notify";
function parseSettings(raw) {
  if (raw === null || typeof raw !== "object") return { ...DEFAULT_SETTINGS };
  const value = raw;
  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : DEFAULT_SETTINGS.enabled,
    sound: typeof value.sound === "boolean" ? value.sound : DEFAULT_SETTINGS.sound,
    scope: value.scope === "background" ? "background" : "all"
  };
}
function parseDoneEvent(raw) {
  if (raw === null || typeof raw !== "object") return { sessionId: null };
  const sessionId = raw.sessionId;
  return { sessionId: typeof sessionId === "string" && sessionId !== "" ? sessionId : null };
}
function shouldNotify(settings, activeSessionId, done) {
  if (!settings.enabled) return false;
  if (settings.scope === "background") {
    if (done.sessionId !== null && done.sessionId === activeSessionId) return false;
  }
  return true;
}
function isSelfFrontmost(frontmostPath) {
  return /\/LawyerCopilot\.app\b/.test(frontmostPath.trim());
}
function notificationText(count, includesActiveSession) {
  if (count > 1) return { title: "LawyerCopilot", body: `${count} \u4E2A\u4EFB\u52A1\u5DF2\u5B8C\u6210` };
  if (includesActiveSession) return { title: "LawyerCopilot", body: "\u5F53\u524D\u5BF9\u8BDD\u5DF2\u56DE\u590D\u5B8C\u6210" };
  return { title: "LawyerCopilot", body: "\u540E\u53F0\u4EFB\u52A1\u5DF2\u5B8C\u6210" };
}
function applescriptString(value) {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
function frontmostCheckScript() {
  return "POSIX path of (path to frontmost application)";
}
function notifyScript(input) {
  const sound = input.sound ? ' sound name "default"' : "";
  return `display notification ${applescriptString(input.body)} with title ${applescriptString("LawyerCopilot")}${sound}`;
}
function createAggregator(windowMs, flush) {
  let count = 0;
  let includesActive = false;
  let timer = null;
  return {
    push(done, isActive) {
      void done;
      count += 1;
      if (isActive) includesActive = true;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        const burstCount = count;
        const burstActive = includesActive;
        count = 0;
        includesActive = false;
        flush(burstCount, burstActive);
      }, windowMs);
    },
    dispose() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    }
  };
}

// src/settings-panel.ts
var ROW = "flex items-center justify-between gap-3 px-1 py-2";
var LABEL = "text-body-medium text-text-primary";
var HINT = "text-body-medium text-text-tertiary";
var BUTTON = "cursor-pointer whitespace-nowrap rounded-lg bg-background-secondary-default px-3 py-1.5 text-body-2-medium text-text-primary transition-colors hover:bg-background-secondary-hover disabled:cursor-wait disabled:opacity-60";
function createNotifySettingsPanel(ctx, api) {
  const { createElement: el, useState, useEffect } = ctx.react;
  async function persist(next) {
    await ctx.storage.set(SETTINGS_KEY, next);
  }
  return function NotifySettingsPanel() {
    const [settings, setSettings] = useState({ ...DEFAULT_SETTINGS });
    const [testing, setTesting] = useState(false);
    const [notice, setNotice] = useState("");
    useEffect(() => {
      void api.readSettings().then(setSettings);
    }, []);
    async function update(patch) {
      const next = { ...settings, ...patch };
      setSettings(next);
      await persist(next);
    }
    return el(
      "div",
      { className: "flex w-full flex-col gap-2" },
      el(
        "p",
        { className: HINT },
        "\u4EFB\u52A1\u5B8C\u6210\u65F6\u5F39 macOS \u7CFB\u7EDF\u901A\u77E5\uFF1B\u6B63\u5728\u4F7F\u7528 LawyerCopilot \u65F6\u4E0D\u6253\u6270\u3002"
      ),
      el(
        "div",
        { className: ROW },
        el("span", { className: LABEL }, "\u4EFB\u52A1\u5B8C\u6210\u901A\u77E5"),
        el(
          "button",
          {
            type: "button",
            className: BUTTON,
            onClick: () => void update({ enabled: !settings.enabled })
          },
          settings.enabled ? "\u5DF2\u5F00\u542F" : "\u5DF2\u5173\u95ED"
        )
      ),
      el(
        "div",
        { className: ROW },
        el("span", { className: LABEL }, "\u63D0\u793A\u97F3"),
        el(
          "button",
          {
            type: "button",
            className: BUTTON,
            onClick: () => void update({ sound: !settings.sound })
          },
          settings.sound ? "\u5F00\u542F" : "\u5173\u95ED"
        )
      ),
      el(
        "div",
        { className: ROW },
        el("span", { className: LABEL }, "\u63D0\u9192\u8303\u56F4"),
        el(
          "button",
          {
            type: "button",
            className: BUTTON,
            onClick: () => void update({ scope: settings.scope === "all" ? "background" : "all" })
          },
          settings.scope === "all" ? "\u5168\u90E8\u5B8C\u6210" : "\u4EC5\u540E\u53F0\u4EFB\u52A1"
        )
      ),
      el(
        "div",
        { className: ROW },
        el("span", { className: LABEL }, "\u8BD5\u4E00\u8BD5"),
        el(
          "button",
          {
            type: "button",
            className: BUTTON,
            disabled: testing,
            onClick: () => {
              setTesting(true);
              setNotice("");
              void api.sendTestNotification().then(() => setNotice("\u5DF2\u53D1\u9001\u6D4B\u8BD5\u901A\u77E5\uFF0C\u8BF7\u770B\u5C4F\u5E55\u53F3\u4E0A\u89D2\u3002")).catch((error) => setNotice(`\u53D1\u9001\u5931\u8D25\uFF1A${String(error)}`)).finally(() => setTesting(false));
            }
          },
          testing ? "\u53D1\u9001\u4E2D\u2026" : "\u53D1\u4E00\u6761\u6D4B\u8BD5\u901A\u77E5"
        )
      ),
      notice ? el("p", { className: HINT }, notice) : null
    );
  };
}

// src/index.ts
var AGGREGATE_WINDOW_MS = 2e3;
var OSA_TIMEOUT_MS = 1e4;
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}
function activate(ctx, options = {}) {
  const disposers = [];
  let activeSessionId = null;
  async function runOsascript(script) {
    return await ctx.bridge.invoke("plugin_exec_run", {
      bin: "osascript",
      args: ["-l", "AppleScript", "-e", script],
      timeoutMs: OSA_TIMEOUT_MS
    });
  }
  async function readSettings() {
    try {
      return parseSettings(await ctx.storage.get(SETTINGS_KEY));
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }
  async function record(entry) {
    try {
      await ctx.storage.set(LAST_KEY, entry);
    } catch {
    }
  }
  async function sendTestNotification() {
    const settings = await readSettings();
    await fireNotification(notificationText(1, true), settings.sound);
  }
  async function fireNotification(text, sound) {
    const result = await runOsascript(notifyScript({ body: text.body, sound }));
    if (result.code !== 0) {
      await record({ at: Date.now(), outcome: "error", detail: messageOf(result.stderr) });
      return;
    }
    await record({ at: Date.now(), outcome: "notified", count: 1, body: text.body });
  }
  const aggregator = createAggregator(options.aggregateWindowMs ?? AGGREGATE_WINDOW_MS, (count, includesActiveSession) => {
    void (async () => {
      try {
        const settings = await readSettings();
        if (!settings.enabled) return;
        const front = await runOsascript(frontmostCheckScript());
        if (front.code === 0 && isSelfFrontmost(front.stdout)) {
          await record({ at: Date.now(), outcome: "suppressed-frontmost", count });
          return;
        }
        const text = notificationText(count, includesActiveSession);
        const notify = await runOsascript(notifyScript({ body: text.body, sound: settings.sound }));
        if (notify.code !== 0) {
          await record({ at: Date.now(), outcome: "error", count, detail: messageOf(notify.stderr) });
          return;
        }
        await record({ at: Date.now(), outcome: "notified", count, body: text.body });
      } catch (error) {
        await record({ at: Date.now(), outcome: "error", detail: messageOf(error) });
      }
    })();
  });
  disposers.push(
    ctx.events.on("session://activated", (data) => {
      const sessionId = data?.sessionId;
      activeSessionId = typeof sessionId === "string" && sessionId !== "" ? sessionId : null;
    })
  );
  disposers.push(
    ctx.events.on("usage://done", (data) => {
      void (async () => {
        const done = parseDoneEvent(data);
        const settings = await readSettings();
        if (!shouldNotify(settings, activeSessionId, done)) {
          await record({ at: Date.now(), outcome: "filtered" });
          return;
        }
        aggregator.push(done, done.sessionId !== null && done.sessionId === activeSessionId);
      })();
    })
  );
  disposers.push(
    ctx.ui.registerSettingsSection({
      key: "lawyer-notify",
      label: () => "\u4EFB\u52A1\u63D0\u9192",
      component: createNotifySettingsPanel(ctx, {
        readSettings,
        sendTestNotification
      })
    })
  );
  return () => {
    aggregator.dispose();
    for (const dispose of disposers.splice(0)) dispose();
  };
}
export {
  activate as default
};
