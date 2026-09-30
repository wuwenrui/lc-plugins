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
  if (raw === null || typeof raw !== "object") return { sessionId: null, runId: null };
  const { sessionId, runId } = raw;
  return {
    sessionId: typeof sessionId === "string" && sessionId !== "" ? sessionId : null,
    runId: typeof runId === "string" && runId.trim() !== "" ? runId : null
  };
}
function shouldNotify(settings, activeSessionId, done) {
  if (!settings.enabled) return false;
  if (settings.scope === "background") {
    if (done.sessionId !== null && done.sessionId === activeSessionId) return false;
  }
  return true;
}
function isSelfFrontmost(frontmostPath) {
  const path = frontmostPath.trim();
  return /\/LawyerCopilot\.app\b/.test(path) || /\/ccgui-next$/.test(path);
}
function notificationText(count, includesActiveSession) {
  if (count > 1) return { title: "LawyerCopilot", body: `${count} \u4E2A\u4EFB\u52A1\u5DF2\u5B8C\u6210` };
  if (includesActiveSession) return { title: "LawyerCopilot", body: "\u5F53\u524D\u5BF9\u8BDD\u5DF2\u56DE\u590D\u5B8C\u6210" };
  return { title: "LawyerCopilot", body: "\u540E\u53F0\u4EFB\u52A1\u5DF2\u5B8C\u6210" };
}
function frontmostCheckScript() {
  return "POSIX path of (path to frontmost application)";
}
function createAggregator(windowMs, flush) {
  let count = 0;
  let includesActive = false;
  let runId = null;
  let timer = null;
  return {
    push(done, isActive) {
      count += 1;
      runId = count === 1 ? done.runId : null;
      if (isActive) includesActive = true;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        const burstCount = count;
        const burstActive = includesActive;
        const burstRunId = runId;
        count = 0;
        includesActive = false;
        runId = null;
        flush(burstCount, burstActive, burstRunId);
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

// src/badge.ts
function createBadgeStore() {
  let state = { count: 0, lastAt: null };
  const listeners = /* @__PURE__ */ new Set();
  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** 任务完成：计数 +1，通知订阅者 */
    increment() {
      state = { count: state.count + 1, lastAt: Date.now() };
      for (const listener of listeners) listener();
    },
    /** 点击清除 */
    clear() {
      state = { count: 0, lastAt: null };
      for (const listener of listeners) listener();
    }
  };
}
function badgeText(count) {
  if (count === 0) return "";
  return count === 1 ? "\u{1F514} 1 \u4E2A\u5B8C\u6210" : `\u{1F514} ${count} \u4E2A\u5B8C\u6210`;
}
function createBadgePill(ctx, store) {
  const { createElement: el, useState, useEffect } = ctx.react;
  return function NotifyBadgePill() {
    const [, forceUpdate] = useState(0);
    useEffect(() => {
      const off = store.subscribe(() => forceUpdate((n) => n + 1));
      return off;
    }, []);
    const state = store.getState();
    if (state.count === 0) return null;
    return el(
      "button",
      {
        type: "button",
        title: `${badgeText(state.count)} \xB7 \u70B9\u51FB\u6E05\u9664`,
        "aria-label": `${badgeText(state.count)}\uFF0C\u70B9\u51FB\u6E05\u9664`,
        className: "rounded-full bg-accent-500 text-caption-2-medium text-white transition-opacity hover:opacity-90",
        style: { padding: "2px 10px", whiteSpace: "nowrap" },
        onClick: () => store.clear()
      },
      badgeText(state.count)
    );
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
        "\u4EFB\u52A1\u5B8C\u6210\u65F6\u8BF7\u6C42\u7CFB\u7EDF\u63D0\u9192\uFF1B\u6B63\u5728\u4F7F\u7528 LawyerCopilot \u65F6\u4E0D\u6253\u6270\u3002\u7CFB\u7EDF\u662F\u5426\u5C55\u793A\u53D6\u51B3\u4E8E\u901A\u77E5\u8BBE\u7F6E\u3002"
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
              void api.sendTestNotification().then(() => setNotice("\u901A\u77E5\u8BF7\u6C42\u5DF2\u53D1\u9001\uFF1B\u662F\u5426\u663E\u793A\u53D6\u51B3\u4E8E\u7CFB\u7EDF\u901A\u77E5\u8BBE\u7F6E\u3002")).catch((error) => setNotice(`\u8BF7\u6C42\u5931\u8D25\uFF1A${error instanceof Error ? error.message : String(error)}`)).finally(() => setTesting(false));
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
var SOUND_FILE = "/System/Library/Sounds/Glass.aiff";
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}
function activate(ctx, options = {}) {
  const disposers = [];
  let activeSessionId = null;
  const badge = createBadgeStore();
  async function runOsascript(script) {
    return await ctx.bridge.invoke("plugin_exec_run", {
      bin: "osascript",
      args: ["-l", "AppleScript", "-e", script],
      timeoutMs: OSA_TIMEOUT_MS
    });
  }
  async function playSound() {
    try {
      await ctx.bridge.invoke("plugin_exec_run", {
        bin: "osascript",
        args: ["-l", "AppleScript", "-e", `do shell script "afplay ${SOUND_FILE} &> /dev/null &"`],
        timeoutMs: 5e3
      });
    } catch {
    }
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
  function requestNativeNotification(title, body, runId) {
    ctx.events.emit("plugin:lawyer-notify:request", { title, body, ...runId ? { runId } : {} });
  }
  async function sendTestNotification() {
    const settings = await readSettings();
    badge.increment();
    if (settings.sound) await playSound();
    const body = "\u5F53\u524D\u5BF9\u8BDD\u5DF2\u56DE\u590D\u5B8C\u6210";
    try {
      requestNativeNotification("LawyerCopilot", body);
      await record({ at: Date.now(), outcome: "requested", count: 1, body });
    } catch (error) {
      await record({ at: Date.now(), outcome: "error", detail: messageOf(error) });
      throw error;
    }
  }
  const aggregator = createAggregator(options.aggregateWindowMs ?? AGGREGATE_WINDOW_MS, (count, includesActiveSession, runId) => {
    void (async () => {
      try {
        const settings = await readSettings();
        if (!settings.enabled) return;
        badge.increment();
        const front = await runOsascript(frontmostCheckScript());
        const selfFront = front.code === 0 && isSelfFrontmost(front.stdout);
        if (selfFront) {
          await record({ at: Date.now(), outcome: "suppressed-frontmost", count });
          return;
        }
        if (settings.sound) await playSound();
        const text = notificationText(count, includesActiveSession);
        requestNativeNotification(text.title, text.body, count === 1 ? runId : null);
        await record({ at: Date.now(), outcome: "requested", count, body: text.body });
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
  disposers.push(
    ctx.ui.registerStatusBarItem({
      key: "lawyer-notify-badge",
      zone: "end",
      component: createBadgePill(ctx, badge)
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
