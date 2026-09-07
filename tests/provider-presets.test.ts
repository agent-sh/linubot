import { it } from "node:test";
import assert from "node:assert/strict";
import { listProviderModels, providerPresets } from "../src/auth/catalog.ts";
import { previewProvider } from "../src/auth/store.ts";

it("features Tiyuvta first with a public catalog", () => {
  assert.deepEqual(providerPresets[0], { id: "tiyuvta", name: "Tiyuvta", kind: "openai-compat", baseUrl: "https://api.tiyuvta.ai/v1", auth: "bearer", featured: true, publicCatalog: true });
});

it("loads the Tiyuvta public catalog from a new bearer connection without a key", async () => {
  const draft = previewProvider({ ...providerPresets[0], newConnection: true, model: "" });
  assert.equal(draft.apiKey, "");
  let requests = 0;
  const catalog = await listProviderModels(draft, undefined, async (url, init) => {
    requests++;
    assert.equal(url, "https://api.tiyuvta.ai/v1/models");
    assert.equal(init?.method, "GET");
    assert.equal(new Headers(init?.headers).has("authorization"), false);
    return new Response(JSON.stringify({ data: [{ id: "fixture-model", name: "Fixture model" }] }), { headers: { "content-type": "application/json" } });
  });
  assert.equal(requests, 1);
  assert.equal(catalog.supported, true);
  assert.deepEqual(catalog.models, [{ id: "fixture-model", name: "Fixture model" }]);
});
