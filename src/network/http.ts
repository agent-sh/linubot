import { lookup } from "node:dns/promises";
import { request } from "node:https";
import ipaddr from "ipaddr.js";
import { InputError, requiredText } from "../errors.ts";
import { abortable } from "./abort.ts";

export function publicAddress(address: string): boolean {
  try { return ipaddr.process(address).range() === "unicast"; } catch { return false; }
}

export function publicUrl(value: unknown): URL {
  const url = new URL(requiredText(value, "URL", 4000));
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) {
    throw new InputError("Use a public HTTPS URL without credentials or a custom port");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") ||
      (ipaddr.isValid(host) && !publicAddress(host))) throw new InputError("Private network addresses are not available to web tools");
  return url;
}

/** Resolve and pin public DNS answers on the actual socket, including every redirect. */
export async function fetchPublic(value: string, options: { signal?: AbortSignal; maxBytes?: number; redirects?: number; accept?: string } = {}, io = { lookup, request }): Promise<{ url: string; text: string; bytes: Buffer; contentType: string }> {
  const url = publicUrl(value);
  const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(20_000)]);
  signal.throwIfAborted();
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = await abortable(io.lookup(host, { all: true, verbatim: true }), signal);
  signal.throwIfAborted();
  if (!addresses.length || addresses.some(({ address }) => !publicAddress(address))) throw new InputError("Web tools cannot access private networks");
  return new Promise((resolve, reject) => {
    const req = io.request(url, {
      signal,
      headers: { "User-Agent": "Linubot (+https://github.com/agent-sh/linubot)", Accept: options.accept ?? "text/html, text/plain, application/json;q=0.9", "Accept-Language": "en-US,en;q=0.9" },
      lookup: (_hostname, opts, callback) => {
        const selected = opts.family ? addresses.filter((item) => item.family === opts.family) : addresses;
        if (!selected.length) { callback(new Error("No public address for requested family"), [] as never); return; }
        if (opts.all) callback(null, selected);
        else callback(null, selected[0].address, selected[0].family);
      },
    }, (response) => {
      const status = response.statusCode ?? 0;
      if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
        response.resume();
        if ((options.redirects ?? 0) >= 4) { reject(new Error("Too many web redirects")); return; }
        try { void fetchPublic(new URL(response.headers.location, url).href, { ...options, signal, redirects: (options.redirects ?? 0) + 1 }, io).then(resolve, reject); }
        catch (error) { reject(error); }
        return;
      }
      if (status < 200 || status >= 300) { response.resume(); reject(new Error(`${url.hostname} returned HTTP ${status}`)); return; }
      const limit = options.maxBytes ?? 2 * 1024 * 1024;
      if (Number(response.headers["content-length"]) > limit) { response.destroy(); reject(new Error("Web response is too large")); return; }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > limit) { response.destroy(new Error("Web response is too large")); return; }
        chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => { const bytes = Buffer.concat(chunks); resolve({ url: url.href, bytes, text: bytes.toString("utf8"), contentType: String(response.headers["content-type"] ?? "") }); });
    });
    req.on("error", reject);
    req.end();
  });
}

export async function fetchPublicJson<T = unknown>(url: string, signal?: AbortSignal): Promise<T> {
  const result = await fetchPublic(url, { signal, maxBytes: 5 * 1024 * 1024, accept: "application/json" });
  try { return JSON.parse(result.text) as T; } catch { throw new Error(`${new URL(url).hostname} returned invalid JSON`); }
}
