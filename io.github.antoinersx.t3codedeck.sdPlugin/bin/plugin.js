// T3 Code Deck: your T3 Code threads, models and usage on a Stream Deck+.
// Raw Stream Deck SDK v2 protocol, plain Node, one dependency (ws). No build step.
//
// Layout (from the bundled profile; keys place themselves by position):
//   top row    : your pinned threads (T3 Code's own pins)
//   bottom row : other active threads, the ones that need you first
//   knob 1     : threads   turn = select, press/tap = open, hold strip = pin/unpin
//   knob 2     : model     turn = pick a favourite, press/tap = switch the selected thread
//   knob 3     : effort    turn = set effort, press/tap = fast mode on/off
//   knob 4     : usage     turn = overview / Claude / Codex / Gemini, press/tap = refresh

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const WebSocket = require("ws");
const { T3Client, readFavorites, STORE_DIR, loadStore, saveStore } = require("./t3");
const R = require("./render");

const PLUGIN = "io.github.antoinersx.t3codedeck";
const A = {
  thread: `${PLUGIN}.thread`,
  threads: `${PLUGIN}.threads`,
  model: `${PLUGIN}.model`,
  effort: `${PLUGIN}.effort`,
  usage: `${PLUGIN}.usage`,
};
const DIAL_SLOT = { [A.threads]: 0, [A.model]: 1, [A.effort]: 2, [A.usage]: 3 };
const HOLD_MS = 1000;
const POLL_MS = 2000;
const USAGE_MS = 3 * 60000;
const ALERT_MS = 8000;
const TOAST_MS = 2600;
const EFFORT_IDS = ["effort", "reasoningEffort", "thought_level", "thinkingLevel", "reasoning"];

// ---------- logging ----------

const LOG_FILE = path.join(STORE_DIR, "plugin.log");
function log(...args) {
  try {
    fs.mkdirSync(STORE_DIR, { recursive: true });
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 1024 * 1024) fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${args.map((a) => (a instanceof Error ? a.message : typeof a === "string" ? a : JSON.stringify(a))).join(" ")}\n`);
  } catch {}
}
process.on("uncaughtException", (e) => log("uncaught", e.stack || e));
process.on("unhandledRejection", (e) => log("unhandled", e?.stack || e));

// ---------- Stream Deck connection ----------

const arg = (k) => process.argv[process.argv.indexOf(k) + 1];
const sd = new WebSocket(`ws://127.0.0.1:${arg("-port")}`);
const send = (msg) => sd.readyState === WebSocket.OPEN && sd.send(JSON.stringify(msg));
sd.on("open", () => send({ event: arg("-registerEvent"), uuid: arg("-pluginUUID") }));
sd.on("close", () => process.exit(0));

/** context -> { action, device, column, row } */
const contexts = new Map();
const lastDrawn = new Map();

function draw(context, image) {
  if (lastDrawn.get(context) === image) return;
  lastDrawn.set(context, image);
  const c = contexts.get(context);
  if (!c) return;
  if (c.action === A.thread) send({ event: "setImage", context, payload: { image: R.dataUrl(image), target: 0 } });
  else send({ event: "setFeedback", context, payload: { "full-canvas": R.dataUrl(image) } });
}

// ---------- state ----------

const t3 = new T3Client(log);
const S = {
  online: false,
  offline: { title: "Connecting…", sub: "" },
  threads: [],
  pinned: [],
  live: [],
  projects: new Map(),
  selectedId: undefined,
  cfg: undefined, // selected thread's { instanceId, model, options:[{id,value}] }
  cfgFor: undefined,
  favorites: [],
  modelIdx: undefined,
  pendingEffort: undefined,
  usage: undefined,
  usageError: undefined,
  usageLoading: true,
  usageView: 0,
  alert: undefined, // { threadId, title, count, until }
  toasts: {}, // dial slot or key context -> { text, until }
  holds: new Map(), // key context -> { start, timer }
  busy: {},
  prevStatus: new Map(),
  workingSince: new Map(),
  firstPoll: true,
};
const catalog = new Map(); // "instanceId/model" -> { label, options }

const ordered = () => [...S.pinned, ...S.live];
const selected = () => ordered().find((t) => t.threadId === S.selectedId);

function toast(slot, text) {
  S.toasts[slot] = { text, until: Date.now() + TOAST_MS };
  setTimeout(render, TOAST_MS + 20);
  render();
}
const activeToast = (slot) => (S.toasts[slot] && S.toasts[slot].until > Date.now() ? S.toasts[slot].text : undefined);

// ---------- model catalog ----------

function prettyModel(id) {
  return String(id || "")
    .replace(/^claude-/, "")
    .split("-")
    .map((p, i, all) => (/^\d/.test(p) && /^\d/.test(all[i + 1] || "") ? `${p}.` : `${p} `))
    .join("")
    .replace(/\. /g, ".")
    .replace(/\b(gpt)\b/i, "GPT")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/GPT (\d)/, "GPT-$1")
    .trim();
}

function ingestCapabilities(caps) {
  for (const p of caps?.providers || []) {
    for (const m of p.models || []) {
      catalog.set(`${p.providerInstanceId}/${m.id}`, { label: m.label || prettyModel(m.id), options: m.options || [] });
    }
  }
}

async function ensureCatalog(instanceId, model) {
  const key = `${instanceId}/${model}`;
  if (catalog.has(key)) return catalog.get(key);
  try {
    ingestCapabilities(await t3.call("orchestrator_capabilities", { search: model }));
  } catch (e) {
    log("capabilities", e);
  }
  if (!catalog.has(key)) catalog.set(key, { label: prettyModel(model), options: [] });
  return catalog.get(key);
}

const modelLabel = (instanceId, model) => {
  const c = catalog.get(`${instanceId}/${model}`)?.label || prettyModel(model);
  return c.replace(/^Claude /, "");
};

function effortOption(options) {
  return options.find((o) => EFFORT_IDS.includes(o.id)) || options.find((o) => Array.isArray(o.values) && o.values.includes("low") && o.values.includes("high"));
}
function fastOption(options) {
  const fm = options.find((o) => o.id === "fastMode");
  if (fm) return { id: "fastMode", on: true, off: false };
  const tier = options.find((o) => o.id === "serviceTier" && Array.isArray(o.values) && o.values.includes("priority"));
  if (tier) return { id: "serviceTier", on: "priority", off: "default" };
  return undefined;
}

// ---------- polling T3 ----------

async function pollThreads() {
  try {
    const res = await t3.call("t3_thread_list", { allProjects: true, includeSubagents: false, limit: 100 });
    const all = (res.threads || []).filter((t) => !t.parentThreadId);
    const now = Date.now();

    // Alert when a thread starts needing you.
    const newlyWaiting = [];
    for (const t of all) {
      const prev = S.prevStatus.get(t.threadId);
      if (t.status === "waiting" && prev !== "waiting" && !S.firstPoll) newlyWaiting.push(t);
      if (["running", "starting", "preparing", "queued"].includes(t.status)) {
        if (!S.workingSince.has(t.threadId)) S.workingSince.set(t.threadId, S.firstPoll ? Date.parse(t.updatedAt) : now);
      } else S.workingSince.delete(t.threadId);
      S.prevStatus.set(t.threadId, t.status);
    }

    const rank = (t) => ({ waiting: 0, running: 1, starting: 1, preparing: 1, queued: 1, failed: 2 })[t.status] ?? 3;
    S.pinned = all.filter((t) => t.pinned).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    S.live = all
      .filter((t) => !t.pinned && !t.settled && !t.snoozed)
      .sort((a, b) => rank(a) - rank(b) || String(b.updatedAt).localeCompare(String(a.updatedAt)));
    S.threads = all;

    if (newlyWaiting.length) {
      const waitingCount = all.filter((t) => t.status === "waiting").length;
      S.alert = { threadId: newlyWaiting[0].threadId, title: newlyWaiting[0].title, count: waitingCount, until: now + ALERT_MS };
      setTimeout(render, ALERT_MS + 20);
    }

    if (!selected()) {
      const pick = ordered().find((t) => t.status === "waiting") || ordered()[0];
      select(pick?.threadId);
    }
    for (const t of ordered().slice(0, 12)) if (!catalog.has(`${t.providerInstanceId}/${t.model}`)) ensureCatalog(t.providerInstanceId, t.model).then(render);
    S.online = true;
    S.firstPoll = false;
  } catch (e) {
    S.online = false;
    S.offline = e.code === "t3_closed" ? { title: "T3 Code is closed", sub: "Press any key to open it" } : { title: "Can't reach T3 Code", sub: e.message };
    if (e.code !== "t3_closed") log("poll", e);
  }
  render();
}

async function pollProjects() {
  try {
    const res = await t3.call("t3_project_list", {});
    for (const p of res.projects || []) S.projects.set(p.id, p.title);
  } catch (e) {
    if (e.code !== "t3_closed") log("projects", e);
  }
}

async function pollUsage() {
  S.usageLoading = !S.usage;
  render();
  try {
    S.usage = await t3.fetchUsage();
    S.usageError = undefined;
  } catch (e) {
    S.usageError = e.message;
    if (e.code !== "t3_closed") log("usage", e);
  }
  S.usageLoading = false;
  render();
}

function pollFavorites() {
  const favs = readFavorites();
  if (JSON.stringify(favs) !== JSON.stringify(S.favorites)) {
    S.favorites = favs;
    for (const f of favs) ensureCatalog(f.instanceId, f.model).then(render);
    syncModelIdx();
  }
}

async function refreshCfg() {
  const t = selected();
  if (!t) {
    S.cfg = undefined;
    S.cfgFor = undefined;
    return render();
  }
  const id = t.threadId;
  try {
    const res = await t3.call("t3_thread_configure", { threadId: id });
    if (S.selectedId !== id) return;
    const ms = res.modelSelection || {};
    S.cfg = { instanceId: ms.instanceId || t.providerInstanceId, model: ms.model || t.model, options: Array.isArray(ms.options) ? ms.options : [] };
    S.cfgFor = id;
    await ensureCatalog(S.cfg.instanceId, S.cfg.model);
    if (S.pendingEffort === undefined) syncModelIdx();
  } catch (e) {
    log("configure read", e);
  }
  render();
}

function syncModelIdx() {
  const cur = S.cfg || (selected() && { instanceId: selected().providerInstanceId, model: selected().model });
  const i = cur ? S.favorites.findIndex((f) => f.instanceId === cur.instanceId && f.model === cur.model) : -1;
  S.modelIdx = i >= 0 ? i : S.favorites.length ? 0 : undefined;
}

function select(threadId) {
  if (S.selectedId === threadId) return;
  S.selectedId = threadId;
  S.cfg = undefined;
  S.cfgFor = undefined;
  S.pendingEffort = undefined;
  syncModelIdx();
  refreshCfg();
}

// ---------- actions ----------

function openInT3(thread) {
  if (!thread) return;
  // The thread link is https://app.t3.codes/threads/<environment>/<thread>; the desktop app opens the same path.
  let p;
  try {
    p = new URL(thread.link).pathname.replace(/^\/threads\//, "");
  } catch {}
  const url = p ? `t3code://threads/${p}` : "t3code://app";
  execFile("open", [url], (err) => err && log("open", err));
}

function openT3App() {
  execFile("open", ["-b", "com.t3tools.t3code"], (err) => err && log("open app", err));
}

async function interrupt(thread, keyContext) {
  try {
    await t3.call("t3_thread_interrupt", { threadId: thread.threadId, reason: "Stopped from Stream Deck" });
    toast(keyContext, "Stopped");
  } catch (e) {
    toast(keyContext, `Couldn't stop: ${e.message}`);
  }
  pollThreads();
}

async function togglePin() {
  const t = selected();
  if (!t) return;
  try {
    await t3.call("t3_thread_organize", { threadId: t.threadId, action: t.pinned ? "unpin" : "pin" });
    toast(0, t.pinned ? "Unpinned" : "Pinned to the top row");
  } catch (e) {
    toast(0, `Couldn't ${t.pinned ? "unpin" : "pin"}: ${e.message}`);
  }
  pollThreads();
}

async function applyModel() {
  const t = selected();
  const fav = S.favorites[S.modelIdx];
  if (!t || !fav) return;
  if (S.cfg && S.cfg.instanceId === fav.instanceId && S.cfg.model === fav.model) return toast(1, `Already on ${modelLabel(fav.instanceId, fav.model)}`);
  S.busy.model = true;
  render();
  try {
    const target = await ensureCatalog(fav.instanceId, fav.model);
    const curOpts = S.cfg?.options || [];
    const curEffort = effortOption(catalog.get(`${S.cfg?.instanceId}/${S.cfg?.model}`)?.options || []);
    const curEffortVal = curEffort && curOpts.find((o) => o.id === curEffort.id)?.value;
    const newEffort = effortOption(target.options);
    const options = [];
    if (newEffort && curEffortVal !== undefined && newEffort.values?.includes(curEffortVal)) options.push({ id: newEffort.id, value: curEffortVal });
    await t3.call("t3_thread_configure", { threadId: t.threadId, modelSelection: { instanceId: fav.instanceId, model: fav.model, options } });
    toast(1, `${modelLabel(fav.instanceId, fav.model)} set${isWorking(t) ? " from the next turn" : ""}`);
  } catch (e) {
    toast(1, `Couldn't switch: ${e.message}`);
  }
  S.busy.model = false;
  await refreshCfg();
  pollThreads();
}

const isWorking = (t) => ["running", "starting", "preparing", "queued"].includes(t?.status);

function currentEffort() {
  if (!S.cfg) return {};
  const opts = catalog.get(`${S.cfg.instanceId}/${S.cfg.model}`)?.options || [];
  const eff = effortOption(opts);
  const fast = fastOption(opts);
  const valueOf = (id) => S.cfg.options.find((o) => o.id === id)?.value;
  const values = eff?.values || [];
  let index = values.indexOf(valueOf(eff?.id) ?? eff?.default);
  if (index < 0) index = Math.max(0, values.indexOf("medium"));
  return { eff, fast, values, index, fastOn: fast ? valueOf(fast.id) === fast.on : false };
}

let effortTimer;
function stepEffort(ticks) {
  const { values, index } = currentEffort();
  if (!values?.length) return toast(2, "This model has no effort setting");
  const from = S.pendingEffort ?? index;
  S.pendingEffort = Math.max(0, Math.min(values.length - 1, from + ticks));
  render();
  clearTimeout(effortTimer);
  effortTimer = setTimeout(commitEffort, 700);
}

async function commitEffort() {
  const t = selected();
  const { eff, values } = currentEffort();
  const idx = S.pendingEffort;
  if (!t || !eff || idx === undefined || !S.cfg) return;
  const value = values[idx];
  const options = [...S.cfg.options.filter((o) => o.id !== eff.id), { id: eff.id, value }];
  S.busy.effort = true;
  try {
    await t3.call("t3_thread_configure", { threadId: t.threadId, modelSelection: { instanceId: S.cfg.instanceId, model: S.cfg.model, options } });
    S.cfg.options = options;
  } catch (e) {
    toast(2, `Couldn't change effort: ${e.message}`);
  }
  S.pendingEffort = undefined;
  S.busy.effort = false;
  refreshCfg();
}

async function toggleFast() {
  const t = selected();
  const { fast, fastOn } = currentEffort();
  if (!t || !S.cfg) return;
  if (!fast) return toast(2, "No fast mode for this model");
  const options = [...S.cfg.options.filter((o) => o.id !== fast.id), { id: fast.id, value: fastOn ? fast.off : fast.on }];
  S.busy.effort = true;
  render();
  try {
    await t3.call("t3_thread_configure", { threadId: t.threadId, modelSelection: { instanceId: S.cfg.instanceId, model: S.cfg.model, options } });
    S.cfg.options = options;
    toast(2, fastOn ? "Fast mode off" : "Fast mode on");
  } catch (e) {
    toast(2, `Couldn't change fast mode: ${e.message}`);
  }
  S.busy.effort = false;
  refreshCfg();
}

// ---------- rendering ----------

function slotThread(c) {
  if (c.row === 0) return { thread: S.pinned[c.column], pinnedSlot: true };
  const cols = 4;
  return { thread: S.live[(c.row - 1) * cols + c.column], pinnedSlot: false };
}

function render() {
  const now = Date.now();
  const alert = S.alert && S.alert.until > now ? S.alert : undefined;
  for (const [context, c] of contexts) {
    if (c.action === A.thread) {
      if (!S.online) {
        draw(context, R.messageKey(c.row === 0 && c.column === 0 ? S.offline.title : "", c.row === 0 && c.column === 0 ? S.offline.sub : ""));
        continue;
      }
      const { thread, pinnedSlot } = slotThread(c);
      const hold = S.holds.get(context);
      draw(
        context,
        R.threadKey({
          thread,
          pinnedSlot,
          selected: thread && thread.threadId === S.selectedId,
          // Show the stop gauge only on a working thread, and only once it's clearly a hold, not a press.
          hold: hold && isWorking(thread) && now - hold.start > 200 ? Math.min(1, (now - hold.start - 200) / (HOLD_MS - 200)) : undefined,
          workingSince: thread && S.workingSince.get(thread.threadId),
          modelLabel: thread && modelLabel(thread.providerInstanceId, thread.model),
          toast: activeToast(context),
        })
      );
      continue;
    }
    const slot = DIAL_SLOT[c.action];
    if (!S.online) {
      draw(context, R.offlinePanel(slot, S.offline));
      continue;
    }
    if (alert) {
      draw(context, R.alertSlice(slot, alert));
      continue;
    }
    const t = selected();
    if (c.action === A.threads) {
      const list = ordered();
      draw(context, R.threadsPanel({ thread: t, index: Math.max(0, list.indexOf(t)), total: list.length, projectName: t && S.projects.get(t.projectId), modelLabel: t && modelLabel(S.cfg?.instanceId || t.providerInstanceId, S.cfg?.model || t.model), toast: activeToast(0) }));
    } else if (c.action === A.model) {
      const fav = S.favorites[S.modelIdx];
      const current = S.cfg || (t && { instanceId: t.providerInstanceId, model: t.model });
      draw(context, R.modelPanel({ candidate: fav && { ...fav, label: modelLabel(fav.instanceId, fav.model) }, current, index: S.modelIdx ?? 0, total: S.favorites.length, toast: activeToast(1) || (!t ? "Select a thread first" : undefined), busy: S.busy.model }));
    } else if (c.action === A.effort) {
      const { values, index, fast, fastOn } = currentEffort();
      draw(context, R.effortPanel({ values: t ? values : [], index, pendingIndex: S.pendingEffort, fast: fastOn, fastSupported: !!fast, toast: activeToast(2), busy: S.busy.effort }));
    } else if (c.action === A.usage) {
      draw(context, R.usagePanel({ usage: S.usage, view: S.usageView, error: S.usageError, loading: S.usageLoading, toast: activeToast(3) }));
    }
  }
}

// ---------- Stream Deck events ----------

function onKeyDown(context) {
  const c = contexts.get(context);
  if (!S.online) return openT3App();
  const { thread } = slotThread(c);
  if (!thread) return;
  const hold = { start: Date.now() };
  hold.timer = setInterval(render, 60);
  S.holds.set(context, hold);
  render();
}

function onKeyUp(context) {
  const c = contexts.get(context);
  const hold = S.holds.get(context);
  if (!hold) return;
  clearInterval(hold.timer);
  S.holds.delete(context);
  const { thread } = slotThread(c);
  if (!thread) return render();
  const held = Date.now() - hold.start;
  if (held >= HOLD_MS && isWorking(thread)) {
    interrupt(thread, context);
    render();
    return;
  }
  select(thread.threadId);
  if (S.alert?.threadId === thread.threadId) S.alert = undefined;
  openInT3(thread);
  render();
}

function dismissAlert() {
  if (S.alert && S.alert.until > Date.now()) {
    S.alert = undefined;
    render();
    return true;
  }
  return false;
}

function onRotate(action, ticks) {
  dismissAlert();
  if (!S.online) return;
  if (action === A.threads) {
    const list = ordered();
    if (!list.length) return;
    const i = Math.max(0, list.findIndex((t) => t.threadId === S.selectedId));
    select(list[(i + ticks + list.length * 10) % list.length].threadId);
  } else if (action === A.model) {
    if (!S.favorites.length) return;
    S.modelIdx = ((S.modelIdx ?? 0) + ticks + S.favorites.length * 10) % S.favorites.length;
  } else if (action === A.effort) {
    if (!selected()) return;
    stepEffort(ticks);
  } else if (action === A.usage) {
    S.usageView = ((S.usageView + ticks) % 4 + 4) % 4;
  }
  render();
}

function onPress(action, hold = false) {
  if (S.alert && S.alert.until > Date.now()) {
    const t = S.threads.find((x) => x.threadId === S.alert.threadId);
    S.alert = undefined;
    if (t) {
      select(t.threadId);
      openInT3(t);
    }
    return render();
  }
  if (!S.online) return openT3App();
  if (action === A.threads) {
    if (hold) return togglePin();
    openInT3(selected());
  } else if (action === A.model) applyModel();
  else if (action === A.effort) toggleFast();
  else if (action === A.usage) pollUsage();
}

sd.on("message", (raw) => {
  let m;
  try {
    m = JSON.parse(String(raw));
  } catch {
    return;
  }
  const { event, action, context, payload = {} } = m;
  switch (event) {
    case "willAppear":
      contexts.set(context, { action, device: m.device, column: payload.coordinates?.column ?? 0, row: payload.coordinates?.row ?? 0 });
      lastDrawn.delete(context);
      render();
      break;
    case "willDisappear":
      contexts.delete(context);
      lastDrawn.delete(context);
      break;
    case "keyDown":
      onKeyDown(context);
      break;
    case "keyUp":
      onKeyUp(context);
      break;
    case "dialRotate":
      onRotate(action, payload.ticks || 0);
      break;
    case "dialDown":
      onPress(action);
      break;
    case "touchTap":
      onPress(action, !!payload.hold);
      break;
    case "deviceDidConnect":
      maybeOfferProfile(m.device, m.deviceInfo);
      break;
    case "systemDidWakeUp":
      pollThreads();
      pollUsage();
      break;
  }
});

// Offer the bundled "T3 Code" profile once per Stream Deck+, so the keys and knobs are laid out for you.
const offered = new Set();
function maybeOfferProfile(device, deviceInfo) {
  if (!device || offered.has(device)) return;
  if (fs.existsSync(path.join(STORE_DIR, "dev-no-profile"))) return; // set while testing a linked dev copy
  if (deviceInfo && deviceInfo.type !== 7) return; // 7 = Stream Deck+
  offered.add(device);
  const store = loadStore();
  store.profileOffered = store.profileOffered || {};
  if (store.profileOffered[device]) return;
  store.profileOffered[device] = true;
  saveStore(store);
  send({ event: "switchToProfile", context: arg("-pluginUUID"), device, payload: { profile: "profiles/T3 Code" } });
}

// ---------- loops ----------

const devices = (() => {
  try {
    return JSON.parse(arg("-info")).devices || [];
  } catch {
    return [];
  }
})();
sd.on("open", () => {
  for (const d of devices) if (d.type === 7) maybeOfferProfile(d.id, d);
});

pollFavorites();
pollProjects().then(pollThreads);
pollUsage();
setInterval(pollThreads, POLL_MS);
setInterval(pollProjects, 60000);
setInterval(pollUsage, USAGE_MS);
setInterval(pollFavorites, 15000);
setInterval(() => S.selectedId && S.pendingEffort === undefined && refreshCfg(), 10000);
setInterval(render, 30000); // keeps "12m" ages fresh
log("started", { devices: devices.map((d) => d.type) });
