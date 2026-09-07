import { createPhoneAccess } from "./phone/access.ts";
import { phoneNetwork } from "./phone/tailscale.ts";
import QRCode from "qrcode";
import { createWorkspaceView } from "./computer/view.ts";
import { createUpdates, type Updates } from "./updates.ts";
import { xaiStatus, importHermesXai, beginXaiLogin, pollXaiLogin, disconnectXai, xaiModels } from "./auth/xai.ts";
import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentRuntime, agentContext, agentTools, readArtifact } from "./agents/runtime.ts";
import { activeLessons, addEvalCase, createProposal, decideProposal, deleteEvalCase, feedbackRun, getProposal, getRun, listEvalCases, listEvaluations, listProposals, listRuns, runEvaluation, summarizeRuns } from "./agents/insights.ts";
import { assertProviderReady, authenticatedProvider, candidateMachineConfigs, chatResponse, readMachineKey } from "./auth/providers.ts";
import { createCodexLogin, CODEX_BASE } from "./auth/codex.ts";
import { createGoogleLogin, GOOGLE_BASE, googleSetup, saveGoogleCredentials } from "./auth/google.ts";
import type { ProviderKind } from "./auth/providers.ts";
import { getProvider, providerStatus, setProvider, previewProvider, providerConnections, selectProvider, removeProvider, connectXai, connectMuse, connectQwen } from "./auth/store.ts";
import { museStatus } from "./auth/muse.ts";
import type { ProviderPatch } from "./auth/store.ts";
import { listProviderModels, providerPresets } from "./auth/catalog.ts";
import { createOpenRouterLogin } from "./auth/openrouter.ts";
import { createAgentImports } from "./imports/manager.ts";
import type { ImportRoots } from "./imports/sources.ts";
import { contextSettings, setContextSettings, contextStatus } from "./context/manager.ts";
import type { ContextSettings } from "./context/manager.ts";
import { botDeletionPreview, deleteBot, ensureBot, getBot, listBots, listSections, markRead, readSoul, saveSections, unreadCount, updateBot } from "./bots/manager.ts";
import { writeSoul, readBotContext, writeBotContext } from "./bots/manager.ts";
import { createGroup, deleteGroup, getGroup, listGroups } from "./chat/session.ts";
import { createComputer } from "./computer/workspace.ts";
import { addJob, listExecutions, listJobs, nextRun, removeJob, runDue } from "./crons/scheduler.ts";
import { InputError, requiredText, textList } from "./errors.ts";
import { appendEvent, bus, eventsAfter, lastSeq, previewOf, tailEvents, validateScope } from "./events/log.ts";
import type { FeedEvent } from "./events/log.ts";
import { approveSkill, installSkill, listInstalledSkills, readInstalledSkill, searchSkills } from "./marketplace/search.ts";
import { appendMemory, ensureMemoryFiles, readMemory, readUserEntries, searchMemory, updateUser, manageMemory, memorySettings, memoryUsage, setMemoryEnabled, invalidateMemoryWriters } from "./memory/store.ts";
import { addMcpServer, readMcp, readWebSearch, removeMcpServer, setMcpEnabled, webSearch, writeWebSearch } from "./mcp/manager.ts";
import { createMcpRuntime } from "./mcp/client.ts";
import { searchMcpRegistry, installRegistryServer } from "./mcp/registry.ts";
import { browseSkillRepository, searchRemoteSkills, previewRemoteSkill, installRemoteSkill } from "./marketplace/remote.ts";
import { readWebpage } from "./network/web.ts";
import { dataDir } from "./store.ts";
import { cancelDemo, captureDemo, finishDemo, getDemo, listDemos, startDemo } from "./teach/demos.ts";

const WEB = fileURLToPath(new URL("../web/", import.meta.url));
const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };

function optionalText(value: unknown, label: string, max = 4000): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > max) throw new InputError(`${label} must be text of at most ${max} characters`);
  return value;
}
function optionalBoolean(value: unknown): boolean | undefined {
  if (value !== undefined && typeof value !== "boolean") throw new InputError("Expected a boolean");
  return value;
}
function providerPatch(b: Record<string, unknown>): ProviderPatch {
  return { id: optionalText(b.id, "Connection", 80), name: optionalText(b.name, "Connection name", 80), kind: b.kind as ProviderKind | undefined,
    baseUrl: optionalText(b.baseUrl, "Endpoint", 2000), model: optionalText(b.model, "Model", 200), auth: b.auth as ProviderPatch["auth"], apiKey: optionalText(b.apiKey, "API key", 10000),
    clearKey: optionalBoolean(b.clearKey), rememberKey: optionalBoolean(b.rememberKey), newConnection: optionalBoolean(b.newConnection) };
}
function number(value: unknown, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== "number" && (typeof value !== "string" || !/^\d+$/.test(value))) throw new InputError("Expected an integer");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new InputError(`Expected an integer between ${min} and ${max}`);
  return parsed;
}
function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    req.on("data", (chunk: Buffer) => {
      if (failed) return;
      size += chunk.length;
      if (size > 256 * 1024) { failed = true; chunks.length = 0; reject(new InputError("Request is too large (256 KiB maximum)", 413)); }
      else chunks.push(chunk);
    });
    req.on("end", () => {
      if (failed) return;
      try {
        const parsed: unknown = size ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
        resolveBody(parsed as Record<string, unknown>);
      } catch { reject(new InputError("Request must be a valid JSON object")); }
    });
    req.on("aborted", () => reject(new InputError("Request was interrupted")));
    req.on("error", reject);
  });
}

export function createApp(options: Parameters<typeof createAgentRuntime>[0] & { scheduler?: boolean; accessToken?: string; webRoot?: string; onProviderConnected?: (id: string) => void; openRouterRequest?: typeof fetch; importRoots?: ImportRoots; updates?: Updates; phonePort?: number } = {}) {
  const updates = options.updates ?? createUpdates();
  ensureMemoryFiles();
  const computer = options.computer ?? createComputer();
  const mcp = options.mcp ?? createMcpRuntime();
  const workspaceView = options.workspaceView ?? createWorkspaceView(computer);
  const runtime = createAgentRuntime({ ...options, computer, mcp, workspaceView });
  const openRouter = createOpenRouterLogin({ request: options.openRouterRequest, connected: options.onProviderConnected });
  function oauthConnection(kind: "openai-codex" | "google-oauth", id?: string, model = "") {
    const baseUrl = kind === "openai-codex" ? CODEX_BASE : GOOGLE_BASE;
    const existing = id ? getProvider(id) : undefined;
    if (existing && (existing.kind !== kind || existing.baseUrl !== baseUrl)) throw new InputError("The selected connection changed during sign-in. Start again.", 409);
    return setProvider(existing ? { id, model: existing.model || model, rememberKey: false } : { newConnection: true, kind, baseUrl, auth: "bearer", name: kind === "openai-codex" ? "ChatGPT" : "Google Gemini", model, rememberKey: false }).id!;
  }
  const codex = createCodexLogin((id, model) => { const saved = oauthConnection("openai-codex", id, model); options.onProviderConnected?.(saved); return saved; });
  const google = createGoogleLogin((credentials, id) => {
    const saved = oauthConnection("google-oauth", id);
    try { saveGoogleCredentials(saved, credentials); } catch (error) { if (!id) removeProvider(saved); throw error; }
    options.onProviderConnected?.(saved); return saved;
  });
  const imports = createAgentImports(options.importRoots || { hermes: process.env.LINUBOT_IMPORT_HERMES, grok: process.env.LINUBOT_IMPORT_GROK });
  const webRoot = options.webRoot ?? WEB;
  const phone = createPhoneAccess({ webRoot, port: options.phonePort, target: () => { const address = server.address(); if (!address || typeof address === "string" || !options.accessToken) throw new InputError("Desktop server is not ready", 503); return { port: address.port, token: options.accessToken }; } });
  const streams = new Set<ServerResponse>();
  const evaluations = new Set<AbortController>();
  let stopping = false, updating = false;
  let jobsRunning: ReturnType<typeof runDue> | undefined;
  let schedulerError: string | undefined;
  const runningJobs = new Map<string, { bot: string; deliver?: string }>();

  function roster() {
    return listBots().map((bot) => ({ ...bot, provider: botProvider(bot), preview: previewOf(`bot:${bot.name}`).slice(0, 140), unread: unreadCount(`bot:${bot.name}`), state: runtime.state(`bot:${bot.name}`) }));
  }
  function botProvider(bot: NonNullable<ReturnType<typeof getBot>>) {
    const status = providerStatus(bot.providerId);
    const model = bot.model === "default" ? status.model : bot.model;
    return { ...status, model, ready: (status.hasKey || status.auth === "none") && Boolean(model) && model !== "default" };
  }
  function groups() { return listGroups().map((group) => ({ ...group, name: group.name || group.id, unread: unreadCount(`group:${group.id}`), state: runtime.state(`group:${group.id}`) })); }
  function requireBot(name: string) { const bot = getBot(name); if (!bot) throw new InputError("Teammate not found", 404); return bot; }
  function requireScope(scope: string) {
    validateScope(scope);
    if (scope.startsWith("bot:")) requireBot(scope.slice(4));
    else if (!getGroup(scope.slice(6))) throw new InputError("Group not found", 404);
  }
  function jobs() { return listJobs().map((job) => {
    try { return { ...job, nextRun: job.enabled === false ? null : nextRun(job.schedule) }; }
    catch (error) { return { ...job, nextRun: null, error: error instanceof Error ? error.message : String(error) }; }
  }); }

  function runJobs() {
    if (jobsRunning) return jobsRunning;
    jobsRunning = runDue(new Date(), async (job) => {
      runningJobs.set(job.name, job);
      try {
      const [run] = runtime.enqueue({ scope: `bot:${job.bot}`, message: job.prompt, source: "cron", from: `cron:${job.name}` });
      const result = await runtime.wait(run.id);
      if (result.status !== "completed") throw new Error(result.error || "Routine did not complete");
      const destination = job.deliver || `bot:${job.bot}`;
      requireScope(destination);
      if (destination !== run.scope) {
        appendEvent(destination, { kind: "message", from: job.bot, text: result.response, runId: run.id });
      }
      return `Delivered to ${destination}. Task ${run.id}\n\n${result.response}`;
      } finally { runningJobs.delete(job.name); }
    }).finally(() => { jobsRunning = undefined; });
    return jobsRunning;
  }

  const server = createServer(async (req, res) => {
    const send = (status: number, value: unknown) => {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(value));
    };
    const ok = (value: unknown) => send(200, value);
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("x-frame-options", "DENY");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("cache-control", "no-store");
    res.setHeader("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    try {
      const port = req.socket.localPort;
      const host = req.headers.host;
      if (![ `127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}` ].includes(host ?? "")) throw new InputError("Untrusted Host header", 403);
      const url = new URL(req.url ?? "/", `http://${host}`);
      const path = url.pathname.split("/").filter(Boolean).map((segment) => {
        try { return decodeURIComponent(segment); } catch { throw new InputError("Invalid URL encoding"); }
      });
      if (path[0] === "api") {
        if (options.accessToken) {
          const supplied = Buffer.from(String(req.headers["x-linubot-token"] ?? ""));
          const expected = Buffer.from(options.accessToken);
          if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new InputError("This API is private to the desktop app", 403);
        }
        if ((req.headers.origin && req.headers.origin !== `http://${host}`) || req.headers["sec-fetch-site"] === "cross-site") throw new InputError("Cross-origin API access is not allowed", 403);
        if (stopping) throw new InputError("Server is stopping", 503);
        if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(req.method ?? "")) throw new InputError("Method not allowed", 405);
        if (req.method !== "GET" && (Number(req.headers["content-length"]) > 0 || req.headers["transfer-encoding"]) && !req.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
          throw new InputError("Use application/json for API requests", 415);
        }
      } else if (req.method === "GET") {
        if (path.length === 2 && path[0] === "assets" && ["icon.png", "logo.png"].includes(path[1])) {
          const asset = join(webRoot, "assets", path[1]);
          if (!existsSync(asset)) throw new InputError("Image not found", 404);
          res.writeHead(200, { "content-type": "image/png" }); res.end(readFileSync(asset)); return;
        }
        const filename = path.length === 0 ? "index.html" : path.length === 1 ? path[0] : "";
        if (!/^[a-z0-9-]+\.(html|js|css)$/.test(filename) || basename(filename) !== filename || !existsSync(join(webRoot, filename))) throw new InputError("Page not found", 404);
        res.writeHead(200, { "content-type": MIME[extname(filename)] });
        res.end(readFileSync(join(webRoot, filename)));
        return;
      }
      if (path[0] !== "api") throw new InputError("Not found", 404);
      const r = path.slice(1);
      const method = req.method;
      const b = method === "GET" ? {} : await body(req);
      if (updating && method !== "GET") throw new InputError("Linubot is restarting for an update", 503);

      if (r[0] === "phone") {
        if (!options.accessToken || req.headers["x-linubot-client"] === "phone") throw new InputError("Phone access is managed by the Linux desktop app", 403);
        if (r.length === 1 && method === "GET") { ok(phone.status()); return; }
        if (r[1] === "enable" && method === "POST") {
          if (b.origin) { ok(await phone.enable(requiredText(b.origin, "HTTPS address", 250))); return; }
          const network = await phoneNetwork();
          await phone.enable(network.origin);
          try { await network.configure(); } catch (error) { await phone.disable(); throw error; }
          ok(phone.status()); return;
        }
        if (r[1] === "disable" && method === "POST") { ok(await phone.disable()); return; }
        if (r[1] === "pair" && method === "POST") { const pairing = phone.pair(); ok({ ...pairing, qr: await QRCode.toDataURL(pairing.url, { width: 256, margin: 2 }) }); return; }
        if (r[1] === "devices" && r.length === 3 && method === "DELETE") { ok(phone.revoke(r[2])); return; }
      }
      if (r[0] === "overview" && method === "GET") {
        ok({ provider: providerStatus(), bots: roster(), groups: groups(), summary: summarizeRuns(), runs: listRuns({ limit: 30 }),
          proposals: listProposals(), jobs: jobs(), schedulerError, memory: memoryUsage(),
          capabilities: { tools: agentTools().map((tool) => tool.name), mcp: "connected-tools", connections: mcp.status(), search: readWebSearch().backend !== "disabled", web: true, desktop: Boolean(options.accessToken), phone: req.headers["x-linubot-client"] === "phone" } });
        return;
      }
      if (r[0] === "stream" && method === "GET") {
        const scope = requiredText(url.searchParams.get("scope"), "Scope", 80);
        requireScope(scope);
        const after = number(req.headers["last-event-id"] ?? url.searchParams.get("after"), lastSeq(scope));
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
        res.write(": connected\n\n");
        streams.add(res);
        const push = (event: FeedEvent) => {
          if (res.destroyed || res.writableEnded) return;
          if (res.writableLength > 1024 * 1024) { res.destroy(); return; }
          res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
        };
        const listener = (target: string, event: FeedEvent) => { if (target === scope) push(event); };
        bus.on("event", listener);
        for (const event of eventsAfter(scope, after)) push(event);
        const timer = setInterval(() => res.write(": heartbeat\n\n"), 15000);
        timer.unref();
        res.once("close", () => { clearInterval(timer); bus.off("event", listener); streams.delete(res); });
        return;
      }
      if (r[0] === "feed" && r.length === 2 && method === "GET") {
        requireScope(r[1]);
        ok(tailEvents(r[1], number(url.searchParams.get("limit"), 50, 1, 200), url.searchParams.has("before") ? number(url.searchParams.get("before"), 1, 1) : undefined));
        return;
      }
      if (r[0] === "imports") {
        if (r[1] === "sources" && method === "GET") { ok(imports.discover()); return; }
        if (r[1] === "preview" && method === "POST") { ok(imports.preview({ sourceId: optionalText(b.sourceId, "Source", 80), sourceIds: b.sourceIds === undefined ? undefined : textList(b.sourceIds, "Sources", 100, 80), name: optionalText(b.name, "Name", 40), providerId: optionalText(b.providerId ?? undefined, "Provider", 80), model: optionalText(b.model, "Model", 200), memory: optionalBoolean(b.memory), skills: optionalBoolean(b.skills), history: optionalBoolean(b.history), routines: optionalBoolean(b.routines) })); return; }
        if (r[1] === "commit" && method === "POST") { ok(imports.commit(requiredText(b.id, "Preview", 80))); return; }
      }
      if (r[0] === "bots") {
        if (r.length === 1 && method === "GET") { ok(roster()); return; }
        if (r.length === 1 && method === "POST") {
          if (b.providerId) getProvider(requiredText(b.providerId, "Provider connection", 80));
          ok(await ensureBot(requiredText(b.name, "Name", 40), undefined, {
            model: optionalText(b.model, "Model", 200), providerId: optionalText(b.providerId, "Provider connection", 80), topic: optionalText(b.topic, "Specialty", 2000), goal: optionalText(b.goal, "Goal", 4000), mascotSeed: optionalText(b.mascotSeed, "Mascot seed", 80),
          })); return;
        }
        const bot = requireBot(r[1]);
        const scope = `bot:${bot.name}`;
        if (r.length === 2 && method === "GET") { ok({ ...bot, provider: botProvider(bot), soul: readSoul(bot.name), importedContext: readBotContext(bot.name), unread: unreadCount(scope), state: runtime.state(scope), feed: tailEvents(scope) }); return; }
        if (r.length === 2 && method === "PATCH") {
          if (b.providerId) getProvider(requiredText(b.providerId, "Provider connection", 80));
          ok(updateBot(bot.name, {
            providerId: b.providerId === null ? null : optionalText(b.providerId, "Provider connection", 80),
            model: optionalText(b.model, "Model", 200) || undefined, topic: b.topic === null ? null : optionalText(b.topic, "Specialty", 2000), goal: optionalText(b.goal, "Goal", 4000), mascotSeed: optionalText(b.mascotSeed, "Mascot seed", 80),
            pinned: optionalBoolean(b.pinned), skills: b.skills === undefined ? undefined : textList(b.skills, "Skills", 40, 40),
          })); return;
        }
        if (r[2] === "deletion" && method === "GET") { ok(botDeletionPreview(bot.name)); return; }
        if (r.length === 2 && method === "DELETE") {
          if (runtime.hasBotWork(bot.name)) throw new InputError("Stop this teammate's active tasks before deleting it", 409);
          const preview = botDeletionPreview(bot.name);
          if ([...runningJobs.values()].some((job) => job.bot === bot.name || job.deliver === scope || preview.emptyGroups.some((id) => job.deliver === `group:${id}`))) throw new InputError("Wait for routines delivering to this bot or its groups before deleting it", 409);
          ok({ deleted: deleteBot(bot.name, { detachReferences: optionalBoolean(b.detachReferences) }) }); return;
        }
        if (r[2] === "soul" && method === "PUT") { writeSoul(bot.name, requiredText(b.soul, "Instructions", 100000)); ok({ saved: true }); return; }
        if (r[2] === "imported-context" && method === "PUT") { writeBotContext(bot.name, typeof b.text === "string" ? b.text : requiredText(b.text, "Imported context", 100000)); ok({ saved: true }); return; }
        if (r[2] === "read" && method === "POST") { markRead(scope, b.seq === undefined ? undefined : number(b.seq, 0)); ok({ read: true }); return; }
      }
      if (r[0] === "sections") {
        if (method === "GET") { ok(listSections()); return; }
        if (method === "PUT") { ok(saveSections(b.sections as Parameters<typeof saveSections>[0])); return; }
      }
      if (r[0] === "chat" && method === "POST") {
        const name = requiredText(b.bot, "Teammate", 40);
        const runs = runtime.enqueue({ scope: `bot:${name}`, message: requiredText(b.message, "Task"), criteria: b.criteria === undefined ? [] : textList(b.criteria, "Criteria"),
          mode: optionalText(b.mode, "Mode", 20) as "queue" | "redirect" | undefined, clientId: optionalText(b.clientId, "Request ID", 40), remember: optionalBoolean(b.remember) });
        send(202, { run: runs[0], runs }); return;
      }
      if (r[0] === "stop" && method === "POST") { ok(runtime.stop(requiredText(b.scope, "Scope", 80))); return; }
      if (r[0] === "dm" && method === "POST") {
        const from = requireBot(requiredText(b.from, "Sender", 40));
        const to = requireBot(requiredText(b.to, "Recipient", 40));
        const runs = runtime.enqueue({ scope: `bot:${to.name}`, message: requiredText(b.text, "Task"), source: "handoff" });
        appendEvent(`bot:${to.name}`, { kind: "handoff", from: from.name, to: to.name, runId: runs[0].id, text: "Requested by the owner." });
        send(202, { run: runs[0], runs }); return;
      }
      if (r[0] === "groups") {
        if (r.length === 1 && method === "GET") { ok(groups()); return; }
        if (r.length === 1 && method === "POST") { ok(await createGroup(requiredText(b.id, "Group ID", 40), textList(b.members, "Group members", 20, 40), optionalText(b.name, "Group name", 80))); return; }
        const group = getGroup(r[1]);
        if (!group) throw new InputError("Group not found", 404);
        const scope = `group:${group.id}`;
        if (r.length === 2 && method === "GET") { ok({ ...group, name: group.name || group.id, unread: unreadCount(scope), state: runtime.state(scope), feed: tailEvents(scope) }); return; }
        if (r.length === 2 && method === "DELETE") {
          if (runtime.state(scope) !== "idle") throw new InputError("Stop this group's active tasks before deleting it", 409);
          ok({ deleted: deleteGroup(group.id) }); return;
        }
        if (r[2] === "read" && method === "POST") { markRead(scope, b.seq === undefined ? undefined : number(b.seq, 0)); ok({ read: true }); return; }
        if (r[2] === "post" && method === "POST") {
          const runs = runtime.enqueue({ scope, message: requiredText(b.text, "Task"), criteria: b.criteria === undefined ? [] : textList(b.criteria, "Criteria"), mode: optionalText(b.mode, "Mode", 20) as "queue" | "redirect" | undefined, clientId: optionalText(b.clientId, "Request ID", 40) });
          send(202, { run: runs[0], runs }); return;
        }
      }
      if (r[0] === "runs") {
        if (r.length === 1 && method === "GET") { ok(listRuns({ bot: url.searchParams.get("bot") ?? undefined, scope: url.searchParams.get("scope") ?? undefined, limit: number(url.searchParams.get("limit"), 50, 1, 200) })); return; }
        if (r.length === 3 && r[2] === "continue" && method === "POST") { ok({ runs: runtime.continueTask(r[1]) }); return; }
        if (r.length === 2 && method === "GET") { ok(getRun(r[1])); return; }
        if (r[2] === "feedback" && method === "POST") {
          ok(feedbackRun(r[1], { rating: requiredText(b.rating, "Rating", 20), note: optionalText(b.note, "Feedback", 4000), minutesSaved: b.minutesSaved as number | null | undefined })); return;
        }
      }
      if (r[0] === "agents") {
        const bot = requireBot(r[1]);
        if (r[2] === "insights" && method === "GET") { ok({ summary: summarizeRuns(bot.name), runs: listRuns({ bot: bot.name }), proposals: listProposals(bot.name), cases: listEvalCases(bot.name), evaluations: listEvaluations(bot.name), lessons: activeLessons(bot.name) }); return; }
        if (r[2] === "proposals" && method === "GET") { ok(listProposals(bot.name)); return; }
        if (r[2] === "proposals" && r.length === 3 && method === "POST") {
          ok(createProposal({ bot: bot.name, runId: requiredText(b.runId, "Source task", 40), text: requiredText(b.text, "Lesson", 2000), reason: requiredText(b.reason, "Reason", 4000), evidence: requiredText(b.evidence, "Source quote", 4000) })); return;
        }
        if (r[2] === "proposals" && r[4] === "decision" && method === "POST") {
          if (getProposal(r[3]).bot !== bot.name) throw new InputError("Proposal does not belong to this teammate", 404);
          ok(decideProposal(r[3], requiredText(b.decision, "Decision", 20) as "accept" | "reject" | "rollback", agentContext(bot.name).revision)); return;
        }
        if (r[2] === "cases") {
          if (r.length === 3 && method === "GET") { ok(listEvalCases(bot.name)); return; }
          if (r.length === 3 && method === "POST") { ok(addEvalCase({ bot: bot.name, name: requiredText(b.name, "Case name", 200), prompt: requiredText(b.prompt, "Case prompt"), includes: b.includes === undefined ? [] : textList(b.includes, "Required literals"), excludes: b.excludes === undefined ? [] : textList(b.excludes, "Forbidden literals") })); return; }
          if (r.length === 4 && method === "DELETE") { deleteEvalCase(bot.name, r[3]); ok({ deleted: true }); return; }
        }
        if (r[2] === "evaluations" && method === "GET") { ok(listEvaluations(bot.name)); return; }
        if (r[2] === "evaluations" && method === "POST") {
          const context = agentContext(bot.name);
          assertProviderReady(context.provider);
          const controller = new AbortController();
          evaluations.add(controller);
          const disconnect = () => { if (!res.writableEnded) controller.abort(new Error("Evaluation client disconnected")); };
          res.once("close", disconnect);
          try {
            ok(await runEvaluation(bot.name, optionalText(b.proposalId, "Proposal ID", 40), {
              revision: context.revision, model: context.provider.model, signal: controller.signal,
              respond: async (prompt, lessons, signal) => {
                if (agentContext(bot.name).revision !== context.revision) throw new InputError("Teammate context changed during evaluation; run the suite again", 409);
                const candidate = agentContext(bot.name, lessons);
                const messages = [{ role: "system", content: candidate.system + "\nEvaluation mode: no tools are available. Use the supplied brief only. Do not claim external verification or actions." }, { role: "user", content: prompt }];
                const result = options.complete ? await options.complete(candidate.provider, messages, [], signal!) : await chatResponse(candidate.provider, messages, [], undefined, signal);
                if (result.toolCalls.length) throw new Error("Evaluation expected an answer, not tool calls");
                if (agentContext(bot.name).revision !== context.revision) throw new InputError("Teammate context changed during evaluation", 409);
                return requiredText(result.text, "Evaluation answer", 200000);
              },
            }));
          } finally { evaluations.delete(controller); res.off("close", disconnect); }
          return;
        }
      }
      if (r[0] === "memory" && r[1] === "settings" && r.length === 2) {
        if (method === "GET") { ok(memorySettings()); return; }
        if (method === "PUT") {
          const enabled = optionalBoolean(b.enabled);
          if (enabled === undefined) throw new InputError("Memory enabled is required");
          ok(setMemoryEnabled(enabled)); return;
        }
      }
      if (r[0] === "context" && r[1] === "settings" && r.length === 2) {
        if (method === "GET") { ok(contextSettings()); return; }
        if (method === "PUT") {
          const current = contextSettings();
          ok(setContextSettings({ enabled: optionalBoolean(b.enabled) ?? current.enabled, mode: b.mode === undefined ? current.mode : b.mode as ContextSettings["mode"],
            inputBudget: b.inputBudget === undefined ? current.inputBudget : number(b.inputBudget, current.inputBudget, 2000, 1000000),
            targetTokens: b.targetTokens === undefined ? current.targetTokens : number(b.targetTokens, current.targetTokens, 500, 500000),
            recentUnits: b.recentUnits === undefined ? current.recentUnits : number(b.recentUnits, current.recentUnits, 2, 20) })); return;
        }
      }
      if (r[0] === "context" && r.length === 2 && method === "GET") { requireScope(r[1]); ok(contextStatus(r[1])); return; }
      if ((r[0] === "memory" || r[0] === "user") && r.length === 1) {
        if (method === "GET") { const query = url.searchParams.get("q"); ok({ memory: query ? searchMemory(query) : readMemory(), user: readUserEntries(), settings: memoryUsage() }); return; }
        if (method === "POST") {
          const entries = textList(b.entries, "Memory entries");
          invalidateMemoryWriters();
          ok({ added: r[0] === "user" ? updateUser(entries) : appendMemory(entries) }); return;
        }
        if (method === "PATCH" || method === "DELETE") {
          ok(manageMemory({ action: method === "DELETE" ? "remove" : "replace", target: r[0], old_text: requiredText(b.old_text, "Old entry", 4000),
            content: method === "DELETE" ? undefined : requiredText(b.content, "Memory content", 2000) }, { owner: true })); return;
        }
      }
      if (r[0] === "jobs") {
        if (r[1] === "history" && method === "GET") { ok(listExecutions()); return; }
        if (r.length === 1 && method === "GET") { ok(jobs()); return; }
        if (r.length === 1 && method === "POST") { ok(addJob({ name: requiredText(b.name, "Routine name", 120), schedule: requiredText(b.schedule, "Schedule", 200), prompt: requiredText(b.prompt, "Task"), bot: requiredText(b.bot, "Teammate", 40), deliver: optionalText(b.deliver, "Delivery", 80), enabled: optionalBoolean(b.enabled) })); return; }
        if (r[1] === "run" && method === "POST") { ok(await runJobs()); return; }
        if (r.length === 2 && method === "PATCH") {
          const job = listJobs().find((job) => job.name === r[1]);
          if (!job) throw new InputError("Routine not found", 404);
          ok(addJob({ ...job, enabled: optionalBoolean(b.enabled) ?? job.enabled })); return;
        }
        if (r.length === 2 && method === "DELETE") { ok(removeJob(r[1])); return; }
      }
      if (r[0] === "screenshots" && r.length === 2 && method === "GET") {
        if (!/^[a-f0-9-]{36}$/.test(r[1])) throw new InputError("Invalid screenshot ID");
        const image = join(dataDir(), "screenshots", `${r[1]}.png`);
        if (!existsSync(image)) throw new InputError("Screenshot not found", 404);
        const stat = lstatSync(image);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) throw new InputError("Invalid screenshot");
        res.writeHead(200, { "content-type": "image/png" }); res.end(readFileSync(image)); return;
      }
      if (r[0] === "skills" && r[1] === "remote") {
        if (r[2] === "search" && method === "GET") { ok(await searchRemoteSkills(url.searchParams.get("q") ?? "research")); return; }
        if (r[2] === "repository" && method === "GET") { ok(await browseSkillRepository(requiredText(url.searchParams.get("repo"), "Repository", 200))); return; }
        if (r[2] === "preview" && method === "POST") { ok(await previewRemoteSkill({ repository: requiredText(b.repository, "Repository", 200), name: requiredText(b.name, "Skill name", 100), path: optionalText(b.path, "Skill path", 500) })); return; }
        if (r[2] === "install" && method === "POST") { ok(installRemoteSkill(requiredText(b.id, "Preview ID", 100))); return; }
      }
      if (r[0] === "skills") {
        if (r.length === 1 && method === "GET") { ok(searchSkills(join(process.cwd(), ".skills"), url.searchParams.get("q") ?? "")); return; }
        if (r[1] === "installed" && method === "GET") { ok(listInstalledSkills(true)); return; }
        if (r[1] === "install" && method === "POST") { ok({ installed: installSkill(requiredText(b.name, "Skill name", 40), requiredText(b.path, "Discovered skill path", 4000)) }); return; }
        if (r.length === 2 && method === "GET") { const skill = readInstalledSkill(r[1], true); if (!skill) throw new InputError("Skill not found", 404); ok(skill); return; }
        if (r[2] === "approve" && method === "POST") { ok(approveSkill(r[1])); return; }
      }
      if (r[0] === "mcp") {
        if (r[1] === "registry" && method === "GET") { ok(await searchMcpRegistry(url.searchParams.get("q") ?? "", url.searchParams.get("cursor") ?? undefined)); return; }
        if (r[1] === "registry" && r[2] === "install" && method === "POST") { ok(installRegistryServer(requiredText(b.id, "Registry ID", 100), number(b.option, 0, 0, 20), requiredText(b.name, "Server name", 40))); return; }
        if (r.length === 1 && method === "GET") { ok({ ...readMcp(), connections: mcp.status() }); return; }
        if (r.length === 1 && method === "POST") {
          const name = requiredText(b.name, "Server name", 40);
          if (readMcp().servers[name]) throw new InputError("An MCP server with this name already exists", 409);
          ok(addMcpServer(name, { command: optionalText(b.command, "Command", 1024), args: b.args as string[] | undefined, transport: b.transport as "stdio" | "streamable-http" | "sse" | undefined, url: optionalText(b.url, "Endpoint", 2048), approved: true })); return;
        }
        if (r[2] === "connect" && method === "POST") {
          const name = r[1];
          const entry = readMcp().servers[name];
          if (!entry) throw new InputError("Unknown MCP server", 404);
          if (!entry.approved) addMcpServer(name, { ...entry, approved: true });
          if (b.env || b.headers) { await mcp.disconnect(name); mcp.setCredentials(name, { env: b.env as Record<string, string>, headers: b.headers as Record<string, string> }); }
          const connection = await mcp.connect(name);
          ok({ status: mcp.status()[name], tools: connection.tools.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations })) }); return;
        }
        if (r[2] === "disconnect" && method === "POST") { setMcpEnabled(r[1], false); await mcp.disconnect(r[1]); ok(mcp.status()); return; }
        if (r.length === 2 && method === "DELETE") { await mcp.forget(r[1]); ok(removeMcpServer(r[1])); return; }
        if (r[2] === "enabled" && method === "POST") { const enabled = optionalBoolean(b.enabled); if (enabled === undefined) throw new InputError("enabled is required"); const result = setMcpEnabled(r[1], enabled); if (!enabled) await mcp.disconnect(r[1]); ok(result); return; }
      }
      if (r[0] === "websearch") {
        if (r.length === 1 && method === "GET") { ok(readWebSearch()); return; }
        if (r.length === 1 && method === "POST") { ok(writeWebSearch({ backend: b.backend as "bing" | "xai" | "searxng" | "disabled" | undefined, url: optionalText(b.url, "Search endpoint", 2000), maxResults: b.maxResults === undefined ? undefined : number(b.maxResults, 5, 1, 20) })); return; }
        if (r[1] === "search" && method === "GET") { ok(await webSearch(requiredText(url.searchParams.get("q"), "Query", 2000))); return; }
      }
      if (r[0] === "web" && r[1] === "read" && method === "GET") { ok(await readWebpage(requiredText(url.searchParams.get("url"), "URL", 4000))); return; }
      if (r[0] === "xai") {
        if (r.length === 1 && method === "GET") { ok(xaiStatus()); return; }
        if (r[1] === "models" && method === "GET") { ok(await xaiModels()); return; }
        if (r[1] === "import" && method === "POST") {
          if (b.approved !== true) throw new InputError("Approve use of the Hermes xAI sign-in", 403);
          importHermesXai(); connectXai(); ok(xaiStatus()); return;
        }
        if (r[1] === "login" && method === "POST") { ok(await beginXaiLogin()); return; }
        if (r[1] === "poll" && method === "POST") {
          const result = await pollXaiLogin(requiredText(b.id, "Sign-in ID", 100));
          if (result.state === "connected") { connectXai(); options.onProviderConnected?.(getProvider().id!); }
          ok(result); return;
        }
        if (r[1] === "disconnect" && method === "POST") { ok(disconnectXai()); return; }
      }
      if (r[0] === "muse") {
        if (r.length === 1 && method === "GET") { ok(museStatus()); return; }
        if (r[1] === "connect" && method === "POST") { const connected = connectMuse(optionalText(b.id, "Connection", 80)); options.onProviderConnected?.(connected.id); ok(connected); return; }
      }
      if (r[0] === "oauth" && ["codex", "google"].includes(r[1])) {
        const service = r[1] === "codex" ? codex : google;
        if (r[1] === "google" && r[2] === "config" && method === "GET") { ok(googleSetup(url.searchParams.get("id") || undefined)); return; }
        if (r[1] === "codex" && r[2] === "existing" && method === "POST") { ok(await codex.connectExisting(optionalText(b.id, "Connection", 80))); return; }
        if (r[2] === "start" && method === "POST") {
          const id = optionalText(b.id, "Connection", 80);
          if (id) { const current = getProvider(id); if (current.kind !== (r[1] === "codex" ? "openai-codex" : "google-oauth")) throw new InputError("Choose the matching sign-in provider"); }
          const disconnected = () => { if (!res.writableEnded) void service.cancel(); }; res.once("close", disconnected);
          try { ok(r[1] === "codex" ? await codex.begin(id) : await google.begin({ clientId: optionalText(b.clientId, "Client ID", 4000), clientSecret: optionalText(b.clientSecret, "Client secret", 4000), projectId: optionalText(b.projectId, "Project ID", 200) }, id)); }
          finally { res.off("close", disconnected); }
          return;
        }
        if (r[2] === "status" && method === "GET") { ok(service.status(requiredText(url.searchParams.get("id"), "Sign-in", 100))); return; }
        if (r[2] === "cancel" && method === "POST") { await service.cancel(requiredText(b.id, "Sign-in", 100)); ok({ cancelled: true }); return; }
      }
      if (r[0] === "oauth" && r[1] === "openrouter") {
        if (r[2] === "start" && method === "POST") { ok(await openRouter.begin(optionalText(b.id, "Connection", 80))); return; }
        if (r[2] === "status" && method === "GET") { ok(openRouter.status(requiredText(url.searchParams.get("id"), "Sign-in", 100))); return; }
        if (r[2] === "cancel" && method === "POST") { await openRouter.cancel(requiredText(b.id, "Sign-in", 100)); ok({ cancelled: true }); return; }
      }
      if (r[0] === "updates") {
        if (r.length === 1 && method === "GET") { ok(await updates.check()); return; }
        if (r[1] === "check" && method === "POST") { ok(await updates.check(true)); return; }
        if (r[1] === "install" && method === "POST") { ok(await updates.install()); return; }
      }
      if (r[0] === "provider") {
        if (r[1] === "qwen" && method === "POST") { ok(connectQwen(requiredText(b.baseUrl, "Qwen endpoint", 2000), optionalText(b.id, "Connection", 80))); return; }
        if (r.length === 1 && method === "GET") { ok(providerStatus(url.searchParams.get("id") || undefined)); return; }
        if (r.length === 1 && method === "POST") { const provider = setProvider(providerPatch(b)); ok(providerStatus(provider.id)); return; }
        if (r[1] === "connections" && method === "GET") { ok(providerConnections()); return; }
        if (r[1] === "presets" && method === "GET") { ok(providerPresets); return; }
        if (r[1] === "select" && method === "POST") { selectProvider(requiredText(b.id, "Connection", 80)); ok(providerStatus()); return; }
        if (r.length === 2 && method === "DELETE") { removeProvider(r[1]); ok({ removed: true }); return; }
        if (r[1] === "models" && (method === "GET" || method === "POST")) {
          const controller = new AbortController(); const disconnect = () => controller.abort();
          res.once("close", disconnect);
          try { ok(await listProviderModels(method === "GET" ? getProvider(url.searchParams.get("id") || undefined) : previewProvider(providerPatch(b)), controller.signal)); }
          finally { res.off("close", disconnect); }
          return;
        }
        if (r[1] === "test" && method === "POST") {
          const provider = await authenticatedProvider(getProvider(optionalText(b.id, "Connection", 80)));
          assertProviderReady(provider);
          const begin = Date.now();
          const result = options.complete ? await options.complete(provider, [{ role: "user", content: "Reply only with Connected." }], [], AbortSignal.timeout(60000)) : await chatResponse(provider, [{ role: "user", content: "Reply only with Connected." }]);
          ok({ ok: true, model: provider.model, response: result.text.slice(0, 300), durationMs: Date.now() - begin }); return;
        }
      }
      if (r[0] === "machine-configs" && method === "GET") { ok(candidateMachineConfigs()); return; }
      if (r[0] === "machine-key" && method === "POST") { setProvider({ id: optionalText(b.id, "Connection", 80), apiKey: readMachineKey(requiredText(b.path, "Listed configuration path", 4000), b.approved === true) }); ok({ loaded: true }); return; }
      if (r[0] === "approvals" && method === "POST") { runtime.decide(requiredText(b.scope, "Scope", 80), number(b.seq, 0, 1), requiredText(b.decision, "Decision", 20)); ok({ decided: true }); return; }
      if (r[0] === "artifacts" && r[2] === "download" && method === "GET") {
        const { artifact, content } = readArtifact(r[1]);
        res.writeHead(200, { "content-type": "text/markdown; charset=utf-8", "content-disposition": `attachment; filename="${artifact.filename}"` }); res.end(content); return;
      }
      if (r[0] === "computer") {
        if (r[1] === "views" && method === "GET") {
          const scope = url.searchParams.get("scope");
          ok({ workspaces: computer.owned().filter((entry) => entry.state === "running" && (!scope || !entry.scope || entry.scope === scope)).map((entry) => ({ ...entry, ...workspaceView.status(entry.id) })) }); return;
        }
        if (r[1] === "frame" && method === "GET") {
          const bytes = await workspaceView.frame(requiredText(url.searchParams.get("id"), "Workspace", 80));
          res.writeHead(200, { "content-type": "image/png", "content-length": bytes.length }); res.end(bytes); return;
        }
        if (r[1] === "control" && method === "POST") {
          const id = requiredText(b.id, "Workspace", 80);
          if (b.action === "take") {
            const ctrl = new AbortController(), disconnected = () => { if (!res.writableEnded) ctrl.abort(new Error("Panel closed")); };
            res.once("close", disconnected);
            try { ok(await workspaceView.take(id, ctrl.signal)); } finally { res.off("close", disconnected); }
            return;
          }
          if (b.action === "release") { await workspaceView.release(id, requiredText(b.token, "Control session", 80)); ok({ released: true }); return; }
          throw new InputError("Unknown control action");
        }
        if (r[1] === "input" && method === "POST") {
          await workspaceView.input(requiredText(b.id, "Workspace", 80), requiredText(b.token, "Control session", 80), b);
          ok({ accepted: true }); return;
        }
        if (r[1] === "doctor" && method === "GET") { ok({ report: await computer.doctor() }); return; }
        if (r[1] === "list" && method === "GET") { ok({ report: await computer.list() }); return; }
        if (r[1] === "start" && method === "POST") { ok(await computer.start({ purpose: requiredText(b.purpose, "Workspace purpose", 2000), acknowledge: b.acknowledge === true })); return; }
        if (r[1] === "stop" && method === "POST") { const id = requiredText(b.id, "Owned workspace ID", 80); workspaceView.forget(id); ok({ report: await computer.stop(id) }); return; }
        if (r[1] === "cleanup" && method === "POST") { ok({ report: await computer.cleanup(requiredText(b.id, "Owned workspace ID", 80)) }); return; }
        if (r[1] === "viewer" && method === "POST") { ok({ report: await computer.openViewer(requiredText(b.id, "Owned workspace ID", 80), { inputForwarding: optionalBoolean(b.inputForwarding) }) }); return; }
      }
      if (r[0] === "demos") {
        if (r.length === 1 && method === "GET") { ok(listDemos()); return; }
        if (r.length === 1 && method === "POST") { ok(await startDemo(computer, requiredText(b.bot, "Teammate", 40), requiredText(b.purpose, "Demonstration purpose", 2000), { acknowledge: b.acknowledge === true })); return; }
        if (r[2] === "capture" && method === "POST") { ok(await captureDemo(computer, r[1])); return; }
        if (r[2] === "finish" && method === "POST") { ok(await finishDemo(computer, r[1], requiredText(b.skill, "Skill name", 40), requiredText(b.notes, "Demonstrated steps", 20000))); return; }
        if (r[2] === "cancel" && method === "POST") { ok(await cancelDemo(computer, r[1])); return; }
        if (r[2] === "shots" && method === "GET") {
          const demo = getDemo(r[1]);
          const shot = demo.shots[number(r[3], 0, 0, 1000)];
          if (!shot || !existsSync(shot)) throw new InputError("Screenshot not found", 404);
          const parent = realpathSync(join(dataDir(), "demos", demo.id)) + sep;
          if (!realpathSync(shot).startsWith(parent) || lstatSync(shot).isSymbolicLink()) throw new InputError("Unsafe screenshot path", 403);
          res.writeHead(200, { "content-type": "image/png" }); res.end(readFileSync(shot)); return;
        }
      }
      throw new InputError("Not found", 404);
    } catch (error) {
      if (res.headersSent) { res.end(); return; }
      send(error instanceof InputError ? error.status : 500, { error: error instanceof Error ? error.message : "Unexpected server error" });
    }
  });
  server.requestTimeout = 300000;
  server.headersTimeout = 10000;
  let scheduler: NodeJS.Timeout | undefined;
  server.once("listening", () => {
    if (options.scheduler === false) return;
    scheduler = setInterval(() => {
      if (stopping || updating) return;
      void runJobs().then(() => { schedulerError = undefined; }, (error) => { schedulerError = error instanceof Error ? error.message : String(error); });
    }, 15000);
    scheduler.unref();
  });
  server.once("listening", () => { if (options.accessToken) void phone.start().catch(() => {}); });
  return { server, runtime, freezeForUpdate() {
    if (runtime.busy() || workspaceView.busy() || evaluations.size || jobsRunning) throw new InputError("Finish active tasks before upgrading Linubot", 409);
    updating = true; runtime.pauseAdmissions(true);
    return () => { updating = false; runtime.pauseAdmissions(false); };
  }, hasActiveWork: () => runtime.busy() || workspaceView.busy() || evaluations.size > 0 || Boolean(jobsRunning), async close() {
    stopping = true;
    clearInterval(scheduler);
    evaluations.forEach((controller) => controller.abort(new Error("Server is stopping")));
    await phone.close();
    workspaceView.close();
    await runtime.close();
    await openRouter.close();
    await codex.close();
    await google.close();
    await mcp.close();
    await jobsRunning?.catch(() => {});
    streams.forEach((response) => response.end());
    await new Promise<void>((done, reject) => {
      if (!server.listening) { done(); return; }
      server.close((error) => error ? reject(error) : done());
      server.closeIdleConnections();
    });
  } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = number(process.env.LINUBOT_PORT, 5598, 0, 65535);
  const app = createApp();
  app.server.listen(port, "127.0.0.1", () => {
    const address = app.server.address();
    console.log(`linubot on http://127.0.0.1:${typeof address === "object" && address ? address.port : port}`);
  });
  let closing = false;
  const shutdown = () => { if (!closing) { closing = true; void app.close().catch((error) => { console.error(error); process.exitCode = 1; }); } };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
