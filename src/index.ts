// maw haos: READ-ONLY view of a Home Assistant OS instance (HA Core + Supervisor).
//
//   maw haos status                      core / supervisor / os versions + update_available, host info, /api/config
//   maw haos addons                      installed add-ons: slug name state version latest update
//   maw haos addon <slug> [--lines N]    one add-on's info + the last N log lines (default 50)
//   maw haos backups                     supervisor backups: name date type size protected
//   maw haos entities [domain] [--search TEXT]   /api/states: entity_id state unit last_changed
//   --json  machine output   --profile NAME  pick a saved profile   --debug  auth diagnostics (no secrets)
//
// How it talks to HA:
//   * HA Core REST (/api/config, /api/states) with a Bearer token.
//   * Supervisor data goes through the HA Core WEBSOCKET ({"type":"supervisor/api", endpoint, method:"get"}),
//     the way the HA frontend does it. Plain REST /api/hassio/* answers 401 with an empty body for most
//     endpoints; that is a closed proxy, not a bad token.
//   * Add-on logs are the exception: /api/hassio/addons/<slug>/logs is text/plain and is served over REST
//     (the websocket proxy only carries JSON, so logs come back empty through it).
//
// Auth, in order: HA_TOKEN (long-lived token) > HA_TOKEN_ENTRY (pass entry holding one) >
// HA_USER + HA_PASSWORD | HA_PASS_ENTRY -> HA login flow (/auth/login_flow -> /auth/token).
// A login-flow access token is cached per profile (~/.cache/maw-haos/<profile>.json, 0600) until it expires.
//
// v1 only ever sends GET requests, plus the three login-flow POSTs. Over the websocket it sends only the
// auth message and supervisor/api calls whose method is "get". Nothing installs, updates, restarts,
// changes options or writes a flow.

type InvokeContext = { source: "cli" | string; args: string[] };
type PluginResult = { ok: boolean; output?: string; error?: string };
type Env = Record<string, string | undefined>;
type J = Record<string, any>;
type FetchFn = (url: string, init?: RequestInit & { tls?: { rejectUnauthorized?: boolean } }) => Promise<Response>;
type PassFn = (entry: string) => string | null; // full text of `pass show <entry>`
export type WSLike = {
  send(data: string): void;
  close(): void;
  onopen: ((ev: any) => void) | null;
  onmessage: ((ev: { data: any }) => void) | null;
  onerror: ((ev: any) => void) | null;
  onclose: ((ev: any) => void) | null;
};
export type WSFactory = (url: string, opts?: { tls?: { rejectUnauthorized?: boolean } }) => WSLike;
export type Store = {
  readConfig(): J; writeConfig(c: J): void; configPath(): string;
  readToken(profile: string): J | null; writeToken(profile: string, t: J | null): void;
  now(): number;
};
type Deps = { env: Env; fetch: FetchFn; pass: PassFn; log: (s: string) => void; store?: Store; ws?: WSFactory };

const HELP = `maw haos — read-only Home Assistant OS view

  maw haos status                           core / supervisor / os versions, updates, host, /api/config
  maw haos addons                           installed add-ons: slug name state version latest update
  maw haos addon <slug> [--lines N]         one add-on: info + last N log lines (default 50)
  maw haos backups                          backups: name date type size protected
  maw haos entities [domain] [--search T]   /api/states: entity_id state unit last_changed

  maw haos config                           show the saved profile (and the file path)
  maw haos config set k=v [k=v ...]         save: host user pass_entry token_entry insecure
  maw haos config unset <key>               remove one saved setting
  maw haos logout                           forget the cached access token of the profile

  --profile NAME  saved profile (default "default", or $HA_PROFILE)    --json  JSON output
  --insecure  accept a self-signed https cert    --debug  auth diagnostics (lengths/booleans only)

  env: HA_HOST  (http://host, host:8123, https://host)   HA_TOKEN  long-lived access token
       HA_TOKEN_ENTRY  pass entry holding a token        HA_USER + HA_PASSWORD | HA_PASS_ENTRY  login flow
  saved config (~/.config/maw-haos/config.json) fills in anything env leaves unset; env always wins.
  passwords and tokens are never saved; a login-flow access token is cached (0600) until it expires.
  supervisor data needs an ADMIN user. read-only: nothing here installs, updates, restarts or changes options.`;

// ---------- args ----------
export function parse(args: string[], env: Env = {}) {
  const rest: string[] = [];
  let json = false, insecure = false, debug = false, lines = 50, search: string | undefined;
  let profile = env.HA_PROFILE || "default";
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--json") json = true;
    else if (a === "--insecure" || a === "-k") insecure = true;
    else if (a === "--debug") debug = true;
    else if (a === "--lines" || a === "-n") lines = Number(args[++i] ?? lines);
    else if (a.startsWith("--lines=")) lines = Number(a.slice(8));
    else if (a === "--search" || a === "-s") search = args[++i];
    else if (a.startsWith("--search=")) search = a.slice(9);
    else if (a === "--profile" || a === "-p") profile = args[++i] ?? profile;
    else if (a.startsWith("--profile=")) profile = a.slice(10);
    else if (a === "-h" || a === "--help") rest.unshift("help");
    else rest.push(a);
  }
  if (!Number.isFinite(lines) || lines < 1) lines = 50;
  return { verb: rest[0] ?? "help", rest: rest.slice(1), json, insecure, debug, lines: Math.floor(lines), search, profile };
}

export function baseUrl(host: string | undefined): string {
  if (!host || !host.trim()) throw new Error("HA_HOST is not set (http://host, host:8123 or https://host)");
  let h = host.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//.test(h)) h = "http://" + h;
  const u = new URL(h);
  // the port is kept exactly as given: HA answers on :8123 by default, but often on :80 or behind a proxy
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}`;
}
export function wsUrl(base: string): string {
  return base.replace(/^http/, "ws") + "/api/websocket";
}

const truthy = (v: string | undefined) => !!v && /^(1|true|yes|on)$/i.test(v);
const PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

// ---------- saved config (named profiles) ----------
// key in a profile -> env var it fills. Secrets (password, token) are deliberately absent.
export const CONFIG_KEYS: Record<string, string> = {
  host: "HA_HOST", user: "HA_USER", pass_entry: "HA_PASS_ENTRY", token_entry: "HA_TOKEN_ENTRY", insecure: "HA_INSECURE",
};
const SECRET_KEYS = ["password", "pass", "token", "access_token", "refresh_token", "secret"];

export function profileOf(cfg: J, name: string): J {
  return (cfg?.profiles && typeof cfg.profiles === "object" && cfg.profiles[name]) || {};
}
export function withProfile(cfg: J, name: string, p: J): J {
  return { ...cfg, profiles: { ...(cfg?.profiles ?? {}), [name]: p } };
}

/** env wins; the saved profile fills only what env leaves unset or empty. */
export function mergeEnv(env: Env, prof: J): Env {
  const out: Env = { ...env };
  for (const [k, v] of Object.entries(CONFIG_KEYS)) {
    if ((out[v] === undefined || out[v] === "") && prof[k] !== undefined && prof[k] !== "") out[v] = String(prof[k]);
  }
  return out;
}

export function configSet(prof: J, pairs: string[]): J {
  const next = { ...prof };
  const items: [string, string][] = [];
  if (pairs.length === 2 && !pairs[0]!.includes("=")) items.push([pairs[0]!, pairs[1]!]);
  else for (const p of pairs) {
    const i = p.indexOf("=");
    if (i < 1) throw new Error(`expected key=value, got: ${p}`);
    items.push([p.slice(0, i), p.slice(i + 1)]);
  }
  if (!items.length) throw new Error("usage: maw haos config set key=value [key=value ...]");
  for (const [rawK, v] of items) {
    const k = rawK.toLowerCase().replace(/-/g, "_");
    if (SECRET_KEYS.includes(k)) throw new Error(`refusing to save '${k}': secrets stay in pass or env, never in the config file (use pass_entry / token_entry)`);
    if (!(k in CONFIG_KEYS)) throw new Error(`unknown key '${rawK}'. keys: ${Object.keys(CONFIG_KEYS).join(" ")}`);
    if (k === "host") baseUrl(v); // validate early
    next[k] = v;
  }
  return next;
}

// ---------- pass entries ----------
/** First line = the secret. A `user:` / `login:` / `username:` line, if any, names the user. */
export function parsePassEntry(text: string | null): { secret?: string; user?: string } {
  if (!text) return {};
  const lines = text.split(/\r?\n/);
  const secret = lines[0]?.trim() || undefined;
  let user: string | undefined;
  for (const l of lines.slice(1)) {
    const m = /^\s*(user|username|login)\s*:\s*(.+?)\s*$/i.exec(l);
    if (m) { user = m[2]; break; }
  }
  return { secret, user };
}

// ---------- auth ----------
export function describeCreds(env: Env, profile: string) {
  // Booleans and lengths only — never values.
  return {
    profile,
    host: !!env.HA_HOST,
    token: (env.HA_TOKEN ?? "").length,
    tokenEntry: !!env.HA_TOKEN_ENTRY,
    user: (env.HA_USER ?? "").length,
    password: (env.HA_PASSWORD ?? "").length,
    passEntry: !!env.HA_PASS_ENTRY,
    insecure: truthy(env.HA_INSECURE),
  };
}

export const NO_CREDS = `no Home Assistant credentials found. Set one of:
  HA_TOKEN=...                                  (long-lived access token of an admin user)
  HA_TOKEN_ENTRY=<pass entry>                   (same, read with 'pass show')
  HA_USER=<user> HA_PASSWORD=...                (login flow)
  HA_USER=<user> HA_PASS_ENTRY=<pass entry>     (login flow, password read with 'pass show')
or save them: maw haos config set host=http://<ha-host>:8123 user=<user> pass_entry=<entry>`;

type Auth = { kind: "token" | "login" | "cached"; token: string };
const T_HTTP = 20_000, T_WS = 30_000;

export class Ha {
  base: string;
  auth?: Auth;
  logins = 0;
  private sock?: WSLike;
  private ready?: Promise<string>;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: J) => void; reject: (e: Error) => void; t: any }>();
  haVersion?: string;

  constructor(private d: Deps, private profile: string, private insecure: boolean) {
    this.base = baseUrl(d.env.HA_HOST);
  }
  private init(extra: RequestInit = {}) {
    return { ...extra, signal: AbortSignal.timeout(T_HTTP), ...(this.insecure ? { tls: { rejectUnauthorized: false } } : {}) };
  }

  async login(): Promise<Auth> {
    if (this.auth) return this.auth;
    const e = this.d.env;
    if (e.HA_TOKEN) return (this.auth = { kind: "token", token: e.HA_TOKEN });
    if (e.HA_TOKEN_ENTRY) {
      const t = parsePassEntry(this.d.pass(e.HA_TOKEN_ENTRY)).secret;
      if (!t) throw new Error(`pass entry for HA_TOKEN_ENTRY could not be read (pass show failed or empty)`);
      return (this.auth = { kind: "token", token: t });
    }
    const st = this.d.store;
    let user = e.HA_USER;
    const cached = st?.readToken(this.profile);
    if (cached && cached.base === this.base && (!user || cached.user === user) && Number(cached.expires) > st!.now() && cached.access_token) {
      return (this.auth = { kind: "cached", token: String(cached.access_token) });
    }
    let pw = e.HA_PASSWORD;
    if (!pw && e.HA_PASS_ENTRY) {
      const p = parsePassEntry(this.d.pass(e.HA_PASS_ENTRY));
      pw = p.secret; if (!user && p.user) user = p.user;
    }
    if (!user || !pw) throw new Error(NO_CREDS);
    return (this.auth = { kind: "login", token: await this.loginFlow(user, pw) });
  }

  /** HA login flow: start -> submit username/password -> exchange the code for an access token. One attempt only. */
  private async loginFlow(user: string, pw: string): Promise<string> {
    this.logins++;
    const clientId = `${this.base}/`;
    const post = async (path: string, body: string, type: string) => {
      const r = await this.d.fetch(`${this.base}${path}`, this.init({ method: "POST", body, headers: { "Content-Type": type } }));
      if (!r.ok) throw new Error(`login failed: HTTP ${r.status} on ${path.replace(/\/[0-9a-f]{16,}$/i, "/<flow>")}`);
      return (await r.json()) as J;
    };
    const start = await post("/auth/login_flow", JSON.stringify({ client_id: clientId, handler: ["homeassistant", null], redirect_uri: clientId }), "application/json");
    if (!start.flow_id) throw new Error("login failed: HA did not start a login flow");
    const done = await post(`/auth/login_flow/${encodeURIComponent(start.flow_id)}`, JSON.stringify({ client_id: clientId, username: user, password: pw }), "application/json");
    if (done.type !== "create_entry" || !done.result) {
      if (done.step_id === "mfa") throw new Error("login needs a second factor (MFA); use a long-lived token instead (HA_TOKEN / token_entry)");
      const why = done.errors ? Object.values(done.errors).join(",") : done.type ?? "unknown";
      throw new Error(`login rejected (${why}); not retrying. HA bans an IP after repeated failures, so check user / password first`);
    }
    const tok = await post("/auth/token", new URLSearchParams({ grant_type: "authorization_code", code: done.result, client_id: clientId }).toString(), "application/x-www-form-urlencoded");
    if (!tok.access_token) throw new Error("login failed: no access_token in /auth/token response");
    const st = this.d.store;
    // keep a minute of slack; the refresh_token is never stored
    const life = Math.max(60, Number(tok.expires_in ?? 1800) - 60) * 1000;
    st?.writeToken(this.profile, { base: this.base, user, access_token: tok.access_token, expires: st.now() + life });
    return String(tok.access_token);
  }

  /** A cached token was refused: forget it and log in once more. Returns true if a retry makes sense. */
  private async dropCached(): Promise<boolean> {
    if (this.auth?.kind !== "cached") return false;
    this.d.store?.writeToken(this.profile, null);
    this.auth = undefined;
    this.closeWs();
    await this.login();
    return true;
  }

  private async http(path: string, accept = "application/json"): Promise<Response> {
    let a = await this.login();
    let r = await this.d.fetch(`${this.base}${path}`, this.init({ method: "GET", headers: { Authorization: `Bearer ${a.token}`, Accept: accept } }));
    if (r.status === 401 && (await this.dropCached())) {
      a = await this.login();
      r = await this.d.fetch(`${this.base}${path}`, this.init({ method: "GET", headers: { Authorization: `Bearer ${a.token}`, Accept: accept } }));
    }
    if (r.status === 401) throw new Error(`HTTP 401 on ${path} (${a.kind} token rejected)`);
    return r;
  }
  async rest<T = any>(path: string): Promise<T> {
    const r = await this.http(path);
    if (!r.ok) throw new Error(`HTTP ${r.status} on ${path}: ${(await r.text()).slice(0, 200)}`);
    return (await r.json()) as T;
  }
  async restText(path: string): Promise<{ status: number; text: string }> {
    const r = await this.http(path, "text/plain");
    return { status: r.status, text: r.ok ? await r.text() : "" };
  }

  // ---- websocket ----
  private connect(token: string): Promise<string> {
    if (!this.d.ws) return Promise.reject(new Error("no WebSocket available in this runtime"));
    return new Promise<string>((resolve, reject) => {
      const s = this.d.ws!(wsUrl(this.base), this.insecure ? { tls: { rejectUnauthorized: false } } : undefined);
      this.sock = s;
      let authed = false;
      const t = setTimeout(() => { reject(new Error("websocket: no auth answer within 30s")); this.closeWs(); }, T_WS);
      s.onerror = () => { clearTimeout(t); if (!authed) reject(new Error(`websocket error (${wsUrl(this.base).replace(/\/\/[^/]+/, "//<host>")})`)); };
      s.onclose = () => {
        clearTimeout(t);
        if (!authed) reject(new Error("websocket closed before auth"));
        for (const [, p] of this.pending) { clearTimeout(p.t); p.reject(new Error("websocket closed")); }
        this.pending.clear();
        if (this.sock === s) { this.sock = undefined; this.ready = undefined; }
      };
      s.onmessage = (ev) => {
        let m: J;
        try { m = JSON.parse(String(ev.data)); } catch { return; }
        if (m.type === "auth_required") return s.send(JSON.stringify({ type: "auth", access_token: token }));
        if (m.type === "auth_ok") { authed = true; clearTimeout(t); return resolve(String(m.ha_version ?? "?")); }
        if (m.type === "auth_invalid") { clearTimeout(t); return reject(new AuthInvalid()); }
        if (typeof m.id === "number" && this.pending.has(m.id)) {
          const p = this.pending.get(m.id)!; this.pending.delete(m.id); clearTimeout(p.t); p.resolve(m);
        }
      };
    });
  }
  private async ensureWs(): Promise<void> {
    if (this.ready) { await this.ready; return; }
    const a = await this.login();
    this.ready = this.connect(a.token);
    try { this.haVersion = await this.ready; }
    catch (e) {
      this.ready = undefined; this.closeWs();
      if (e instanceof AuthInvalid && (await this.dropCached())) {
        this.ready = this.connect(this.auth!.token);
        try { this.haVersion = await this.ready; return; } catch (e2) { this.ready = undefined; this.closeWs(); throw wsErr(e2, this.auth!.kind); }
      }
      throw wsErr(e, a.kind);
    }
  }
  /** One Supervisor GET, tunnelled over the HA websocket. The method is fixed to "get": there is no other. */
  async sup<T = any>(endpoint: string): Promise<T> {
    if (!/^\/[A-Za-z0-9_\-/.]*$/.test(endpoint)) throw new Error(`bad supervisor endpoint: ${endpoint}`);
    await this.ensureWs();
    const id = this.nextId++;
    const m = await new Promise<J>((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error(`supervisor ${endpoint}: timed out after 30s`)); }, T_WS);
      this.pending.set(id, { resolve, reject, t });
      this.sock!.send(JSON.stringify({ id, type: "supervisor/api", endpoint, method: "get" }));
    });
    if (m.success === false) {
      const msg = m.error?.message || m.error?.code || "error";
      throw new Error(`supervisor ${endpoint}: ${msg}${/unknown_command/i.test(String(m.error?.code)) ? " (no Supervisor here: HA Container/Core?)" : ""}`);
    }
    return m.result as T;
  }
  private closeWs() { try { this.sock?.close(); } catch {} this.sock = undefined; this.ready = undefined; }
  close() { this.closeWs(); }
}
class AuthInvalid extends Error { constructor() { super("websocket auth_invalid"); } }
function wsErr(e: unknown, kind: string): Error {
  if (e instanceof AuthInvalid) return new Error(`websocket auth_invalid (${kind} token rejected)`);
  return e as Error;
}

// ---------- formatting ----------
export function bytes(n: unknown): string {
  const v = Number(n);
  if (!Number.isFinite(v) || n == null) return "-";
  const u = ["B", "K", "M", "G", "T", "P"];
  let i = 0, x = v;
  while (x >= 1024 && i < u.length - 1) { x /= 1024; i++; }
  return `${x >= 100 || i === 0 ? x.toFixed(0) : x.toFixed(1)}${u[i]}`;
}
/** ISO time -> "YYYY-MM-DD HH:MM" in the local zone (TZ). */
export function when(iso: unknown, tz = process.env.TZ): string {
  if (!iso) return "-";
  const d = new Date(String(iso));
  if (Number.isNaN(d.getTime())) return String(iso);
  return new Intl.DateTimeFormat("sv-SE", { timeZone: tz || undefined, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
}
export function table(head: string[], rows: unknown[][]): string {
  const cells = [head, ...rows.map((r) => r.map((c) => (c == null || c === "" ? "-" : String(c))))];
  const w = head.map((_, i) => Math.max(...cells.map((r) => (r[i] ?? "").length)));
  return cells.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(w[i]!))).join("  ").trimEnd()).join("\n");
}
const yn = (v: unknown) => (v === true ? "yes" : v === false ? "no" : "-");
const upd = (v: unknown) => (v === true ? "UPDATE" : v === false ? "" : "-");

/** Supervisor backup size: newer versions give size_bytes, older give size in MB. */
export function backupBytes(b: J): number | null {
  if (b.size_bytes != null) return Number(b.size_bytes);
  if (b.size != null) return Number(b.size) * 1024 * 1024;
  return null;
}

/** Add-on info without option VALUES (they often hold passwords / API keys). */
export function redactAddon(info: J): J {
  const { options, ...rest } = info ?? {};
  return { ...rest, ...(options && typeof options === "object" ? { options_keys: Object.keys(options) } : {}) };
}

export function tail(text: string, n: number): string[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  return lines.slice(-n);
}

// ---------- handler ----------
export async function run(args: string[], d: Deps): Promise<PluginResult> {
  const o = parse(args, d.env);
  const ok = (output: string): PluginResult => ({ ok: true, output });
  const js = (v: unknown): PluginResult => ok(JSON.stringify(v, null, 1));
  const fail = (error: string): PluginResult => ({ ok: false, error });
  if (o.verb === "help") return ok(HELP);
  if (!PROFILE_RE.test(o.profile)) return fail(`bad profile name '${o.profile}' (letters, digits, . _ -)`);

  if (o.verb === "config") {
    if (!d.store) return fail("no config store available");
    try {
      const cfg = d.store.readConfig();
      const prof = profileOf(cfg, o.profile);
      const sub = o.rest[0];
      if (!sub || sub === "show") {
        const names = Object.keys(cfg.profiles ?? {}).sort();
        if (o.json) return js({ path: d.store.configPath(), profile: o.profile, profiles: cfg.profiles ?? {} });
        const rows = Object.keys(CONFIG_KEYS).map((k) => [k, prof[k] ?? "-", d.env[CONFIG_KEYS[k]!] ? `env ${CONFIG_KEYS[k]} overrides` : ""]);
        return ok(`${d.store.configPath()}\nprofile: ${o.profile}    saved profiles: ${names.join(" ") || "(none)"}\n${table(["key", "saved", "note"], rows)}`);
      }
      if (sub === "path") return ok(d.store.configPath());
      if (sub === "set") {
        const next = configSet(prof, o.rest.slice(1));
        d.store.writeConfig(withProfile(cfg, o.profile, next));
        return ok(`saved profile '${o.profile}' to ${d.store.configPath()}`);
      }
      if (sub === "unset") {
        const k = (o.rest[1] ?? "").toLowerCase().replace(/-/g, "_");
        if (!(k in CONFIG_KEYS)) return fail(`unknown key '${o.rest[1] ?? ""}'. keys: ${Object.keys(CONFIG_KEYS).join(" ")}`);
        const next = { ...prof }; delete next[k];
        d.store.writeConfig(withProfile(cfg, o.profile, next));
        return ok(`removed ${k} from profile '${o.profile}'`);
      }
      return fail(`usage: maw haos config [show|path|set k=v ...|unset key] [--profile NAME]`);
    } catch (e) { return fail((e as Error).message); }
  }
  if (o.verb === "logout") { d.store?.writeToken(o.profile, null); return ok(`cached token of profile '${o.profile}' removed`); }

  const known = ["status", "addons", "addon", "backups", "entities"];
  if (!known.includes(o.verb)) return fail(`unknown command: ${o.verb}\n\n${HELP}`);
  if (d.store) d = { ...d, env: mergeEnv(d.env, profileOf(d.store.readConfig(), o.profile)) };

  let ha: Ha | undefined;
  try {
    if (o.debug) d.log(`[debug] ${JSON.stringify(describeCreds(d.env, o.profile))}`);
    ha = new Ha(d, o.profile, o.insecure || truthy(d.env.HA_INSECURE));
    const h = ha;
    const dbg = () => { if (o.debug) d.log(`[debug] auth=${h.auth?.kind ?? "none"} logins=${h.logins} ha_ws=${h.haVersion ?? "-"}`); };

    if (o.verb === "status") {
      const soft = <T>(p: Promise<T>) => p.then((v) => ({ v }), (e: Error) => ({ err: e.message }));
      const cfg = await h.rest<J>("/api/config");
      const [info, core, os, sup, host] = [
        await soft(h.sup<J>("/info")), await soft(h.sup<J>("/core/info")), await soft(h.sup<J>("/os/info")),
        await soft(h.sup<J>("/supervisor/info")), await soft(h.sup<J>("/host/info")),
      ] as { v?: J; err?: string }[];
      dbg();
      const out = {
        config: { location_name: cfg.location_name, version: cfg.version, state: cfg.state, time_zone: cfg.time_zone, unit_system: cfg.unit_system?.temperature, safe_mode: cfg.safe_mode ?? cfg.recovery_mode, components: Array.isArray(cfg.components) ? cfg.components.length : undefined },
        info: info!.v ?? null, core: core!.v ?? null, os: os!.v ?? null, supervisor: sup!.v ? { ...sup!.v, addons: undefined, addons_repositories: undefined } : null, host: host!.v ?? null,
        errors: Object.fromEntries([["info", info], ["core", core], ["os", os], ["supervisor", sup], ["host", host]].filter(([, x]) => (x as any).err).map(([k, x]) => [k, (x as any).err])),
      };
      if (o.json) return js(out);
      const c = core!.v ?? {}, s = sup!.v ?? {}, so = os!.v ?? {}, ho = host!.v ?? {}, inf = info!.v ?? {};
      const ver = (cur: unknown, latest: unknown, u: unknown) => `${cur ?? "-"}${latest && latest !== cur ? `  (latest ${latest})` : ""}${u === true ? "  UPDATE AVAILABLE" : ""}`;
      const rows: unknown[][] = [
        ["name", cfg.location_name],
        ["state", cfg.state],
        ["core", ver(c.version ?? cfg.version, c.version_latest, c.update_available)],
        ["supervisor", sup!.v ? `${ver(s.version, s.version_latest, s.update_available)}  channel ${s.channel ?? "-"}  healthy ${yn(s.healthy)}  supported ${yn(s.supported)}` : `- (${sup!.err})`],
        ["os", os!.v ? `${ver(so.version, so.version_latest, so.update_available)}  board ${so.board ?? "-"}` : `- (${os!.err})`],
        ["host", `${ho.hostname ?? inf.hostname ?? "-"}  ${ho.operating_system ?? inf.operating_system ?? ""}  kernel ${ho.kernel ?? "-"}  ${inf.arch ?? ""} ${inf.machine ?? ""}`.replace(/\s+/g, " ").trim()],
        ["disk", ho.disk_total != null ? `${ho.disk_used ?? "?"} / ${ho.disk_total} GB used, ${ho.disk_free ?? "?"} GB free` : "-"],
        ["time zone", cfg.time_zone],
        ["components", out.config.components],
      ];
      if (out.config.safe_mode) rows.push(["SAFE/RECOVERY MODE", "yes"]);
      const errs = Object.entries(out.errors);
      return ok(table(["field", "value"], rows) + (errs.length ? `\n\nnot available: ${errs.map(([k, v]) => `${k} (${v})`).join("; ")}` : ""));
    }

    if (o.verb === "addons") {
      const r = await h.sup<J>("/addons");
      dbg();
      const list = (Array.isArray(r?.addons) ? r.addons : []).map((a: J) => ({
        slug: a.slug, name: a.name, state: a.state, version: a.version, version_latest: a.version_latest, update_available: a.update_available,
      })).sort((a: J, b: J) => String(a.slug).localeCompare(String(b.slug)));
      if (o.json) return js(list);
      const nu = list.filter((a: J) => a.update_available).length;
      return ok(table(["slug", "name", "state", "version", "latest", "update"],
        list.map((a: J) => [a.slug, a.name, a.state, a.version, a.version_latest, upd(a.update_available)]))
        + `\n\n${list.length} add-ons${nu ? `, ${nu} with an update` : ""}`);
    }

    if (o.verb === "addon") {
      const slug = o.rest[0];
      if (!slug || !/^[A-Za-z0-9_\-]+$/.test(slug)) return fail("usage: maw haos addon <slug> [--lines N]   (slugs: maw haos addons)");
      const info = redactAddon(await h.sup<J>(`/addons/${slug}/info`));
      const lg = await h.restText(`/api/hassio/addons/${slug}/logs`).catch((e: Error) => ({ status: 0, text: "", err: e.message }));
      dbg();
      const lines = lg.status === 200 ? tail(lg.text, o.lines) : [];
      const logNote = lg.status === 200 ? (lines.length ? "" : "(log is empty)") : `(logs not available: ${(lg as any).err ?? `HTTP ${lg.status}`})`;
      if (o.json) return js({ info, logs: lines, ...(logNote ? { logs_note: logNote } : {}) });
      const head = table(["field", "value"], [
        ["name", info.name], ["slug", info.slug ?? slug], ["state", info.version ? info.state : "not installed (store entry)"],
        ["version", `${info.version ?? "-"}${info.version_latest && info.version_latest !== info.version ? `  (latest ${info.version_latest})` : ""}${info.update_available ? "  UPDATE AVAILABLE" : ""}`],
        ["boot", info.boot], ["auto_update", yn(info.auto_update)], ["watchdog", yn(info.watchdog)],
        ["repository", info.repository], ["ingress", info.ingress ? `yes  panel ${yn(info.ingress_panel)}` : "no"],
        ["url", info.url], ["options", (info.options_keys ?? []).join(" ") || "-"],
      ]);
      return ok(`${head}\n\nlast ${o.lines} log lines ${logNote}\n${lines.join("\n")}`.trimEnd());
    }

    if (o.verb === "backups") {
      const r = await h.sup<J>("/backups");
      dbg();
      const list = (Array.isArray(r?.backups) ? r.backups : []).map((b: J) => ({
        slug: b.slug, name: b.name, date: b.date, type: b.type, size_bytes: backupBytes(b), protected: b.protected,
        location: b.locations ?? b.location ?? null,
      })).sort((a: J, b: J) => String(b.date).localeCompare(String(a.date)));
      if (o.json) return js(list);
      return ok(table(["date", "name", "type", "size", "protected", "location", "slug"],
        list.map((b: J) => [when(b.date), b.name, b.type, bytes(b.size_bytes), yn(b.protected),
          Array.isArray(b.location) ? b.location.map((l: unknown) => l ?? "local").join(",") : (b.location ?? "local"), b.slug]))
        + `\n\n${list.length} backups`);
    }

    if (o.verb === "entities") {
      const domain = o.rest[0];
      if (domain && !/^[a-z0-9_]+$/.test(domain)) return fail("usage: maw haos entities [domain] [--search TEXT]   (domain like sensor, light, switch)");
      const states = await h.rest<J[]>("/api/states");
      dbg();
      const q = (o.search ?? "").toLowerCase();
      const rows = states
        .filter((s) => !domain || String(s.entity_id).startsWith(`${domain}.`))
        .filter((s) => !q || String(s.entity_id).toLowerCase().includes(q) || String(s.attributes?.friendly_name ?? "").toLowerCase().includes(q))
        .map((s) => ({ entity_id: s.entity_id, state: s.state, unit: s.attributes?.unit_of_measurement ?? null, last_changed: s.last_changed, name: s.attributes?.friendly_name ?? null }))
        .sort((a, b) => String(a.entity_id).localeCompare(String(b.entity_id)));
      // attributes are not passed through: some (camera entity_picture) carry access tokens
      if (o.json) return js(rows);
      return ok(table(["entity_id", "state", "unit", "last_changed", "name"],
        rows.map((r) => [r.entity_id, String(r.state ?? "").slice(0, 40), r.unit, when(r.last_changed), r.name]))
        + `\n\n${rows.length} of ${states.length} entities`);
    }
    return fail(`unknown command: ${o.verb}`);
  } catch (e) {
    return fail((e as Error).message);
  } finally {
    ha?.close();
  }
}

// ---------- real deps ----------
function passShow(entry: string): string | null {
  try {
    const p = Bun.spawnSync(["pass", "show", entry], { stdout: "pipe", stderr: "pipe" });
    if (p.exitCode !== 0) return null;
    return p.stdout.toString() || null;
  } catch {
    return null;
  }
}

export function fileStore(env: Env = process.env): Store {
  const { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync, renameSync } = require("node:fs") as typeof import("node:fs");
  const { join, dirname } = require("node:path") as typeof import("node:path");
  const home = env.HOME ?? "";
  const cfgPath = join(env.XDG_CONFIG_HOME || join(home, ".config"), "maw-haos", "config.json");
  const tokPath = (p: string) => join(env.XDG_CACHE_HOME || join(home, ".cache"), "maw-haos", `${p}.json`);
  const read = (p: string): J | null => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };
  const write = (p: string, v: J) => {
    mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, JSON.stringify(v, null, 2) + "\n", { mode: 0o600 });
    chmodSync(tmp, 0o600); renameSync(tmp, p);
  };
  return {
    configPath: () => cfgPath,
    readConfig: () => read(cfgPath) ?? {},
    writeConfig: (c) => write(cfgPath, c),
    readToken: (p) => (PROFILE_RE.test(p) ? read(tokPath(p)) : null),
    writeToken: (p, t) => {
      if (!PROFILE_RE.test(p)) return;
      if (t) write(tokPath(p), t); else if (existsSync(tokPath(p))) write(tokPath(p), {});
    },
    now: () => Date.now(),
  };
}

// maw prints a plugin's returned output and exits right away; when stdout is a pipe only the first
// 64 KiB (one pipe buffer) gets out. Big CLI output (entities --json on a large install) is therefore
// written here, synchronously, before returning.
export const DIRECT_WRITE_BYTES = 16 * 1024;
export function writeAllSync(fd: number, text: string, write: (fd: number, b: Uint8Array) => number = defaultWrite): void {
  const buf = new TextEncoder().encode(text);
  let off = 0, spins = 0;
  while (off < buf.length) {
    try {
      const n = write(fd, buf.subarray(off));
      off += n; spins = 0;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EAGAIN" && spins++ < 10000) { Bun.sleepSync(1); continue; }
      throw e;
    }
  }
}
function defaultWrite(fd: number, b: Uint8Array): number {
  return (require("node:fs") as typeof import("node:fs")).writeSync(fd, b);
}

const realWs: WSFactory = (url, opts) => new (WebSocket as any)(url, opts ?? {}) as WSLike;

export async function handler(ctx: InvokeContext): Promise<PluginResult> {
  const r = await run(ctx.args, { env: process.env, fetch: fetch as unknown as FetchFn, pass: passShow, log: (s) => console.error(s), store: fileStore(), ws: realWs });
  if (ctx.source === "cli" && r.output && r.output.length > DIRECT_WRITE_BYTES) {
    writeAllSync(1, r.output.endsWith("\n") ? r.output : r.output + "\n");
    return { ok: r.ok, ...(r.error ? { error: r.error } : {}) };
  }
  return r;
}

export default handler;

if (import.meta.main) {
  const result = await handler({ source: "cli", args: process.argv.slice(2) });
  if (result.output) console.log(result.output);
  if (result.error) console.error(result.error);
  process.exit(result.ok ? 0 : 1);
}
