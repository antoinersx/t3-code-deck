// Talks to the T3 Code server running on this Mac.
//
// Everything the deck does goes through surfaces T3 Code ships for outside apps, so a T3 update
// should not break the plugin:
//   - the `t3` command T3 Code installs in ~/.t3/bin (pairing codes, read-only sessions),
//   - the MCP endpoint at <origin>/mcp, the same tools outside agents use (threads, models, pins, stop),
//   - the standard MCP OAuth sign-in (register, approve with a one-time pairing code, token).
// Usage limits are the one exception: T3 only shows them to its own app, over its WebSocket. That part
// is isolated in fetchUsage(); if a T3 update changes it, only the Usage knob says "unavailable".

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");
const WebSocket = require("ws");

const T3_HOME = process.env.T3CODE_HOME || path.join(os.homedir(), ".t3");
const CLI = path.join(T3_HOME, "bin", "t3");
const RUNTIME_FILE = path.join(T3_HOME, "userdata", "server-runtime.json");
const SETTINGS_FILE = path.join(T3_HOME, "userdata", "settings.json");
const STORE_DIR = path.join(os.homedir(), "Library", "Application Support", "T3 Code Deck");
const STORE_FILE = path.join(STORE_DIR, "auth.json");
const LABEL = "T3 Code Deck";
const USAGE_LABEL = "T3 Code Deck (usage)";
const DAY = 86400000;

class T3Error extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// ---------- small helpers ----------

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
};

function loadStore() {
  return readJson(STORE_FILE) || {};
}

function saveStore(store) {
  fs.mkdirSync(STORE_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${STORE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, STORE_FILE);
}

function runCli(args) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(CLI)) return reject(new T3Error("no_cli", "The t3 command is missing. Open T3 Code once."));
    execFile(CLI, args, { timeout: 30000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new T3Error("cli_failed", `t3 ${args.slice(0, 3).join(" ")} failed: ${(stderr || err.message).trim().slice(0, 300)}`));
      resolve(stdout);
    });
  });
}

async function runCliJson(args) {
  const out = await runCli([...args, "--json"]);
  return JSON.parse(out);
}

/** The running server's origin, or undefined when T3 Code is closed. */
function serverOrigin() {
  const rt = readJson(RUNTIME_FILE);
  if (!rt || !rt.origin) return undefined;
  if (rt.pid) {
    try {
      process.kill(rt.pid, 0);
    } catch {
      return undefined;
    }
  }
  return rt.origin;
}

/** Your favourite models from T3 Code's settings, as [{ instanceId, model }]. */
function readFavorites() {
  const s = readJson(SETTINGS_FILE);
  const favs = Array.isArray(s?.favorites) ? s.favorites : [];
  return favs
    .filter((f) => f && typeof f.model === "string" && typeof f.provider === "string")
    .map((f) => ({ instanceId: f.provider, model: f.model }));
}

const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function httpJson(url, init = {}) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(init.timeoutMs || 15000) });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  return { status: res.status, headers: res.headers, body, text };
}

// ---------- sign-in ----------

/**
 * Signs the deck in as an outside MCP app with full access, the standard way: register, approve
 * with a one-time pairing code minted by the local `t3` command, then trade the code for a token.
 * Full access is needed because T3 refuses changes to a full-access thread from a narrower caller.
 */
async function signInMcp(origin) {
  const redirectUri = "http://127.0.0.1/t3-code-deck/callback";
  const reg = await httpJson(`${origin}/oauth/mcp/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: LABEL,
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  if (reg.status >= 300 || !reg.body?.client_id) throw new T3Error("signin_failed", `Sign-in registration failed (${reg.status}).`);
  const clientId = reg.body.client_id;

  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  const state = b64url(crypto.randomBytes(12));
  const resource = `${origin}/mcp`;
  const authorization = {
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    resource,
  };

  // One-time code, valid two minutes, consumed by the approval right below.
  const pairing = await runCliJson(["auth", "pairing", "create", "--ttl", "2m", "--label", `${LABEL} sign-in`]);
  let consumed = false;
  try {
    const decision = await httpJson(`${origin}/oauth/mcp/decision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ authorization, decision: { _tag: "pairing-code", access: "full-access", code: pairing.credential } }),
    });
    if (decision.status >= 300 || !decision.body?.redirectTo) {
      throw new T3Error("signin_failed", decision.body?.message || `Sign-in approval failed (${decision.status}).`);
    }
    consumed = true;
    const back = new URL(decision.body.redirectTo, origin);
    if (back.searchParams.get("state") !== state) throw new T3Error("signin_failed", "Sign-in came back with the wrong state.");
    const code = back.searchParams.get("code");
    if (!code) throw new T3Error("signin_failed", back.searchParams.get("error_description") || "Sign-in returned no code.");

    const tok = await httpJson(`${origin}/oauth/mcp/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier, resource }).toString(),
    });
    if (tok.status >= 300 || !tok.body?.access_token) throw new T3Error("signin_failed", `Token exchange failed (${tok.status}).`);
    return { token: tok.body.access_token, expiresAt: Date.now() + (tok.body.expires_in || 30 * 86400) * 1000 };
  } finally {
    if (!consumed && pairing?.id) runCli(["auth", "pairing", "revoke", pairing.id]).catch(() => {});
  }
}

/** Revokes this plugin's older sessions so renewals don't pile up in T3's device list. */
async function revokeOlderSessions(label, keepNewest) {
  try {
    const list = await runCliJson(["auth", "session", "list"]);
    const mine = (Array.isArray(list) ? list : list.sessions || []).filter((s) => s?.client?.label === label);
    mine.sort((a, b) => String(b.issuedAt).localeCompare(String(a.issuedAt)));
    for (const s of mine.slice(keepNewest)) await runCli(["auth", "session", "revoke", s.sessionId]).catch(() => {});
  } catch {
    // Housekeeping only.
  }
}

// ---------- MCP client ----------

class T3Client {
  constructor(log) {
    this.log = log || (() => {});
    this.origin = undefined;
    this.sessionId = undefined;
    this.signingIn = undefined;
    this.nextId = 1;
  }

  async mcpToken(force = false) {
    const store = loadStore();
    const cur = store.mcp;
    if (!force && cur?.token && cur.origin === this.origin && cur.expiresAt - Date.now() > 3 * DAY) return cur.token;
    if (!this.signingIn) {
      this.signingIn = (async () => {
        this.log("signing in to T3 Code");
        const fresh = await signInMcp(this.origin);
        const next = loadStore();
        next.mcp = { ...fresh, origin: this.origin };
        saveStore(next);
        this.sessionId = undefined;
        revokeOlderSessions(LABEL, 1);
        return fresh.token;
      })().finally(() => {
        this.signingIn = undefined;
      });
    }
    return this.signingIn;
  }

  async post(body, token) {
    const headers = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
    };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
    const res = await httpJson(`${this.origin}/mcp`, { method: "POST", headers, body: JSON.stringify(body) });
    let parsed = res.body;
    if (parsed === undefined && res.text.includes("data:")) {
      // Streamable HTTP may answer as server-sent events; take the last JSON-RPC message.
      const datas = res.text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim());
      for (const d of datas) {
        try {
          const m = JSON.parse(d);
          if (m.id === body.id) parsed = m;
        } catch {}
      }
    }
    return { status: res.status, headers: res.headers, body: parsed };
  }

  async connect() {
    const origin = serverOrigin();
    if (!origin) throw new T3Error("t3_closed", "T3 Code isn't running.");
    if (origin !== this.origin) {
      this.origin = origin;
      this.sessionId = undefined;
    }
    if (this.sessionId) return;
    let token = await this.mcpToken();
    let res = await this.post(this.initBody(), token);
    if (res.status === 401) {
      token = await this.mcpToken(true);
      res = await this.post(this.initBody(), token);
    }
    if (res.status >= 300 || !res.body?.result) throw new T3Error("mcp_failed", `T3 Code refused the connection (${res.status}).`);
    this.sessionId = res.headers.get("mcp-session-id") || undefined;
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized" }, token);
  }

  initBody() {
    return {
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t3-code-deck", version: "1.0.0" } },
    };
  }

  /** Calls one T3 tool and returns its structured result. */
  async call(name, args = {}, retried = false) {
    await this.connect();
    const token = await this.mcpToken();
    const res = await this.post({ jsonrpc: "2.0", id: this.nextId++, method: "tools/call", params: { name, arguments: args } }, token);
    if ((res.status === 401 || res.status === 404 || res.status === 400) && !retried) {
      // 401: token revoked or expired. 404/400: the server restarted and forgot the MCP session.
      if (res.status === 401) await this.mcpToken(true);
      this.sessionId = undefined;
      return this.call(name, args, true);
    }
    if (res.status >= 300 || !res.body) throw new T3Error("mcp_failed", `${name} failed (${res.status}).`);
    if (res.body.error) throw new T3Error("mcp_failed", res.body.error.message || `${name} failed.`);
    const result = res.body.result || {};
    if (result.isError) {
      const text = result.content?.find((c) => c.type === "text")?.text || "";
      let msg = text;
      try {
        msg = JSON.parse(text).message || text;
      } catch {}
      throw new T3Error("tool_error", msg || `${name} failed.`);
    }
    if (result.structuredContent !== undefined) return result.structuredContent;
    const text = result.content?.find((c) => c.type === "text")?.text;
    try {
      return text ? JSON.parse(text) : {};
    } catch {
      return { text };
    }
  }

  // ---------- usage (T3's own app channel; isolated on purpose) ----------

  async usageToken(force = false) {
    const store = loadStore();
    const cur = store.usage;
    if (!force && cur?.token && cur.expiresAt - Date.now() > 7 * DAY) return cur.token;
    const issued = await runCliJson(["auth", "session", "issue", "--scope", "orchestration:read", "--ttl", "365d", "--label", USAGE_LABEL]);
    const next = loadStore();
    next.usage = { token: issued.token, sessionId: issued.sessionId, expiresAt: Date.parse(issued.expiresAt) || Date.now() + 365 * DAY };
    saveStore(next);
    revokeOlderSessions(USAGE_LABEL, 1);
    return issued.token;
  }

  /** Returns { claude, codex, gemini } usage windows, each { windows:[{label,usedPercent,resetsAt,kind}], checkedAt }. */
  async fetchUsage(retried = false) {
    const origin = serverOrigin();
    if (!origin) throw new T3Error("t3_closed", "T3 Code isn't running.");
    const token = await this.usageToken(retried);
    const t = await httpJson(`${origin}/api/auth/websocket-ticket`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
    if (t.status === 401 && !retried) return this.fetchUsage(true);
    if (t.status >= 300 || !t.body?.ticket) throw new T3Error("usage_unavailable", `Usage sign-in failed (${t.status}).`);
    const wsUrl = `${origin.replace(/^http/, "ws")}/ws?orchestrationProtocol=2&wsTicket=${encodeURIComponent(t.body.ticket)}`;
    const value = await new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl, { maxPayload: 512 * 1024 * 1024 });
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new T3Error("usage_unavailable", "Usage request timed out."));
      }, 20000);
      ws.on("open", () => ws.send(JSON.stringify({ _tag: "Request", id: "1", tag: "server.getConfig", payload: {}, headers: [] })));
      ws.on("message", (data) => {
        let msg;
        try {
          msg = JSON.parse(String(data));
        } catch {
          return;
        }
        if (msg._tag === "Ping") ws.send(JSON.stringify({ _tag: "Pong" }));
        if (msg._tag !== "Exit" || msg.requestId !== "1") return;
        clearTimeout(timer);
        ws.close();
        if (msg.exit?._tag === "Success") resolve(msg.exit.value);
        else reject(new T3Error("usage_unavailable", "T3 Code didn't return usage."));
      });
      ws.on("unexpected-response", (_req, res) => {
        clearTimeout(timer);
        reject(new T3Error("usage_unavailable", res.statusCode === 426 ? "This T3 Code version changed how it shares usage." : `Usage connection refused (${res.statusCode}).`));
      });
      ws.on("error", (e) => {
        clearTimeout(timer);
        reject(new T3Error("usage_unavailable", e.message));
      });
    });
    return summarizeUsage(value?.providers || []);
  }
}

function summarizeUsage(providers) {
  const pick = (driver) =>
    providers
      .filter((p) => (p.driver || p.instanceId) === driver && p.usageLimits && !p.usageLimits.unavailable && (p.usageLimits.windows || []).length)
      .sort((a, b) => String(b.usageLimits.checkedAt).localeCompare(String(a.usageLimits.checkedAt)))[0];
  const shape = (p, filter) => {
    if (!p) return undefined;
    let windows = (p.usageLimits.windows || []).filter((w) => typeof w.usedPercent === "number");
    if (filter) {
      const only = windows.filter(filter);
      if (only.length) windows = only;
    }
    return {
      checkedAt: p.usageLimits.checkedAt,
      windows: windows.map((w) => ({ id: w.id, kind: w.kind, label: w.label, usedPercent: w.usedPercent, resetsAt: w.resetsAt })),
    };
  };
  return {
    claude: shape(pick("claudeAgent")),
    codex: shape(pick("codex")),
    gemini: shape(pick("antigravity"), (w) => /gemini/i.test(`${w.id} ${w.label}`)),
  };
}

module.exports = { T3Client, T3Error, serverOrigin, readFavorites, SETTINGS_FILE, STORE_DIR, loadStore, saveStore };
