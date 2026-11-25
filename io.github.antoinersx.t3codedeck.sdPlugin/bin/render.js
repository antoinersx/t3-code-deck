// Draws every key (144x144) and touch-strip panel (200x100) as SVG.
// Stream Deck scales keys to the device; Stream Deck+ keys are 120 px, so text stays large.

const FONT = "SF Pro Display, -apple-system, Helvetica Neue, Helvetica, Arial, sans-serif";

const C = {
  bg: "#0F1113",
  surface: "#1A1D21",
  line: "#2A2F35",
  text: "#F3F5F6",
  muted: "#8D959C",
  faint: "#5C646B",
  working: "#3CCB7F",
  waiting: "#F7B83D",
  waitingBg: "#3A2909",
  error: "#F2625F",
  errorBg: "#3A1413",
  stop: "#E5484D",
  selected: "#FFFFFF",
};

const PROVIDERS = {
  claudeAgent: { name: "Claude", color: "#E27D58" },
  codex: { name: "Codex", color: "#7FA6FF" },
  antigravity: { name: "Gemini", color: "#B394FF" },
};

function providerInfo(instanceId) {
  if (PROVIDERS[instanceId]) return PROVIDERS[instanceId];
  if (/claude/i.test(instanceId || "")) return PROVIDERS.claudeAgent;
  if (/codex/i.test(instanceId || "")) return PROVIDERS.codex;
  if (/antigravity|gemini/i.test(instanceId || "")) return PROVIDERS.antigravity;
  return { name: instanceId || "Agent", color: C.muted };
}

const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** Rough width of text in px; good enough to wrap and truncate on a key. */
function textWidth(s, size, weight = 400) {
  let w = 0;
  for (const ch of String(s)) {
    if (/[ilI.,:;!'|]/.test(ch)) w += 0.28;
    else if (/[mwMW]/.test(ch)) w += 0.86;
    else if (/[A-Z0-9]/.test(ch)) w += 0.64;
    else if (ch === " ") w += 0.28;
    else w += 0.54;
  }
  return w * size * (weight >= 600 ? 1.04 : 1);
}

function truncate(s, size, max, weight) {
  s = String(s ?? "");
  if (textWidth(s, size, weight) <= max) return s;
  while (s.length > 1 && textWidth(`${s}…`, size, weight) > max) s = s.slice(0, -1);
  return `${s.trimEnd()}…`;
}

/** Word-wraps into at most `lines` lines that fit `max` px, ellipsizing the last. */
function wrap(s, size, max, lines, weight) {
  const words = String(s ?? "").split(/\s+/).filter(Boolean);
  const out = [];
  let cur = "";
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const next = cur ? `${cur} ${w}` : w;
    if (textWidth(next, size, weight) <= max) {
      cur = next;
      continue;
    }
    if (cur) out.push(cur);
    cur = w;
    if (out.length === lines - 1) {
      cur = [cur, ...words.slice(i + 1)].join(" ");
      break;
    }
  }
  if (cur) out.push(cur);
  if (out.length > lines) out.length = lines;
  out[out.length - 1] = truncate(out[out.length - 1] || "", size, max, weight);
  return out.map((l) => truncate(l, size, max, weight));
}

const text = (x, y, s, { size = 14, weight = 400, fill = C.text, anchor = "start", spacing } = {}) =>
  `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}"${
    spacing ? ` letter-spacing="${spacing}"` : ""
  }>${esc(s)}</text>`;

const svg = (w, h, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`;

const dataUrl = (s) => `data:image/svg+xml;base64,${Buffer.from(s).toString("base64")}`;

function ago(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const m = Math.floor(ms / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function until(iso) {
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms)) return "";
  if (ms <= 0) return "now";
  const m = Math.ceil(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60 ? `${m % 60}m` : ""}`.trim();
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24 ? `${h % 24}h` : ""}`.trim();
}

/** Status of a thread as the deck shows it. */
function statusOf(t) {
  const s = t?.status;
  if (s === "waiting") return { key: "waiting", label: "NEEDS YOU", color: C.waiting };
  if (["running", "starting", "preparing", "queued"].includes(s)) return { key: "working", label: "WORKING", color: C.working };
  if (s === "failed") return { key: "error", label: "FAILED", color: C.error };
  if (["interrupted", "cancelled", "rolled_back"].includes(s)) return { key: "stopped", label: "STOPPED", color: C.muted };
  return { key: "done", label: "DONE", color: C.muted };
}

const PIN = (x, y, fill) =>
  `<g transform="translate(${x} ${y})"><path d="M5 0h6l-1 5 3 3v2H8.6L8 16l-.6-6H3V8l3-3z" fill="${fill}"/></g>`;

/** Status glyph: differs by shape, not only colour. */
function glyph(kind, x, y, color) {
  if (kind === "waiting") return `<circle cx="${x + 6}" cy="${y + 6}" r="6" fill="${color}"/><rect x="${x + 5}" y="${y + 2.4}" width="2" height="4.6" rx="1" fill="${C.bg}"/><circle cx="${x + 6}" cy="${y + 9}" r="1.1" fill="${C.bg}"/>`;
  if (kind === "working") return `<circle cx="${x + 6}" cy="${y + 6}" r="5" fill="none" stroke="${color}" stroke-width="2.4" stroke-dasharray="20 12"/>`;
  if (kind === "error") return `<path d="M${x + 1} ${y + 1}l10 10M${x + 11} ${y + 1}l-10 10" stroke="${color}" stroke-width="2.6" stroke-linecap="round"/>`;
  if (kind === "stopped") return `<rect x="${x + 1}" y="${y + 1}" width="10" height="10" rx="2" fill="${color}"/>`;
  return `<path d="M${x + 1} ${y + 6.5}l3.4 3.4L${x + 11} ${y + 2.4}" fill="none" stroke="${color}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>`;
}

// ---------- keys ----------

/**
 * One thread key.
 * opts: { thread, pinnedSlot, selected, hold: 0..1 | undefined, workingSince, modelLabel }
 */
function threadKey({ thread, pinnedSlot, selected, hold, workingSince, modelLabel, toast }) {
  const W = 144;
  if (!thread) return emptyKey(pinnedSlot);
  const st = statusOf(thread);
  const prov = providerInfo(thread.providerInstanceId);
  const bg = st.key === "waiting" ? C.waitingBg : st.key === "error" ? C.errorBg : C.bg;
  let b = `<rect width="${W}" height="${W}" fill="${bg}"/>`;

  // Status row.
  const since = st.key === "working" ? workingSince || Date.parse(thread.updatedAt) : Date.parse(thread.updatedAt);
  const age = ago(Date.now() - since);
  b += glyph(st.key, 12, 13, st.color);
  b += text(29, 24, st.label, { size: 13, weight: 700, fill: st.color });
  if (age) b += text(132, 24, age, { size: 13, weight: 600, fill: st.key === "waiting" ? st.color : C.muted, anchor: "end" });

  // Title.
  const lines = wrap(thread.title || "Untitled", 20, 120, 3, 650);
  lines.forEach((l, i) => {
    b += text(12, 56 + i * 24, l, { size: 20, weight: 650 });
  });

  // Model line, with the provider's colour.
  b += `<circle cx="17" cy="127" r="5" fill="${prov.color}"/>`;
  b += text(28, 132, truncate(modelLabel || prov.name, 14, pinnedSlot ? 88 : 104, 500), { size: 14, weight: 500, fill: C.muted });
  if (pinnedSlot) b += PIN(119, 118, C.faint);

  if (st.key === "waiting") b += `<rect x="1.5" y="1.5" width="${W - 3}" height="${W - 3}" rx="10" fill="none" stroke="${C.waiting}" stroke-width="3"/>`;
  if (selected) b += `<rect x="3" y="3" width="${W - 6}" height="${W - 6}" rx="9" fill="none" stroke="${C.selected}" stroke-width="5"/>`;

  if (hold !== undefined) b += holdOverlay(hold, st.key === "working");
  if (toast) b += toastOverlay(toast);
  return svg(W, W, b);
}

function holdOverlay(progress, canStop) {
  const W = 144;
  if (!canStop) {
    return `<rect width="${W}" height="${W}" fill="${C.bg}" opacity="0.88"/>${text(72, 68, "Not running", { size: 18, weight: 700, anchor: "middle" })}${text(72, 92, "Nothing to stop", { size: 14, fill: C.muted, anchor: "middle" })}`;
  }
  const h = Math.round(W * Math.min(1, progress));
  const done = progress >= 1;
  return `<rect width="${W}" height="${W}" fill="${C.bg}"/>
    <rect x="0" y="${W - h}" width="${W}" height="${h}" fill="${C.stop}" opacity="${done ? 1 : 0.55}"/>
    <rect x="${W / 2 - 13}" y="34" width="26" height="26" rx="4" fill="${C.text}"/>
    ${text(72, 92, done ? "Release" : "Keep holding", { size: 19, weight: 700, anchor: "middle" })}
    ${text(72, 114, done ? "to stop" : "to stop it", { size: 16, weight: 500, anchor: "middle" })}`;
}

function toastOverlay(msg) {
  const W = 144;
  const lines = wrap(msg, 17, 124, 3, 600);
  const y0 = 72 - ((lines.length - 1) * 21) / 2 + 6;
  return `<rect width="${W}" height="${W}" fill="${C.surface}" opacity="0.96"/>${lines
    .map((l, i) => text(72, y0 + i * 21, l, { size: 17, weight: 600, anchor: "middle" }))
    .join("")}`;
}

function emptyKey(pinnedSlot) {
  const W = 144;
  let b = `<rect width="${W}" height="${W}" fill="${C.bg}"/>`;
  if (pinnedSlot) {
    b += `<rect x="8" y="8" width="128" height="128" rx="12" fill="none" stroke="${C.line}" stroke-width="2.5" stroke-dasharray="7 6"/>`;
    b += `<g transform="translate(64 30) scale(1.2)"><path d="M5 0h6l-1 5 3 3v2H8.6L8 16l-.6-6H3V8l3-3z" fill="${C.faint}"/></g>`;
    b += text(72, 82, "Pin a thread", { size: 17, weight: 650, fill: C.muted, anchor: "middle" });
    b += text(72, 104, "Hold the strip", { size: 13, fill: C.faint, anchor: "middle" });
    b += text(72, 120, "above knob 1", { size: 13, fill: C.faint, anchor: "middle" });
  } else {
    b += text(72, 70, "No other", { size: 15, weight: 600, fill: C.faint, anchor: "middle" });
    b += text(72, 90, "active threads", { size: 15, weight: 600, fill: C.faint, anchor: "middle" });
  }
  return svg(W, W, b);
}

function messageKey(title, sub, color = C.muted) {
  const W = 144;
  let b = `<rect width="${W}" height="${W}" fill="${C.bg}"/>`;
  wrap(title, 17, 124, 2, 650).forEach((l, i) => (b += text(72, 64 + i * 21, l, { size: 17, weight: 650, fill: color, anchor: "middle" })));
  if (sub) wrap(sub, 13, 124, 2).forEach((l, i) => (b += text(72, 110 + i * 16, l, { size: 13, fill: C.faint, anchor: "middle" })));
  return svg(W, W, b);
}

// ---------- strip panels (200x100 each) ----------

const panel = (body, bg = C.bg) => svg(200, 100, `<rect width="200" height="100" fill="${bg}"/>${body}`);

function header(label, right, rightColor = C.muted) {
  return text(12, 22, label, { size: 12, weight: 700, fill: C.muted, spacing: 1 }) + (right ? text(188, 22, right, { size: 12, weight: 700, fill: rightColor, anchor: "end" }) : "");
}

function threadsPanel({ thread, index, total, projectName, modelLabel, toast }) {
  if (toast) return toastPanel("THREADS", toast);
  if (!thread) return panel(header("THREADS") + text(12, 58, "No active threads", { size: 18, weight: 650, fill: C.muted }) + text(12, 82, "Start one in T3 Code", { size: 13, fill: C.faint }));
  const st = statusOf(thread);
  let b = header(`THREAD ${index + 1}/${total}`, st.label, st.color);
  b += text(12, 54, truncate(thread.title || "Untitled", 20, 176, 650), { size: 20, weight: 650 });
  const prov = providerInfo(thread.providerInstanceId);
  b += `<circle cx="16" cy="78" r="4.5" fill="${prov.color}"/>`;
  b += text(26, 83, truncate([modelLabel, projectName].filter(Boolean).join(" · "), 13, thread.pinned ? 142 : 162), { size: 13, fill: C.muted });
  if (thread.pinned) b += PIN(174, 70, C.faint);
  return panel(b);
}

function modelPanel({ candidate, current, index, total, toast, busy }) {
  if (toast) return toastPanel("MODEL", toast);
  if (!candidate) return panel(header("MODEL") + text(12, 58, "No favourites", { size: 18, weight: 650, fill: C.muted }) + text(12, 82, "Star models in T3 Code", { size: 13, fill: C.faint }));
  const prov = providerInfo(candidate.instanceId);
  const isCurrent = current && current.instanceId === candidate.instanceId && current.model === candidate.model;
  let b = header("MODEL", total ? `${index + 1}/${total}` : "");
  b += text(12, 56, truncate(candidate.label, 22, 176, 700), { size: 22, weight: 700, fill: isCurrent ? C.text : C.text });
  b += `<circle cx="16" cy="79" r="4.5" fill="${prov.color}"/>`;
  b += text(26, 84, prov.name, { size: 13, weight: 600, fill: prov.color });
  const hint = busy ? "Switching…" : isCurrent ? "In use" : "Press to switch";
  b += text(188, 84, hint, { size: 13, weight: 650, fill: isCurrent ? C.muted : C.waiting, anchor: "end" });
  if (!isCurrent) b += `<rect x="1" y="1" width="198" height="98" rx="8" fill="none" stroke="${C.waiting}" stroke-width="2" stroke-dasharray="6 5"/>`;
  return panel(b);
}

function effortPanel({ values, index, pendingIndex, fast, fastSupported, toast, busy }) {
  if (toast) return toastPanel("EFFORT", toast);
  if (!values || !values.length) return panel(header("EFFORT") + text(12, 58, "Not adjustable", { size: 18, weight: 650, fill: C.muted }) + text(12, 82, "This model has no effort setting", { size: 13, fill: C.faint }));
  const shown = pendingIndex ?? index;
  let b = header("EFFORT", fast ? "FAST ON" : fastSupported ? "FAST OFF" : "", fast ? C.waiting : C.faint);
  b += text(12, 54, titleCase(values[shown] ?? "Default"), { size: 22, weight: 700 });
  if (busy || pendingIndex !== undefined) b += text(188, 54, "Saving…", { size: 12, weight: 600, fill: C.muted, anchor: "end" });
  const n = values.length;
  const gap = 4;
  const segW = (176 - gap * (n - 1)) / n;
  for (let i = 0; i < n; i++) {
    const x = 12 + i * (segW + gap);
    b += `<rect x="${x.toFixed(1)}" y="68" width="${segW.toFixed(1)}" height="8" rx="3" fill="${i <= shown ? C.text : C.line}"/>`;
  }
  b += text(12, 93, fastSupported ? "Press: fast mode on / off" : "No fast mode for this model", { size: 12, fill: C.faint });
  return panel(b);
}

function titleCase(v) {
  const s = String(v);
  if (s === "xhigh") return "Extra high";
  if (s === "ultrathink") return "Ultrathink";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function barColor(p) {
  if (p >= 90) return C.error;
  if (p >= 70) return C.waiting;
  return C.text;
}

/** The tightest window decides how much of a provider is left. */
function tightest(u) {
  if (!u || !u.windows?.length) return undefined;
  return [...u.windows].sort((a, b) => b.usedPercent - a.usedPercent)[0];
}

function usagePanel({ usage, view, error, toast, loading }) {
  if (toast) return toastPanel("USAGE", toast);
  const rows = [
    ["Claude", usage?.claude, PROVIDERS.claudeAgent.color],
    ["Codex", usage?.codex, PROVIDERS.codex.color],
    ["Gemini", usage?.gemini, PROVIDERS.antigravity.color],
  ];
  if (!usage) {
    return panel(header("USAGE") + text(12, 58, loading ? "Loading…" : "Unavailable", { size: 18, weight: 650, fill: C.muted }) + text(12, 82, truncate(error || "Press to retry", 13, 176), { size: 13, fill: C.faint }));
  }
  if (!view) {
    let b = "";
    rows.forEach(([name, u, color], i) => {
      const y = 20 + i * 30;
      const w = tightest(u);
      b += text(12, y + 9, name, { size: 14, weight: 650, fill: color });
      if (!w) {
        b += text(188, y + 9, "no data", { size: 13, fill: C.faint, anchor: "end" });
        return;
      }
      const used = Math.max(0, Math.min(100, w.usedPercent));
      b += `<rect x="70" y="${y}" width="58" height="10" rx="4" fill="${C.line}"/><rect x="70" y="${y}" width="${(58 * used) / 100}" height="10" rx="4" fill="${barColor(used)}"/>`;
      b += text(188, y + 9, `${Math.round(100 - used)}% left`, { size: 13, weight: 600, fill: barColor(used) === C.text ? C.muted : barColor(used), anchor: "end" });
    });
    return panel(b);
  }
  const [name, u, color] = rows[view - 1];
  let b = text(12, 22, name.toUpperCase(), { size: 12, weight: 700, fill: color, spacing: 1 }) + text(188, 22, `${view}/3`, { size: 12, weight: 700, fill: C.muted, anchor: "end" });
  const wins = (u?.windows || []).slice().sort((a, b) => (a.kind === "session" ? -1 : 1) - (b.kind === "session" ? -1 : 1)).slice(0, 2);
  if (!wins.length) return panel(b + text(12, 60, "No limits reported", { size: 16, weight: 600, fill: C.muted }));
  wins.forEach((w, i) => {
    const y = 38 + i * 32;
    const used = Math.max(0, Math.min(100, w.usedPercent));
    const label = shortWindowLabel(w);
    b += text(12, y + 4, label, { size: 13, weight: 600 });
    b += text(188, y + 4, w.resetsAt ? `${Math.round(100 - used)}% left · ${until(w.resetsAt)}` : `${Math.round(100 - used)}% left`, { size: 12, fill: C.muted, anchor: "end" });
    b += `<rect x="12" y="${y + 10}" width="176" height="8" rx="3" fill="${C.line}"/><rect x="12" y="${y + 10}" width="${(176 * used) / 100}" height="8" rx="3" fill="${barColor(used)}"/>`;
  });
  return panel(b);
}

function shortWindowLabel(w) {
  if (w.kind === "session") return "5-hour";
  if (w.kind === "weekly") return /fable/i.test(w.label) ? "Fable wk" : "Week";
  if (w.kind === "monthly") return "Month";
  return truncate(w.label, 13, 80);
}

function toastPanel(label, msg) {
  const lines = wrap(msg, 15, 176, 3, 600);
  return panel(header(label) + lines.map((l, i) => text(12, 48 + i * 19, l, { size: 15, weight: 600 })).join(""), C.surface);
}

/** The "needs you" alert spans all four panels; each panel draws its quarter. */
function alertSlice(slot, { title, count }) {
  const full = `<rect width="800" height="100" fill="${C.waiting}"/>
    ${glyph("waiting", 18, 20, C.bg)}
    ${text(40, 32, count > 1 ? `${count} THREADS NEED YOU` : "A THREAD NEEDS YOU", { size: 15, weight: 800, fill: C.bg, spacing: 0.6 })}
    ${text(18, 72, truncate(title, 34, 620, 750), { size: 34, weight: 750, fill: C.bg })}
    ${text(782, 72, "Tap to open", { size: 20, weight: 700, fill: C.bg, anchor: "end" })}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="${slot * 200} 0 200 100">${full}</svg>`;
}

function offlinePanel(slot, message) {
  if (slot === 0) return panel(header("T3 CODE") + text(12, 56, truncate(message.title, 18, 176, 650), { size: 18, weight: 650, fill: C.muted }) + text(12, 80, truncate(message.sub || "", 13, 176), { size: 13, fill: C.faint }));
  return panel("");
}

module.exports = {
  C,
  dataUrl,
  threadKey,
  messageKey,
  threadsPanel,
  modelPanel,
  effortPanel,
  usagePanel,
  alertSlice,
  offlinePanel,
  providerInfo,
  statusOf,
  titleCase,
};
