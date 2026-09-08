import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { getProvider, providerStatus, setProvider, providerConnections, selectProvider } from "./store.ts";
import { readProviderJson, providerBase } from "./providers.ts";
import { listProviderModels, preselectCatalogModel } from "./catalog.ts";
import { InputError } from "../errors.ts";

type State = "waiting" | "exchanging" | "connected" | "cancelled" | "failed";
interface Login { id: string; verifier: string; state: State; controller: AbortController; server: Server; timer?: NodeJS.Timeout; connectionId?: string; error?: string }
const BASE = "https://api.tiyuvta.ai/v1";
const page = (message: string) => `<!doctype html><html><head><meta charset="utf-8"><title>Linubot connection</title></head><body><h1>${message}</h1><p>You can return to Linubot and close this tab.</p></body></html>`;

export function createTiyuvtaLogin(options: { request?: typeof fetch; connected?: (id: string) => void } = {}) {
  const request = options.request ?? fetch;
  let active: Login | undefined;
  let starting: Promise<void> = Promise.resolve(), closed = false;
  async function close(entry: Login) {
    clearTimeout(entry.timer);
    entry.controller.abort();
    entry.server.closeAllConnections();
    await new Promise<void>((resolve) => entry.server.close(() => resolve()));
  }
  async function cancel(id?: string) {
    if (!active || (id && active.id !== id)) return;
    if (active.state === "waiting" || active.state === "exchanging") active.state = "cancelled";
    await close(active);
  }
  return {
    begin(connectionId?: string) {
      const work = starting.then(async () => {
      if (closed) throw new InputError("Sign-in service is stopping", 503);
      await cancel();
      const original = connectionId ? getProvider(connectionId) : undefined;
      if (original && (providerBase(original.kind, original.baseUrl) !== BASE || !["openai-compat", "responses"].includes(original.kind) || original.auth !== "bearer")) throw new InputError("Choose a Tiyuvta connection for browser sign-in");
      const id = randomBytes(32).toString("base64url"), verifier = randomBytes(32).toString("base64url");
      const entry: Login = { id, verifier, state: "waiting", controller: new AbortController(), server: createServer() };
      active = entry;
      entry.server.on("request", (req, res) => {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
        let url: URL;
        try { url = new URL(req.url || "/", "http://127.0.0.1"); }
        catch { res.writeHead(400); res.end(page("Invalid connection callback")); return; }
        const state = url.searchParams.get("state") || "";
        if (req.method !== "GET" || url.pathname !== "/callback" || Buffer.byteLength(state) !== Buffer.byteLength(id) || !timingSafeEqual(Buffer.from(state), Buffer.from(id))) { res.writeHead(400); res.end(page("Invalid connection callback")); return; }
        if (active !== entry || entry.state !== "waiting") { res.writeHead(409); res.end(page("This sign-in is no longer active")); return; }
        const code = url.searchParams.get("code");
        if (!code || code.length > 4096 || url.searchParams.has("error")) { entry.state = "failed"; entry.error = "Sign-in was declined or did not return a code."; res.writeHead(400); res.end(page("Connection was not completed")); void close(entry); return; }
        entry.state = "exchanging";
        void (async () => {
          try {
            const response = await request("https://inference.tiyuvta.ai/api/connect/exchange", { method: "POST", redirect: "error", signal: AbortSignal.any([entry.controller.signal, AbortSignal.timeout(20000)]), headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code, code_verifier: verifier }) });
            if (!response.ok) {
              const failure = await readProviderJson(response) as { message?: unknown };
              throw new InputError(typeof failure?.message === "string" ? failure.message : `Tiyuvta sign-in exchange returned HTTP ${response.status}`, 502);
            }
            const data = await readProviderJson(response) as { key?: string };
            if (!data || typeof data.key !== "string" || !data.key || data.key.length > 10000 || /[\r\n]/.test(data.key)) throw new Error("Tiyuvta returned an invalid credential");
            if (active !== entry || entry.controller.signal.aborted) throw new Error("Sign-in was cancelled");
            let model = "";
            try {
              const catalog = await listProviderModels({ kind: "openai-compat", baseUrl: BASE, auth: "none", apiKey: "", model: "" }, entry.controller.signal, request);
              model = preselectCatalogModel(catalog.models);
            } catch { /* A key can be saved even when the public catalog is unavailable. */ }
            if (active !== entry || entry.controller.signal.aborted) throw new Error("Sign-in was cancelled");
            let currentModel = "";
            if (original) {
              const current = getProvider(original.id);
              if (current.kind !== original.kind || current.baseUrl !== original.baseUrl || current.auth !== original.auth) throw new InputError("This connection changed during sign-in. Start again.");
              currentModel = current.model === "default" ? "" : current.model;
            }
            const credential = { apiKey: data.key, rememberKey: providerStatus().credentialStorage, model: currentModel || model };
            const saved = original ? setProvider({ id: original.id, ...credential }) : setProvider({ newConnection: true, name: "Tiyuvta", kind: "openai-compat", baseUrl: BASE, auth: "bearer", ...credential });
            if (providerStatus(saved.id).ready && !providerConnections().connections.some((p) => p.id !== saved.id && p.ready)) selectProvider(saved.id!);
            entry.connectionId = saved.id; entry.state = "connected"; clearTimeout(entry.timer);
            res.writeHead(200); res.end(page("Connected to Tiyuvta"));
            entry.server.close(); entry.server.closeIdleConnections();
            try { options.connected?.(saved.id!); } catch { console.error("Could not focus Linubot after sign-in"); }
          } catch (error) {
            if (entry.state === "exchanging") { entry.state = "failed"; entry.error = error instanceof InputError ? error.message : "Tiyuvta sign-in could not finish. Try again."; }
            if (!res.destroyed) { res.writeHead(400); res.end(page("Connection was not completed")); }
            void close(entry);
          }
        })();
      });
      await new Promise<void>((resolve, reject) => { entry.server.once("error", reject); entry.server.listen(0, "127.0.0.1", resolve); });
      const address = entry.server.address();
      if (!address || typeof address === "string") throw new Error("Could not open the login callback");
      const callback = new URL(`http://127.0.0.1:${address.port}/callback`);
      const authorize = new URL("https://inference.tiyuvta.ai/app/connect");
      authorize.searchParams.set("app", "linubot");
      authorize.searchParams.set("callback_url", callback.href);
      authorize.searchParams.set("state", id);
      authorize.searchParams.set("code_challenge", createHash("sha256").update(verifier).digest("base64url"));
      authorize.searchParams.set("code_challenge_method", "S256");
      entry.timer = setTimeout(() => { if (entry.state === "waiting" || entry.state === "exchanging") { entry.state = "failed"; entry.error = "Sign-in expired. Start again."; void close(entry); } }, 10 * 60_000);
      entry.timer.unref();
      return { id, authorizationUrl: authorize.href, expiresIn: 600 };
      });
      starting = work.then(() => {}, () => {});
      return work;
    },
    status(id: string) {
      if (!active || active.id !== id) throw new InputError("Sign-in session not found", 404);
      return { state: active.state, connectionId: active.connectionId, error: active.error };
    },
    cancel,
    close: async () => { closed = true; await starting; await cancel(); },
  };
}
