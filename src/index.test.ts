import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  backupBytes, baseUrl, bytes, configSet, mergeEnv, NO_CREDS, parse, parsePassEntry, redactAddon, run, table, tail, writeAllSync, wsUrl,
  type Store, type WSLike,
} from "./index";

// All values here are fake: ha.example.test, users "reader"/"admin", add-ons "addon_a"/"addon_b".
const HOST = "http://ha.example.test:8123";
const LLAT = "llat-fake-0000";

const SUP: Record<string, unknown> = {
  "/info": { hostname: "ha-box", operating_system: "Home Assistant OS 99.1", arch: "amd64", machine: "qemux86-64", supervisor: "2099.1.0", homeassistant: "2099.1.1" },
  "/core/info": { version: "2099.1.1", version_latest: "2099.2.0", update_available: true },
  "/os/info": { version: "99.1", version_latest: "99.1", update_available: false, board: "ova" },
  "/supervisor/info": { version: "2099.1.0", version_latest: "2099.1.0", update_available: false, channel: "stable", healthy: true, supported: true, addons: [{ slug: "x" }] },
  "/host/info": { hostname: "ha-box", operating_system: "Home Assistant OS 99.1", kernel: "6.6.0", disk_total: 30.8, disk_used: 10.2, disk_free: 19.1 },
  "/addons": { addons: [
    { slug: "addon_b", name: "Add-on B", state: "stopped", version: "1.0.0", version_latest: "1.0.0", update_available: false },
    { slug: "addon_a", name: "Add-on A", state: "started", version: "2.0.0", version_latest: "2.1.0", update_available: true },
  ] },
  "/addons/addon_a/info": { name: "Add-on A", slug: "addon_a", state: "started", version: "2.0.0", version_latest: "2.1.0", update_available: true, boot: "auto", watchdog: true, auto_update: false, repository: "core", ingress: true, ingress_panel: true, options: { api_key: "SUPER-SECRET-KEY", port: 1234 } },
  "/backups": { backups: [
    { slug: "aaaa1111", name: "old full", date: "2099-01-01T03:00:00+00:00", type: "full", size: 512.5, protected: false, location: null },
    { slug: "bbbb2222", name: "new partial", date: "2099-01-05T03:00:00+00:00", type: "partial", size_bytes: 2 ** 30, protected: true, locations: [null, "nas"] },
  ] },
};
const REST: Record<string, unknown> = {
  "/api/config": { location_name: "Test Home", version: "2099.1.1", state: "RUNNING", time_zone: "UTC", unit_system: { temperature: "°C" }, components: ["a", "b", "c"] },
  "/api/states": [
    { entity_id: "sensor.room_temperature", state: "24.5", attributes: { unit_of_measurement: "°C", friendly_name: "Room Temperature" }, last_changed: "2099-01-05T10:00:00+00:00" },
    { entity_id: "sensor.power", state: "120", attributes: { unit_of_measurement: "W", friendly_name: "Power" }, last_changed: "2099-01-05T10:00:00+00:00" },
    { entity_id: "light.desk", state: "on", attributes: { friendly_name: "Desk Temperature Lamp" }, last_changed: "2099-01-05T09:00:00+00:00" },
    { entity_id: "camera.door", state: "idle", attributes: { entity_picture: "/api/camera_proxy/camera.door?token=CAMTOKEN", friendly_name: "Door" }, last_changed: "2099-01-05T08:00:00+00:00" },
  ],
};

type Call = { url: string; method: string; headers: Record<string, string>; body?: string };
type Opts = { password?: string; flowStatus?: number; wsReject?: (tok: string) => boolean; restReject?: (tok: string) => boolean; logsStatus?: number; mfa?: boolean; noSupervisor?: boolean };
function mock(o: Opts = {}) {
  const calls: Call[] = [];
  const wsSent: any[] = [];
  const wsUrls: string[] = [];
  let tokN = 0;
  const fetch = async (url: string, init: any = {}) => {
    const method = init.method ?? "GET";
    calls.push({ url, method, headers: init.headers ?? {}, body: init.body?.toString() });
    const path = url.slice(HOST.length);
    if (path === "/auth/login_flow" && method === "POST") return o.flowStatus ? new Response("", { status: o.flowStatus }) : Response.json({ flow_id: "0123456789abcdef0123", type: "form" });
    if (path.startsWith("/auth/login_flow/") && method === "POST") {
      const b = JSON.parse(init.body);
      if (o.mfa) return Response.json({ type: "form", step_id: "mfa" });
      if (b.password === (o.password ?? "s3cret-pw")) return Response.json({ type: "create_entry", result: "auth-code-1" });
      return Response.json({ type: "form", step_id: "init", errors: { base: "invalid_auth" } });
    }
    if (path === "/auth/token" && method === "POST") return Response.json({ access_token: `acc-${++tokN}`, expires_in: 1800, refresh_token: "REFRESH-NEVER-STORE", token_type: "Bearer" });
    const tok = String(init.headers?.Authorization ?? "").replace(/^Bearer /, "");
    if (o.restReject?.(tok)) return new Response("", { status: 401 });
    if (path.endsWith("/logs") && path.startsWith("/api/hassio/addons/")) {
      if (o.logsStatus && o.logsStatus !== 200) return new Response("", { status: o.logsStatus });
      return new Response(Array.from({ length: 80 }, (_, i) => `log line ${i + 1}`).join("\n") + "\n", { status: 200, headers: { "Content-Type": "text/plain" } });
    }
    if (path in REST) return Response.json(REST[path]);
    return new Response("not found", { status: 404 });
  };
  const ws = (url: string): WSLike => {
    wsUrls.push(url);
    const s: WSLike = {
      onopen: null, onmessage: null, onerror: null, onclose: null,
      send(data: string) {
        const m = JSON.parse(data); wsSent.push(m);
        const reply = (v: any) => queueMicrotask(() => s.onmessage?.({ data: JSON.stringify(v) }));
        if (m.type === "auth") return reply(o.wsReject?.(m.access_token) ? { type: "auth_invalid", message: "bad" } : { type: "auth_ok", ha_version: "2099.1.1" });
        if (m.type === "supervisor/api") {
          if (o.noSupervisor) return reply({ id: m.id, type: "result", success: false, error: { code: "unknown_command", message: "Unknown command." } });
          if (m.endpoint in SUP) return reply({ id: m.id, type: "result", success: true, result: SUP[m.endpoint] });
          return reply({ id: m.id, type: "result", success: false, error: { code: "unknown_error", message: "not found" } });
        }
      },
      close() {},
    };
    queueMicrotask(() => s.onmessage?.({ data: JSON.stringify({ type: "auth_required", ha_version: "2099.1.1" }) }));
    return s;
  };
  return { calls, fetch, ws, wsSent, wsUrls };
}

function memStore(cfg: Record<string, any> = {}, t0 = 1_000_000) {
  const st = { cfg, tokens: {} as Record<string, any>, clock: t0 };
  const store: Store = {
    configPath: () => "/fake/config.json",
    readConfig: () => JSON.parse(JSON.stringify(st.cfg)),
    writeConfig: (c) => { st.cfg = c; },
    readToken: (p) => st.tokens[p] ?? null,
    writeToken: (p, t) => { if (t) st.tokens[p] = t; else delete st.tokens[p]; },
    now: () => st.clock,
  };
  return { st, store };
}

const TOKEN_ENV = { HA_HOST: HOST, HA_TOKEN: LLAT };
const LOGIN_ENV = { HA_HOST: HOST, HA_USER: "admin", HA_PASS_ENTRY: "some/entry" };
async function go(args: string[], env: Record<string, string> = TOKEN_ENV, m = mock(), pass = (_: string) => "s3cret-pw\nuser: admin\n" as string | null, store?: Store) {
  const logs: string[] = [];
  const r = await run(args, { env, fetch: m.fetch as any, pass, log: (s) => logs.push(s), ws: m.ws as any, store });
  return { r, m, logs };
}

test("parse flags", () => {
  expect(parse(["addon", "addon_a", "--lines", "5", "--json", "--profile", "lab"])).toMatchObject({ verb: "addon", rest: ["addon_a"], lines: 5, json: true, profile: "lab" });
  expect(parse([]).verb).toBe("help");
  expect(parse(["status"], { HA_PROFILE: "x" }).profile).toBe("x");
  expect(parse(["entities", "sensor", "--search=temp"])).toMatchObject({ rest: ["sensor"], search: "temp" });
  expect(parse(["addon", "a", "--lines", "z"]).lines).toBe(50);
});

test("baseUrl keeps the port as given; ws url follows the scheme", () => {
  expect(baseUrl("ha.example.test")).toBe("http://ha.example.test");
  expect(baseUrl("10.0.0.5:8123")).toBe("http://10.0.0.5:8123");
  expect(baseUrl("https://ha.example.test/")).toBe("https://ha.example.test");
  expect(wsUrl("https://ha.example.test")).toBe("wss://ha.example.test/api/websocket");
  expect(wsUrl("http://10.0.0.5")).toBe("ws://10.0.0.5/api/websocket");
  expect(() => baseUrl(undefined)).toThrow(/HA_HOST/);
});

test("helpers", () => {
  expect(bytes(1536)).toBe("1.5K");
  expect(table(["a", "bb"], [["xxx", 1]])).toBe("a    bb\nxxx  1");
  expect(parsePassEntry("pw\nlogin: bob\n")).toEqual({ secret: "pw", user: "bob" });
  expect(parsePassEntry("pw")).toEqual({ secret: "pw", user: undefined });
  expect(parsePassEntry(null)).toEqual({});
  expect(backupBytes({ size: 1 })).toBe(1048576);
  expect(backupBytes({ size_bytes: 5, size: 1 })).toBe(5);
  expect(redactAddon({ a: 1, options: { k: "v" } })).toEqual({ a: 1, options_keys: ["k"] });
  expect(tail("a\n\nb\nc\n", 2)).toEqual(["b", "c"]);
});

test("no credentials -> clear error, no request sent", async () => {
  const { r, m } = await go(["addons"], { HA_HOST: HOST });
  expect(r.ok).toBe(false);
  expect(r.error).toBe(NO_CREDS);
  expect(m.calls.length).toBe(0);
  expect(m.wsUrls.length).toBe(0);
});

test("missing HA_HOST -> error", async () => {
  const { r } = await go(["status"], { HA_TOKEN: LLAT });
  expect(r.ok).toBe(false); expect(r.error).toMatch(/HA_HOST/);
});

test("long-lived token: bearer on REST, ws auth, no login flow", async () => {
  const { r, m } = await go(["status"]);
  expect(r.ok).toBe(true);
  expect(m.calls.some((c) => c.url.includes("/auth/"))).toBe(false);
  expect(m.calls[0]!.headers.Authorization).toBe(`Bearer ${LLAT}`);
  expect(m.wsSent[0]).toEqual({ type: "auth", access_token: LLAT });
  expect(m.wsUrls[0]).toBe("ws://ha.example.test:8123/api/websocket");
  expect(r.output).toMatch(/core\s+2099\.1\.1  \(latest 2099\.2\.0\)  UPDATE AVAILABLE/);
  expect(r.output).toMatch(/supervisor\s+2099\.1\.0  channel stable/);
  expect(r.output).toMatch(/os\s+99\.1  board ova/);
  expect(r.output).toMatch(/disk\s+10\.2 \/ 30\.8 GB used, 19\.1 GB free/);
  expect(r.output).toMatch(/name\s+Test Home/);
});

test("token from a pass entry (token_entry)", async () => {
  const seen: string[] = [];
  const { r, m } = await go(["addons"], { HA_HOST: HOST, HA_TOKEN_ENTRY: "ha/token" }, mock(), (e) => (seen.push(e), `${LLAT}\n`));
  expect(r.ok).toBe(true); expect(seen).toEqual(["ha/token"]);
  expect(m.wsSent[0].access_token).toBe(LLAT);
});

test("login flow with password from pass; user from the entry's user: line; secrets never logged", async () => {
  const { st, store } = memStore();
  const { r, m, logs } = await go(["addons", "--debug"], { HA_HOST: HOST, HA_PASS_ENTRY: "some/entry" }, mock(), () => "s3cret-pw\nuser: admin\n", store);
  expect(r.ok).toBe(true);
  const posts = m.calls.filter((c) => c.method === "POST").map((c) => c.url.slice(HOST.length));
  expect(posts).toEqual(["/auth/login_flow", "/auth/login_flow/0123456789abcdef0123", "/auth/token"]);
  expect(JSON.parse(m.calls[1]!.body!)).toMatchObject({ username: "admin", password: "s3cret-pw" });
  expect(m.wsSent[0]).toEqual({ type: "auth", access_token: "acc-1" });
  expect(st.tokens.default).toMatchObject({ access_token: "acc-1", user: "admin", base: HOST, expires: 1_000_000 + 1740 * 1000 });
  expect(JSON.stringify(st.tokens)).not.toContain("REFRESH");
  const all = logs.join("\n") + (r.output ?? "");
  expect(all).not.toContain("s3cret"); expect(all).not.toContain("acc-1");
  expect(logs.join("\n")).toContain('"passEntry":true');
  expect(r.output).toMatch(/addon_a\s+Add-on A\s+started\s+2\.0\.0\s+2\.1\.0\s+UPDATE/);
  expect(r.output!.indexOf("addon_a")).toBeLessThan(r.output!.indexOf("addon_b"));
});

test("wrong password: one attempt, status reported, no retry, nothing cached", async () => {
  const { st, store } = memStore();
  const { r, m } = await go(["addons"], { HA_HOST: HOST, HA_USER: "admin", HA_PASSWORD: "wrong" }, mock(), undefined, store);
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/login rejected \(invalid_auth\); not retrying/);
  expect(m.calls.filter((c) => c.url.includes("/auth/login_flow/")).length).toBe(1);
  expect(st.tokens.default).toBeUndefined();
  const h = await go(["addons"], LOGIN_ENV, mock({ flowStatus: 403 }));
  expect(h.r.error).toBe("login failed: HTTP 403 on /auth/login_flow");
  expect((await go(["addons"], LOGIN_ENV, mock({ mfa: true }))).r.error).toMatch(/MFA/);
});

test("access token cached per profile and reused; expiry forces a fresh login", async () => {
  const { st, store } = memStore({ profiles: { lab: { host: HOST, user: "admin", pass_entry: "x/y" } } });
  let passCalls = 0;
  const pass = () => { passCalls++; return "s3cret-pw"; };
  const a = await go(["addons", "--profile", "lab"], {}, mock(), pass, store);
  expect(a.r.ok).toBe(true); expect(passCalls).toBe(1);
  expect(st.tokens.lab.access_token).toBe("acc-1");
  const b = await go(["backups", "--profile", "lab"], {}, mock(), pass, store);
  expect(b.r.ok).toBe(true); expect(passCalls).toBe(1);
  expect(b.m.calls.some((c) => c.url.includes("/auth/"))).toBe(false);
  expect(b.m.wsSent[0].access_token).toBe("acc-1");
  st.clock += 1741 * 1000;
  const c = await go(["addons", "--profile", "lab"], {}, mock(), pass, store);
  expect(c.m.calls.filter((x) => x.url.endsWith("/auth/token")).length).toBe(1);
  expect(passCalls).toBe(2);
  expect((await go(["logout", "--profile", "lab"], {}, mock(), pass, store)).r.ok).toBe(true);
  expect(st.tokens.lab).toBeUndefined();
});

test("stale cached token: ws auth_invalid -> cache dropped, one fresh login", async () => {
  const { st, store } = memStore({ profiles: { default: { host: HOST, user: "admin", pass_entry: "x/y" } } });
  st.tokens.default = { base: HOST, user: "admin", access_token: "stale", expires: st.clock + 1e9 };
  const m = mock({ wsReject: (t) => t === "stale", restReject: (t) => t === "stale" });
  const { r } = await go(["addons"], {}, m, () => "s3cret-pw", store);
  expect(r.ok).toBe(true);
  expect(st.tokens.default.access_token).toBe("acc-1");
  expect(m.calls.filter((c) => c.url.endsWith("/auth/token")).length).toBe(1);
  // same via REST 401
  st.tokens.default = { base: HOST, user: "admin", access_token: "stale", expires: st.clock + 1e9 };
  const m2 = mock({ restReject: (t) => t === "stale" });
  const e = await go(["entities"], {}, m2, () => "s3cret-pw", store);
  expect(e.r.ok).toBe(true); expect(st.tokens.default.access_token).toBe("acc-1");
});

test("rejected long-lived token is reported, no login retry", async () => {
  const { r, m } = await go(["addons"], TOKEN_ENV, mock({ wsReject: () => true }));
  expect(r.ok).toBe(false); expect(r.error).toMatch(/auth_invalid \(token token rejected\)/);
  expect(m.calls.length).toBe(0);
});

test("addon: info without option values + last N log lines over REST", async () => {
  const { r, m } = await go(["addon", "addon_a", "--lines", "3"]);
  expect(r.ok).toBe(true);
  expect(r.output).toMatch(/version\s+2\.0\.0  \(latest 2\.1\.0\)  UPDATE AVAILABLE/);
  expect(r.output).toMatch(/options\s+api_key port/);
  expect(r.output).not.toContain("SUPER-SECRET-KEY");
  expect(r.output!.endsWith("log line 78\nlog line 79\nlog line 80")).toBe(true);
  const logCall = m.calls.find((c) => c.url.endsWith("/api/hassio/addons/addon_a/logs"))!;
  expect(logCall.method).toBe("GET"); expect(logCall.headers.Accept).toBe("text/plain");
  const j = await go(["addon", "addon_a", "--json"]);
  expect(j.r.output).not.toContain("SUPER-SECRET-KEY");
  expect(JSON.parse(j.r.output!).logs.length).toBe(50);
  const nl = await go(["addon", "addon_a"], TOKEN_ENV, mock({ logsStatus: 403 }));
  expect(nl.r.ok).toBe(true); expect(nl.r.output).toContain("logs not available: HTTP 403");
  expect((await go(["addon", "../x"])).r.ok).toBe(false);
  expect((await go(["addon"])).r.ok).toBe(false);
});

test("backups newest first, both size forms", async () => {
  const { r } = await go(["backups", "--json"]);
  const rows = JSON.parse(r.output!);
  expect(rows.map((b: any) => b.slug)).toEqual(["bbbb2222", "aaaa1111"]);
  expect(rows[0].size_bytes).toBe(2 ** 30); expect(rows[1].size_bytes).toBe(512.5 * 1048576);
  const t = await go(["backups"]);
  expect(t.r.output).toMatch(/new partial\s+partial\s+1\.0G\s+yes\s+local,nas/);
  expect(t.r.output).toContain("2 backups");
});

test("entities: domain filter, search on id and name, no attributes leaked", async () => {
  const a = await go(["entities", "sensor", "--search", "temperature"]);
  expect(a.r.output).toMatch(/sensor\.room_temperature\s+24\.5\s+°C/);
  expect(a.r.output).not.toContain("light.desk"); expect(a.r.output).not.toContain("sensor.power");
  expect(a.r.output).toContain("1 of 4 entities");
  const b = await go(["entities", "--search", "TEMPERATURE", "--json"]);
  expect(JSON.parse(b.r.output!).map((x: any) => x.entity_id)).toEqual(["light.desk", "sensor.room_temperature"]);
  const c = await go(["entities", "--json"]);
  expect(c.r.output).not.toContain("CAMTOKEN");
  expect((await go(["entities", "Bad.Domain"])).r.ok).toBe(false);
});

test("status on a host without Supervisor still shows core config", async () => {
  const { r } = await go(["status"], TOKEN_ENV, mock({ noSupervisor: true }));
  expect(r.ok).toBe(true);
  expect(r.output).toMatch(/core\s+2099\.1\.1/);
  expect(r.output).toContain("no Supervisor here");
});

test("READ-ONLY: only GETs besides the login flow; ws sends only auth + supervisor/api get", async () => {
  const { store } = memStore({ profiles: { default: { host: HOST, user: "admin", pass_entry: "x/y" } } });
  const m = mock();
  const cmds = [["status"], ["addons"], ["addon", "addon_a"], ["backups"], ["entities"], ["entities", "sensor", "--search", "temp"], ["status", "--json"], ["addons", "--json"]];
  for (const a of cmds) {
    const { r } = await go(a, {}, m, () => "s3cret-pw", store);
    expect(r.ok).toBe(true);
  }
  for (const a of cmds) expect((await go(a, TOKEN_ENV, m)).r.ok).toBe(true);
  const nonGet = m.calls.filter((c) => c.method !== "GET");
  expect(nonGet.every((c) => c.method === "POST" && /^\/auth\/(login_flow(\/[^/]+)?|token)$/.test(c.url.slice(HOST.length)))).toBe(true);
  expect(nonGet.length).toBe(3); // one login, then the cached token is reused
  expect(m.calls.filter((c) => ["PUT", "DELETE", "PATCH"].includes(c.method))).toEqual([]);
  for (const s of m.wsSent) {
    if (s.type === "auth") { expect(Object.keys(s).sort()).toEqual(["access_token", "type"]); continue; }
    expect(s.type).toBe("supervisor/api");
    expect(s.method).toBe("get");
    expect(s.data).toBeUndefined();
  }
});

test("source has no write paths", () => {
  const src = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
  for (const bad of ['method: "post"', 'method: "PUT"', 'method: "DELETE"', "/install", "/uninstall", "/update\"", "/restart", "/rebuild", "/options", "call_service", "/api/services", "config_entries/flow", "backups/new"]) {
    expect(src.includes(bad)).toBe(false);
  }
  // the only POST in the code is the login-flow helper
  expect(src.match(/method: "POST"/g)?.length).toBe(1);
});

test("config profiles: set / show / unset; secrets refused; env wins", async () => {
  const { st, store } = memStore();
  expect((await go(["config", "set", `host=${HOST}`, "user=reader", "pass_entry=x/y"], {}, mock(), undefined, store)).r.ok).toBe(true);
  expect((await go(["config", "set", "--profile", "lab", "host=10.0.0.7", "token_entry=lab/token", "insecure=1"], {}, mock(), undefined, store)).r.ok).toBe(true);
  expect(st.cfg).toEqual({ profiles: { default: { host: HOST, user: "reader", pass_entry: "x/y" }, lab: { host: "10.0.0.7", token_entry: "lab/token", insecure: "1" } } });
  for (const bad of ["password=hunter2", "token=abc", "pass=hunter2"]) {
    const b = await go(["config", "set", bad], {}, mock(), undefined, store);
    expect(b.r.ok).toBe(false); expect(b.r.error).toMatch(/refusing/);
  }
  expect(JSON.stringify(st.cfg)).not.toContain("hunter2");
  expect((await go(["config", "set", "nope=1"], {}, mock(), undefined, store)).r.ok).toBe(false);
  const show = await go(["config"], { HA_USER: "other" }, mock(), undefined, store);
  expect(show.r.output).toContain("/fake/config.json"); expect(show.r.output).toContain("saved profiles: default lab");
  expect(show.r.output).toContain("env HA_USER overrides");
  expect((await go(["config", "unset", "insecure", "--profile", "lab"], {}, mock(), undefined, store)).r.ok).toBe(true);
  expect(st.cfg.profiles.lab.insecure).toBeUndefined();
  expect((await go(["status", "--profile", "../etc"], {}, mock(), undefined, store)).r.ok).toBe(false);
  expect(mergeEnv({ HA_USER: "env", HA_HOST: "" }, { host: HOST, user: "cfg" })).toMatchObject({ HA_HOST: HOST, HA_USER: "env" });
  expect(() => configSet({}, ["host=::bad"])).toThrow();
});

test("help and unknown command", async () => {
  expect((await go(["--help"])).r.output).toContain("read-only");
  expect((await go(["restart"])).r.ok).toBe(false);
});

test("writeAllSync writes every byte across partial writes and EAGAIN", () => {
  const big = "x".repeat(200_000) + "ทดสอบ\n";
  const got: Uint8Array[] = []; let calls = 0;
  writeAllSync(1, big, (_fd, b) => {
    calls++;
    if (calls === 2) { const e: any = new Error("again"); e.code = "EAGAIN"; throw e; }
    const n = Math.min(b.length, 65536); got.push(b.slice(0, n)); return n;
  });
  expect(new TextDecoder().decode(Buffer.concat(got))).toBe(big);
  expect(calls).toBeGreaterThan(3);
});
