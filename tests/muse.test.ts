import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeJson } from "../src/store.ts";
import { connectMuse, getProvider, setProvider, providerConnections, providerStatus, previewProvider } from "../src/auth/store.ts";
import { museCredential, museStatus } from "../src/auth/muse.ts";

let root: string;
const before = { data: process.env.LINUBOT_DATA, config: process.env.XDG_CONFIG_HOME };
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "linubot-muse-")); process.env.LINUBOT_DATA = join(root, "data"); process.env.XDG_CONFIG_HOME = join(root, "config"); mkdirSync(join(root, "config/muse"), { recursive: true }); });
afterEach(() => { for (const [key, value] of [["LINUBOT_DATA", before.data], ["XDG_CONFIG_HOME", before.config]]) { if (value === undefined) delete process.env[key!]; else process.env[key!] = value; } rmSync(root, { recursive: true, force: true }); });
function signIn(key = "LLM|fixture|model-api-key", base = "https://api.meta.ai/v1") {
  writeJson(join(root, "config/muse/auth.json"), { providers: { meta: { api_base_url: base, api_key: key, access_token: "account-token-never-imported" } } });
  writeJson(join(root, "config/muse/settings.json"), { model: "muse-spark-1.3-contributor" });
}

describe("Muse Code connection", () => {
  it("uses the existing model API key without copying credentials or switching the app default", () => {
    signIn(); const original = readFileSync(join(root, "config/muse/auth.json"));
    const prior = getProvider().id;
    const connected = connectMuse();
    assert.equal(connected.model, "muse-spark-1.3-contributor"); assert.equal(connected.ready, true);
    assert.equal(getProvider(connected.id).apiKey, "LLM|fixture|model-api-key");
    assert.equal(getProvider().id, prior); assert.equal(connectMuse().id, connected.id);
    assert.equal(providerConnections().connections.length, 2);
    assert.deepEqual(readFileSync(join(root, "config/muse/auth.json")), original);
    assert.doesNotMatch(readFileSync(join(root, "data/providers.json"), "utf8") + JSON.stringify(providerConnections()) + JSON.stringify(museStatus()), /model-api-key|account-token-never-imported/);
    signIn("LLM|fixture|rotated-key"); assert.equal(getProvider(connected.id).apiKey, "LLM|fixture|rotated-key");
    rmSync(join(root, "config/muse/auth.json")); assert.equal(providerStatus(connected.id).ready, false);
  });

  it("never carries the Muse credential to another endpoint or keeps it after disconnect", () => {
    signIn(); const connected = connectMuse();
    assert.equal(previewProvider({ id: connected.id, baseUrl: "https://other.example/v1" }).apiKey, "");
    setProvider({ id: connected.id, baseUrl: "https://other.example/v1" });
    assert.equal(getProvider(connected.id).apiKey, "");
    assert.throws(() => connectMuse(connected.id), /Meta connection/);
    const next = connectMuse(); setProvider({ id: next.id, clearKey: true });
    assert.equal(getProvider(next.id).apiKey, "");
    assert.equal(museCredential(), "LLM|fixture|model-api-key");
  });

  it("rejects unsafe or mismatched source files and keeps broken connections editable", () => {
    signIn(); const connected = connectMuse();
    signIn("LLM|fixture|private", "https://elsewhere.example/v1");
    assert.throws(museCredential, /no usable/); assert.equal(museStatus().available, false);
    assert.equal(providerConnections().connections.find((p) => p.id === connected.id)?.ready, false);
    rmSync(join(root, "config/muse/auth.json")); symlinkSync(join(root, "config/muse/settings.json"), join(root, "config/muse/auth.json"));
    assert.throws(museCredential, /Invalid Muse Code/);
  });
});
