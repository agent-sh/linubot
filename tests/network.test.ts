import { it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { lookup } from "node:dns/promises";
import type { request } from "node:https";
import { fetchPublic } from "../src/network/http.ts";
import { xaiSearchResults } from "../src/network/xai-search.ts";

function transport(status: number, headers: Record<string, string>, body = "", stall = false) {
  const response = Object.assign(new PassThrough(), { statusCode: status, headers });
  let requests = 0;
  const io = {
    lookup: (async () => [{ address: "1.1.1.1", family: 4 }]) as unknown as typeof lookup,
    request: ((_url: URL, options: { signal: AbortSignal }, callback: (value: typeof response) => void) => {
      requests++;
      const req = new EventEmitter() as EventEmitter & { end(): void };
      req.end = () => {
        callback(response);
        if (!stall) queueMicrotask(() => response.end(body));
      };
      options.signal.addEventListener("abort", () => { response.destroy(options.signal.reason); req.emit("error", options.signal.reason); }, { once: true });
      return req;
    }) as unknown as typeof request,
  };
  return { io, response, requests: () => requests };
}

it("redirect errors reject without contacting private addresses or escaping the request promise", async () => {
  for (const location of ["http://[", "https://127.0.0.1/private"]) {
    const fake = transport(302, { location });
    await assert.rejects(fetchPublic("https://example.com/redirect", {}, fake.io));
    assert.equal(fake.requests(), 1);
  }
});

it("oversized chunked responses are rejected and their stream is closed", async () => {
  const fake = transport(200, { "content-type": "text/plain" }, "0123456789");
  await assert.rejects(fetchPublic("https://example.com/large", { maxBytes: 5 }, fake.io), /too large/);
  assert.equal(fake.response.destroyed, true);
});

it("cancellation settles during DNS resolution and closes an active body stream", async () => {
  const dns = new AbortController();
  const fake = transport(200, {}, "", true);
  const unresolved = fetchPublic("https://example.com/", { signal: dns.signal }, { ...fake.io, lookup: (() => new Promise(() => {})) as unknown as typeof lookup });
  dns.abort(new Error("DNS cancelled")); await assert.rejects(unresolved, /DNS cancelled/); assert.equal(fake.requests(), 0);
  const body = new AbortController();
  const pending = fetchPublic("https://example.com/", { signal: body.signal }, fake.io);
  await new Promise((resolve) => setImmediate(resolve));
  body.abort(new Error("Body cancelled")); await assert.rejects(pending, /Body cancelled/); assert.equal(fake.response.destroyed, true);
});

it("xAI search only returns provider-cited public URLs, excluding fabricated and private links", () => {
  const output = [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ results: [
    { title: "Real source", url: "https://example.com/source", snippet: "A source description" },
    { title: "Invented source", url: "https://example.com/invented", snippet: "Uncited" },
    { title: "Private", url: "https://127.0.0.1/private", snippet: "Private" },
  ] }), annotations: [{ type: "url_citation", url: "https://example.com/source" }] }] }];
  const hits = xaiSearchResults({ output, citations: ["https://127.0.0.1/private"] }, 5);
  assert.deepEqual(hits, [{ title: "Real source", url: "https://example.com/source", snippet: "A source description" }]);
});
