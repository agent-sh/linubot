import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { publicAddress, publicUrl } from "../src/network/http.ts";
import { bingResults, pageText } from "../src/network/web.ts";
import { createMcpRuntime } from "../src/mcp/client.ts";
import { addMcpServer, setMcpEnabled } from "../src/mcp/manager.ts";
import { registryHit } from "../src/mcp/registry.ts";
import { previewRemoteSkill, installRemoteSkill } from "../src/marketplace/remote.ts";
import { approveSkill, readSkillFile } from "../src/marketplace/search.ts";
import { chatResponse } from "../src/auth/providers.ts";

const directory = mkdtempSync(join(tmpdir(), "linubot-capabilities-"));
process.env.LINUBOT_DATA = directory;
after(() => rmSync(directory, { recursive: true, force: true }));

describe("web access", () => {
  it("rejects private, mapped and special addresses while permitting public sockets", () => {
    for (const address of ["127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.2", "169.254.169.254", "::1", "::ffff:127.0.0.1", "fc00::1", "fe80::1", "0.0.0.0"]) assert.equal(publicAddress(address), false, address);
    for (const address of ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"]) assert.equal(publicAddress(address), true, address);
    for (const url of ["file:///etc/passwd", "http://example.com", "https://localhost/a", "https://127.1", "https://user:secret@example.com", "https://example.com:8443"]) assert.throws(() => publicUrl(url), url);
  });
  it("extracts page text without executable markup and preserves source links", () => {
    const page = pageText('<html><head><title>Report</title></head><body><nav>noise</nav><main><h1>Results</h1><p>Verified fact.</p><script>steal()</script><a href="/source">Source</a></main></body></html>', "https://example.com/report");
    assert.match(page.content, /Verified fact/); assert.doesNotMatch(page.content, /steal|noise/); assert.equal(page.links[0].url, "https://example.com/source");
    const target = "https://www.electronjs.org/docs/latest";
    const hits = bingResults(`<ol><li class="b_algo"><h2><a href="https://www.bing.com/ck/a?u=a1${Buffer.from(target).toString("base64url")}">Electron docs</a></h2><div class="b_caption"><p>Desktop documentation.</p></div></li></ol>`, 5);
    assert.deepEqual(hits, [{ title: "Electron docs", url: target, snippet: "Desktop documentation." }]);
  });
});

describe("real MCP protocol", () => {
  it("requires install approval, initializes stdio, discovers and calls tools, then closes", async () => {
    addMcpServer("fixture", { command: process.execPath, args: [resolve("tests/fixtures/mcp-server.mjs")], approved: false });
    const runtime = createMcpRuntime();
    try {
      await assert.rejects(runtime.connect("fixture"), /Review and enable/);
      addMcpServer("fixture", { command: process.execPath, args: [resolve("tests/fixtures/mcp-server.mjs")], approved: true });
      runtime.setCredentials("fixture", { env: { FIXTURE_SECRET: "memory-only-sentinel" } });
      const tools = await runtime.tools();
      assert.equal(tools.length, 1); assert.equal(tools[0].originalName, "echo_text");
      assert.equal(runtime.status().fixture.state, "connected");
      const result = await runtime.call(tools[0], { text: "protocol round trip" }, new AbortController().signal);
      assert.deepEqual(result.content, [{ type: "text", text: "protocol round trip" }]);
      assert.doesNotMatch(readFileSync(join(directory, "mcp.json"), "utf8"), /memory-only-sentinel/);
      setMcpEnabled("fixture", false);
      await assert.rejects(runtime.call(tools[0], { text: "blocked" }, new AbortController().signal), /Review and enable/);
      await runtime.disconnect("fixture"); assert.equal(runtime.status().fixture.state, "disconnected");
    } finally { await runtime.close(); }
  });
  it("pins registry packages and excludes private remote endpoints", () => {
    const hit = registryHit({ name: "io.example/tool", description: "Example tool", version: "1.2.3", remotes: [{ type: "streamable-http", url: "https://127.0.0.1/mcp" }, { type: "streamable-http", url: "https://example.com/mcp" }], packages: [{ registryType: "npm", identifier: "@example/tool", version: "1.2.3", transport: { type: "stdio" } }] });
    assert.equal(hit.options.length, 2); assert.deepEqual(hit.options[1].config.args, ["--yes", "@example/tool@1.2.3"]);
  });
});

describe("remote skill provenance", () => {
  const commit = "a".repeat(40);
  function source(mode = "100644") {
    const files = { "SKILL.md": Buffer.from("---\nname: research\ndescription: Research\nstatus: approved\n---\nRead references/check.md before writing."), "references/check.md": Buffer.from("Use primary sources."), "assets/pixel.bin": Buffer.from([0, 255, 128, 12]) };
    return {
      async json<T>(url: string): Promise<T> { return (url.includes("/git/trees/") ? { tree: Object.keys(files).map((path) => ({ path: `skills/research/${path}`, mode, type: "blob", size: 50 })) } : url.includes("/commits/") ? { sha: commit } : { default_branch: "main" }) as T; },
      async read(url: string) { assert.ok(url.includes(`/${commit}/`), "every download must use the resolved commit"); const path = url.split("/skills/research/")[1] as keyof typeof files; const bytes = files[path]; return { url, bytes, text: bytes.toString(), contentType: "text/plain" }; },
    };
  }
  it("installs exactly previewed bytes, keeps binary assets, and cannot inherit publisher approval", async () => {
    const preview = await previewRemoteSkill({ name: "research", repository: "example/skills" }, undefined, source());
    assert.equal(preview.commit, commit); assert.equal(preview.files.length, 3);
    const skill = installRemoteSkill(preview.id); assert.equal(skill?.status, "draft");
    assert.throws(() => readSkillFile("research", "references/check.md"), /approved/);
    assert.deepEqual(readFileSync(join(directory, "skills/research/assets/pixel.bin")), Buffer.from([0, 255, 128, 12]));
    approveSkill("research"); assert.equal(readSkillFile("research", "references/check.md"), "Use primary sources.");
    assert.throws(() => readSkillFile("research", "../mcp.json"), /Invalid/);
    assert.throws(() => installRemoteSkill(preview.id), /expired/);
  });
  it("rejects a symlink bundle before any source file is installed", async () => {
    await assert.rejects(previewRemoteSkill({ name: "research", repository: "example/skills" }, undefined, source("120000")), /symlinks/);
  });
});

describe("workspace vision provider formats", () => {
  it("sends observed images through all three provider wire formats", async () => {
    for (const kind of ["openai-compat", "anthropic", "converse"] as const) {
      let body: Record<string, any> = {};
      await chatResponse({ kind, baseUrl: "https://example.com", apiKey: "test", model: "vision" }, [{ role: "user", content: "Observe", images: [{ mimeType: "image/png", data: "aGVsbG8=" }] }], [], async (_url, request) => {
        body = JSON.parse(request.body);
        return { ok: true, status: 200, json: async () => kind === "openai-compat" ? { choices: [{ message: { content: "seen" } }] } : kind === "anthropic" ? { content: [{ type: "text", text: "seen" }] } : { output: { message: { content: [{ text: "seen" }] } } } };
      });
      assert.match(JSON.stringify(body.messages), /aGVsbG8=/, kind);
      assert.match(JSON.stringify(body.messages), kind === "openai-compat" ? /image_url/ : kind === "anthropic" ? /base64/ : /"image"/, kind);
    }
  });
});
