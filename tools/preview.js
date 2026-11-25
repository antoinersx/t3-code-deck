// Renders every key and strip state into preview.html, laid out like a Stream Deck+.
const fs = require("fs");
const path = require("path");
const R = require("../io.github.antoinersx.t3codedeck.sdPlugin/bin/render.js");
const now = Date.now();
const iso = (minsAgo) => new Date(now - minsAgo * 60000).toISOString();
const th = (title, status, prov, minsAgo, extra = {}) => ({ threadId: title, title, status, providerInstanceId: prov, updatedAt: iso(minsAgo), ...extra });

const keysTop = [
  R.threadKey({ thread: th("Refactor billing webhooks", "running", "claudeAgent", 12, { pinned: true }), pinnedSlot: true, workingSince: now - 12 * 60000, modelLabel: "Opus 5.5" }),
  R.threadKey({ thread: th("Migrate auth to passkeys", "waiting", "codex", 3, { pinned: true }), pinnedSlot: true, modelLabel: "GPT-6.2 Sol", selected: true }),
  R.threadKey({ thread: th("Write the v2 release notes", "completed", "antigravity", 140, { pinned: true }), pinnedSlot: true, modelLabel: "Gemini 4 Neon" }),
  R.threadKey({ pinnedSlot: true }),
];
const keysBottom = [
  R.threadKey({ thread: th("Fix flaky checkout tests", "waiting", "antigravity", 1), modelLabel: "Gemini 4 Neon" }),
  R.threadKey({ thread: th("Add dark mode to settings", "running", "claudeAgent", 4), workingSince: now - 4 * 60000, modelLabel: "Fable 5.2", hold: 0.55 }),
  R.threadKey({ thread: th("Nightly data import", "failed", "claudeAgent", 30), modelLabel: "Fable 5.2" }),
  R.threadKey({ thread: th("Speed up cold start", "running", "claudeAgent", 2), workingSince: now - 2 * 60000, modelLabel: "Opus 5.5", hold: 1 }),
];
const usage = {
  claude: { windows: [{ kind: "weekly", label: "Weekly", usedPercent: 3, resetsAt: new Date(now + 6.4 * 86400000).toISOString() }, { kind: "weekly", label: "Weekly · Fable", usedPercent: 2, resetsAt: new Date(now + 6.4 * 86400000).toISOString() }] },
  codex: { windows: [{ kind: "weekly", label: "Weekly", usedPercent: 74, resetsAt: new Date(now + 5 * 86400000).toISOString() }] },
  gemini: { windows: [{ kind: "session", label: "Gemini · 5-hour", usedPercent: 93, resetsAt: new Date(now + 41 * 60000).toISOString() }, { kind: "weekly", label: "Gemini · Weekly", usedPercent: 22, resetsAt: new Date(now + 5.8 * 86400000).toISOString() }] },
};
const sel = th("Migrate auth to passkeys", "waiting", "codex", 3, { pinned: true });
const strip = [
  R.threadsPanel({ thread: sel, index: 1, total: 9, projectName: "web-app", modelLabel: "GPT-6.2 Sol" }),
  R.modelPanel({ candidate: { instanceId: "claudeAgent", model: "claude-opus-5-5", label: "Opus 5.5" }, current: { instanceId: "codex", model: "gpt-6.2-sol" }, index: 1, total: 4 }),
  R.effortPanel({ values: ["low", "medium", "high", "xhigh", "max", "ultra"], index: 2, fast: true, fastSupported: true }),
  R.usagePanel({ usage, view: 0 }),
];
const extras = [
  ["Model · in use", R.modelPanel({ candidate: { instanceId: "codex", model: "gpt-6.2-sol", label: "GPT-6.2 Sol" }, current: { instanceId: "codex", model: "gpt-6.2-sol" }, index: 0, total: 4 })],
  ["Usage · Gemini", R.usagePanel({ usage, view: 3 })],
  ["Usage · Claude", R.usagePanel({ usage, view: 1 })],
  ["Effort · no fast", R.effortPanel({ values: ["low", "medium", "high", "xhigh"], index: 1, fastSupported: false })],
  ["Toast", R.modelPanel({ toast: "Opus 5.5 set from the next turn" })],
  ["Offline", R.offlinePanel(0, { title: "T3 Code is closed", sub: "Press any key to open it" })],
];
const alert = [0, 1, 2, 3].map((i) => R.alertSlice(i, { title: "Fix flaky checkout tests", count: 2 }));
const img = (s, w, h) => `<img src="${R.dataUrl(s)}" width="${w}" height="${h}">`;
const html = `<!doctype html><meta charset="utf-8"><title>T3 Code Deck preview</title>
<style>body{background:#2b2d31;color:#ddd;font:14px -apple-system,Helvetica,sans-serif;padding:24px;margin:0}
.deck{background:#050505;border-radius:28px;padding:28px;display:inline-block;margin-bottom:28px}
.keys{display:grid;grid-template-columns:repeat(4,120px);gap:22px;justify-content:center}
.keys img{border-radius:12px;display:block}.strip{display:flex;margin:26px auto 0;width:800px;border-radius:10px;overflow:hidden}
.strip img{display:block}h2{font-size:15px;margin:8px 0 12px;color:#aaa;font-weight:600}.grid{display:flex;flex-wrap:wrap;gap:20px}
.grid figure{margin:0}.grid figcaption{font-size:12px;color:#999;margin-top:6px}.grid img{border-radius:8px}</style>
<h2>Page 1 — normal</h2><div class="deck"><div class="keys">${[...keysTop, ...keysBottom].map((k) => img(k, 120, 120)).join("")}</div>
<div class="strip">${strip.map((p) => img(p, 200, 100)).join("")}</div></div>
<h2>Strip — "needs you" alert</h2><div class="deck" style="padding:18px"><div class="strip" style="margin:0">${alert.map((p) => img(p, 200, 100)).join("")}</div></div>
<h2>Other strip states</h2><div class="grid">${extras.map(([n, p]) => `<figure>${img(p, 200, 100)}<figcaption>${n}</figcaption></figure>`).join("")}</div>`;
const out = path.join(__dirname, "..", "preview.html");
fs.writeFileSync(out, html);
console.log(out);
