import { createServer, request as httpRequest, type ServerResponse } from "node:http";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { dataDir, readJson, writeJson } from "../store.ts";
import { InputError } from "../errors.ts";

interface Device { id: string; name: string; hash: string; createdAt: number; expiresAt: number }
interface Config { enabled: boolean; origin: string }
const COOKIE = "__Host-linubot-phone", lifetime = 30 * 86400000;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export function createPhoneAccess(options: { target: () => { port: number; token: string }; webRoot: string; port?: number }) {
  const configPath = join(dataDir(), "phone-access.json"), devicesPath = join(dataDir(), "phone-devices.json");
  let config = readJson<Config>(configPath, { enabled: false, origin: "" });
  let devices = readJson<Device[]>(devicesPath, []);
  let challenge: { hash: string; expires: number; attempts: number } | undefined;
  const connections = new Map<string, Set<ServerResponse>>();
  let startupError: string | undefined;
  function deviceList() { return devices.filter(device => device.expiresAt > Date.now()).map(({ hash: _hash, ...device }) => device); }
  function saveDevices() { writeJson(devicesPath, devices); }
  const server = createServer(async (req, res) => {
    res.setHeader("cache-control", "no-store"); res.setHeader("referrer-policy", "no-referrer"); res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; form-action 'self'; base-uri 'none'");
    const json = (status: number, value: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
    try {
      if (!config.enabled) throw new InputError("Phone access is disabled", 503);
      const origin = new URL(config.origin);
      if (req.headers.host !== origin.host) throw new InputError("Unexpected phone address", 403);
      if ((req.headers.origin && req.headers.origin !== origin.origin) || req.headers["sec-fetch-site"] === "cross-site") throw new InputError("Cross-origin request refused", 403);
      const url = new URL(req.url ?? "/", origin);
      const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      if (segments[0] === "api" && segments[1] === "phone") throw new InputError("Manage phone access from the Linux app", 403);
      if (req.method === "GET" && ["/phone-pair", "/phone-pair.js", "/phone.css", "/assets/icon.png"].includes(url.pathname)) {
        const file = url.pathname === "/phone-pair" ? "phone-pair.html" : url.pathname.slice(1);
        res.setHeader("content-type", file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : file.endsWith(".png") ? "image/png" : "text/html");
        res.end(readFileSync(join(options.webRoot, file))); return;
      }
      if (url.pathname === "/phone-session" && req.method === "POST") {
        if (req.headers.origin !== origin.origin || !req.headers["content-type"]?.startsWith("application/json")) throw new InputError("Use the pairing form", 403);
        let body = "";
        for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 2048) throw new InputError("Pairing request is too large", 413); }
        const value = JSON.parse(body);
        if (!challenge || challenge.expires < Date.now() || challenge.attempts >= 5) throw new InputError("Create a new pairing code on Linux", 401);
        challenge.attempts++;
        const code = typeof value.code === "string" ? value.code.replaceAll("-", "").trim().toUpperCase() : "";
        if (!same(hash(code), challenge.hash)) throw new InputError("Pairing code is incorrect", 401);
        if (devices.filter(device => device.expiresAt > Date.now()).length >= 20) throw new InputError("Remove an old paired device first", 409);
        if (typeof value.name !== "string" || !value.name.trim() || value.name.length > 80) throw new InputError("Name this phone", 400);
        const token = randomBytes(32).toString("base64url"), now = Date.now();
        devices = [...devices.filter(device => device.expiresAt > now), { id: randomUUID(), name: value.name.trim(), hash: hash(token), createdAt: now, expiresAt: now + lifetime }];
        saveDevices(); challenge = undefined;
        res.setHeader("set-cookie", `${COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${lifetime / 1000}`);
        json(200, { paired: true }); return;
      }
      const token = String(req.headers.cookie ?? "").split(";").map(value => value.trim()).find(value => value.startsWith(COOKIE + "="))?.slice(COOKIE.length + 1) ?? "";
      const device = token.length <= 100 ? devices.find(device => device.expiresAt > Date.now() && same(device.hash, hash(token))) : undefined;
      if (!device) {
        if (url.pathname.startsWith("/api/")) { res.setHeader("x-linubot-pairing", "required"); json(401, { error: "Pair this phone from the Linux app" }); }
        else { res.writeHead(303, { location: "/phone-pair" }); res.end(); }
        return;
      }
      if (url.pathname === "/phone-logout" && req.method === "POST") {
        devices = devices.filter(value => value.id !== device.id); saveDevices();
        for (const response of connections.get(device.id) ?? []) response.destroy();
        res.setHeader("set-cookie", `${COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`); json(200, { disconnected: true }); return;
      }
      const open = connections.get(device.id) ?? new Set<ServerResponse>();
      if (open.size >= 24) throw new InputError("Too many open phone requests", 429);
      connections.set(device.id, open); open.add(res);
      const target = options.target(), localOrigin = `http://127.0.0.1:${target.port}`;
      const upstream = httpRequest({ hostname: "127.0.0.1", port: target.port, path: req.url, method: req.method,
        headers: { "host": `127.0.0.1:${target.port}`, "x-linubot-token": target.token, "x-linubot-client": "phone", "origin": localOrigin,
          ...(req.headers["content-type"] ? { "content-type": req.headers["content-type"] } : {}),
          ...(req.headers["last-event-id"] ? { "last-event-id": req.headers["last-event-id"] } : {}) } }, response => {
        response.once("aborted", () => res.destroy()); response.once("error", () => res.destroy());
        res.writeHead(response.statusCode ?? 502, response.headers); response.pipe(res);
      });
      const expiry = setTimeout(() => res.destroy(), Math.min(device.expiresAt - Date.now(), 3600000)); expiry.unref();
      res.once("close", () => { clearTimeout(expiry); upstream.destroy(); open.delete(res); if (!open.size) connections.delete(device.id); });
      upstream.once("error", () => { if (!res.headersSent) json(502, { error: "The Linux app is unavailable" }); else res.destroy(); });
      req.once("aborted", () => upstream.destroy()); req.pipe(upstream);
    } catch (error) { if (!res.headersSent) json(error instanceof InputError ? error.status : 400, { error: error instanceof Error ? error.message : "Invalid request" }); else res.destroy(); }
  });
  server.headersTimeout = 10000; server.requestTimeout = 15000; server.maxConnections = 128;
  server.on("error", error => { startupError = error.message; });
  async function start() {
    if (server.listening || !config.enabled) return;
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(options.port ?? 45873, "127.0.0.1", () => { server.off("error", reject); startupError = undefined; resolve(); }); });
  }
  async function close() {
    challenge = undefined; for (const responses of connections.values()) for (const response of responses) response.destroy(); connections.clear();
    await new Promise<void>(resolve => { if (!server.listening) { resolve(); return; } server.close(() => resolve()); server.closeAllConnections(); });
  }
  return {
    start, close, server,
    status: () => ({ ...config, listening: server.listening, error: startupError, devices: deviceList(), port: options.port ?? 45873 }),
    async enable(value: string) {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new InputError("Use an HTTPS address without a path or credentials");
      if (config.origin && config.origin !== url.origin) { devices = []; saveDevices(); await close(); }
      config = { enabled: true, origin: url.origin }; await start(); writeJson(configPath, config); return this.status();
    },
    async disable() { config.enabled = false; writeJson(configPath, config); await close(); return this.status(); },
    pair() {
      if (!config.enabled || !server.listening) throw new InputError("Enable phone access first", 409);
      const code = randomBytes(5).toString("hex").toUpperCase(); challenge = { hash: hash(code), expires: Date.now() + 300000, attempts: 0 };
      return { code, url: `${config.origin}/phone-pair#${code}`, expiresAt: challenge.expires };
    },
    revoke(id: string) { devices = devices.filter(device => device.id !== id); saveDevices(); for (const response of connections.get(id) ?? []) response.destroy(); return this.status(); },
  };
}
