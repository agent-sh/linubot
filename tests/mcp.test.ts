import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const previousData = process.env.LINUBOT_DATA;
const previousUrl = process.env.LINUBOT_SEARXNG_URL;
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "linubot-mcp-"));
  process.env.LINUBOT_DATA = root;
  delete process.env.LINUBOT_SEARXNG_URL;
});
afterEach(() => {
  if (previousData === undefined) delete process.env.LINUBOT_DATA;
  else process.env.LINUBOT_DATA = previousData;
  if (previousUrl === undefined) delete process.env.LINUBOT_SEARXNG_URL;
  else process.env.LINUBOT_SEARXNG_URL = previousUrl;
  rmSync(root, { recursive: true, force: true });
});
const { addMcpServer, readMcp, readWebSearch, removeMcpServer, setMcpEnabled, webSearch, writeMcp, writeWebSearch } =
  await import("../src/mcp/manager.ts");

function response(data: unknown) {
  return { ok: true, status: 200, json: async () => data };
}

function enableSearch(): void {
  writeWebSearch({ backend: "searxng", url: "http://search.test", maxResults: 5 });
}

describe("mcp and websearch", () => {
  it("validates server CRUD and reports configuration, not connections", () => {
    addMcpServer("fetch", { command: "uvx", args: ["mcp-server-fetch"] });
    assert.equal(readMcp().servers["fetch"].command, "uvx");
    assert.equal(readMcp().servers["fetch"].status, "configured");
    assert.equal(readMcp().status, "configured");
    setMcpEnabled("fetch", false);
    assert.equal(readMcp().servers["fetch"].enabled, false);
    assert.throws(() => addMcpServer("Bad Name", { command: "x" }), /invalid server name/);
    assert.throws(() => addMcpServer("empty", { command: "  " }), /command.*required/);
    assert.throws(() => setMcpEnabled("ghost", true), { name: "InputError", status: 404 });
    removeMcpServer("fetch");
    assert.deepEqual(readMcp().servers, {});
    assert.throws(() => removeMcpServer("fetch"), { name: "InputError", status: 404 });
    assert.equal(statSync(join(root, "mcp.json")).mode & 0o777, 0o600);
  });

  it("blocks prototype names consistently and checks own registry entries", () => {
    const before = Object.getOwnPropertyDescriptor(Object.prototype, "enabled");
    for (const name of ["__proto__", "constructor", "prototype", "toString", "../escape", "fetch\n", "fetch\r", "fetch\u2028", null, {}, "x".repeat(41)]) {
      assert.throws(() => addMcpServer(name as string, { command: "x" }), { name: "InputError", status: 400 });
      assert.throws(() => setMcpEnabled(name as string, true), { name: "InputError", status: 400 });
      assert.throws(() => removeMcpServer(name as string), { name: "InputError", status: 400 });
    }
    assert.deepEqual(Object.getOwnPropertyDescriptor(Object.prototype, "enabled"), before);
    assert.throws(() => writeMcp(JSON.parse('{"servers":{"__proto__":{"command":"x"}}}')), { name: "InputError", status: 400 });
    writeFileSync(join(root, "mcp.json"), '{"servers":{"constructor":{"command":"x"}}}');
    assert.throws(() => readMcp(), { name: "InputError", status: 400 });
  });

  it("bounds configuration types without altering command arguments", () => {
    const args = ["--tag", "one", "--tag", "two", "", " spaced "];
    addMcpServer("repeat", { command: " tool ", args });
    assert.deepEqual(readMcp().servers.repeat.args, args);
    assert.equal(readMcp().servers.repeat.command, "tool");
    for (const server of [null, [], { command: 1 }, { command: "x".repeat(1025) }, { command: "x\0" }, { command: "x", args: "arg" }, { command: "x", args: [null] }, { command: "x", args: ["x".repeat(2001)] }, { command: "x", args: Array(101).fill("x") }, { command: "x", enabled: "yes" }]) {
      assert.throws(() => addMcpServer("bad", server as never), { name: "InputError", status: 400 });
    }
    assert.throws(() => setMcpEnabled("repeat", "yes" as never), { name: "InputError", status: 400 });
    assert.deepEqual(Object.keys(readMcp().servers), ["repeat"]);
  });

  it("does not replace corrupt registry JSON with defaults", () => {
    const path = join(root, "mcp.json");
    writeFileSync(path, "{bad");
    assert.throws(() => readMcp(), /Cannot read stored JSON/);
    assert.throws(() => addMcpServer("x", { command: "x" }), /Cannot read stored JSON/);
    assert.equal(readFileSync(path, "utf8"), "{bad");
  });

  it("rejects corrupt or null search settings instead of falling back", () => {
    const path = join(root, "websearch.json");
    for (const raw of ["{bad", "null", "[]", "{}", '{"backend":"searxng","maxResults":5}']) {
      writeFileSync(path, raw);
      assert.throws(() => readWebSearch());
      assert.equal(readFileSync(path, "utf8"), raw);
    }
  });

  it("defaults to public search and permits an explicit backend override", async (t) => {
    const stub = t.mock.method(globalThis, "fetch", async () => { throw new Error("no live requests allowed"); });
    assert.deepEqual(readWebSearch(), { backend: "bing", maxResults: 5 });
    assert.equal(stub.mock.callCount(), 0);
    process.env.LINUBOT_SEARXNG_URL = " HTTP://LOCALHOST:8888/base/ ";
    assert.deepEqual(readWebSearch(), { backend: "searxng", url: "http://localhost:8888/base", maxResults: 5 });
    process.env.LINUBOT_SEARXNG_URL = "file:///tmp/search";
    assert.throws(() => readWebSearch(), /http\(s\) URL/);
    delete process.env.LINUBOT_SEARXNG_URL;
    enableSearch();
    assert.equal(readWebSearch().backend, "searxng");
  });

  it("bounds websearch config and maps results", async () => {
    assert.throws(() => writeWebSearch({ maxResults: 99 }), /1-20/);
    writeWebSearch({ backend: "searxng", url: "http://search.test", maxResults: 1 });
    let seen = "";
    const hits = await webSearch("grok bot", async (url: string) => {
      seen = url;
      return response({ results: [{ title: "T", url: "https://example.test/page", content: "S" }, { title: "T2" }] });
    });
    assert.equal(seen, "http://search.test/search?q=grok%20bot&format=json");
    assert.deepEqual(hits, [{ title: "T", url: "https://example.test/page", snippet: "S" }]);
    writeWebSearch({ backend: undefined, url: undefined, maxResults: 2 });
    assert.deepEqual(readWebSearch(), { backend: "searxng", url: "http://search.test", maxResults: 2 });
    assert.equal(statSync(join(root, "websearch.json")).mode & 0o777, 0o600);
  });

  it("normalizes http(s) URLs and rejects unsafe backend configuration", () => {
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "http:example.test", "https://user:password@example.test", "https://example.test/?secret=x", "https://example.test/#fragment", "http://example.test\\path", "https://example.test/\npath", 4]) {
      assert.throws(() => writeWebSearch({ backend: "searxng", url: url as string }), { name: "InputError", status: 400 });
    }
    for (const value of [null, [], { backend: "other" }, { maxResults: 0 }, { maxResults: 1.5 }, { maxResults: "5" }]) {
      assert.throws(() => writeWebSearch(value as never), { name: "InputError", status: 400 });
    }
    assert.throws(() => writeWebSearch({ backend: "searxng" }), /no searxng URL/);
    assert.deepEqual(writeWebSearch({ backend: "searxng", url: " HTTPS://EXAMPLE.TEST:443/base/// " }), { backend: "searxng", url: "https://example.test/base", maxResults: 5 });
    assert.deepEqual(writeWebSearch({ backend: "disabled", url: "" }), { backend: "disabled", maxResults: 5 });
  });

  it("filters malformed results and unsafe links before applying maxResults", async () => {
    enableSearch();
    writeWebSearch({ maxResults: 2 });
    const results = [null, 4, {}, { title: "X", url: "javascript:alert(1)" }, { title: "X", url: "file:///private" }, { title: "X", url: "data:text/html,test" }, { title: "X", url: "/relative" }, { title: "X", url: "https://user:pass@example.test" }, { title: {}, url: "https://example.test" }, { title: "X", url: "https://example.test", content: {} }, { title: " Good ", url: "HTTPS://EXAMPLE.TEST:443", content: "Snippet" }, { title: "Other", url: "https://other.test/a#fragment" }, { title: "Ignored", url: "https://ignored.test" }];
    assert.deepEqual(await webSearch("x", async () => response({ results })), [
      { title: "Good", url: "https://example.test/", snippet: "Snippet" },
      { title: "Other", url: "https://other.test/a#fragment", snippet: "" },
    ]);
  });

  it("validates response shape and limits both payload and result text", async () => {
    enableSearch();
    for (const data of [null, [], {}, { results: {} }, { results: "x" }, { results: Array(1001).fill({}) }]) {
      await assert.rejects(() => webSearch("x", async () => response(data)), /invalid response/);
    }
    await assert.rejects(() => webSearch("x", async () => response({ results: [], padding: "x".repeat(1024 * 1024) })), /exceeds 1 MiB/);
    const hits = await webSearch("x", async () => response({ results: [{ title: "x".repeat(600), url: "https://example.test", content: "s".repeat(5000) }] }));
    assert.equal(hits[0].title.length, 500);
    assert.equal(hits[0].snippet.length, 4000);
    assert.deepEqual(await webSearch("x", async () => response({ results: [] })), []);
  });

  it("caps streamed responses before parsing and cancels oversized bodies", async (t) => {
    enableSearch();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(128 * 1024)); },
      cancel() { cancelled = true; },
    });
    const stub = t.mock.method(globalThis, "fetch", async () => new Response(body));
    await assert.rejects(() => webSearch("x"), /exceeds 1 MiB/);
    assert.equal(cancelled, true);
    assert.equal(stub.mock.callCount(), 1);
    const options = stub.mock.calls[0].arguments[1] as RequestInit;
    assert.equal(options.redirect, "error");
    assert.ok(options.signal instanceof AbortSignal);
    let parsed = false;
    await assert.rejects(() => webSearch("x", async () => ({ ...response({}), headers: { get: () => "1048577" }, json: async () => { parsed = true; return {}; } })), /exceeds 1 MiB/);
    assert.equal(parsed, false);
  });

  it("reads bounded stream JSON through the default fetch adapter", async (t) => {
    enableSearch();
    t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ results: [{ title: "T", url: "https://example.test", content: "S" }] })));
    assert.deepEqual(await webSearch("x"), [{ title: "T", url: "https://example.test/", snippet: "S" }]);
  });

  it("propagates cancellation, even when a custom fetch ignores the signal", async () => {
    enableSearch();
    const controller = new AbortController();
    let signal: AbortSignal | undefined;
    const pending = webSearch("x", async (_url, options) => {
      signal = options?.signal;
      return new Promise(() => {});
    }, controller.signal);
    const rejected = assert.rejects(pending, { name: "AbortError" });
    controller.abort();
    await rejected;
    assert.equal(signal?.aborted, true);
    let called = false;
    await assert.rejects(() => webSearch("x", async () => { called = true; return response({ results: [] }); }, controller.signal), { name: "AbortError" });
    assert.equal(called, false);
  });

  it("cancels while waiting for JSON rather than returning a late result", async () => {
    enableSearch();
    const controller = new AbortController();
    let started!: () => void;
    const reading = new Promise<void>((resolve) => { started = resolve; });
    const pending = webSearch("x", async () => ({ ok: true, status: 200, json: async () => { started(); return new Promise(() => {}); } }), controller.signal);
    const rejected = assert.rejects(pending, { name: "AbortError" });
    await reading;
    controller.abort();
    await rejected;
  });

  it("bounds fetch time even if the fetch implementation never settles", async (t) => {
    enableSearch();
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const pending = webSearch("x", async () => new Promise(() => {}));
    const rejected = assert.rejects(pending, { name: "TimeoutError" });
    t.mock.timers.tick(15_000);
    await rejected;
  });

  it("surfaces outages honestly", async () => {
    for (const query of ["   ", null, {}, "x".repeat(2001)]) {
      await assert.rejects(() => webSearch(query as string), { name: "InputError", status: 400 });
    }
    writeWebSearch({ backend: "disabled" });
    await assert.rejects(() => webSearch("x", async () => response({})), /disabled/);
    writeWebSearch({ backend: "searxng", url: "http://down" });
    await assert.rejects(() => webSearch("x", async () => { throw new Error("refused"); }), /unreachable at http:\/\/down/);
    await assert.rejects(() => webSearch("x", async () => ({ ...response({}), ok: false, status: 503 })), /http 503/);
    await assert.rejects(() => webSearch("x", async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("bad"); } })), /invalid JSON/);
    await assert.rejects(() => webSearch("x", async () => new Response("not JSON")), /invalid JSON/);
  });
});
