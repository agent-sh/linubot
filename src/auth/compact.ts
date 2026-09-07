import { authenticatedProvider, providerBase, providerHeaders, providerIdentity, readProviderJson, responsesMessages, validateProviderItems } from "./providers.ts";
import type { ChatMessage, ProviderConfig, ProviderItems } from "./providers.ts";
import { InputError } from "../errors.ts";

export function nativeCompactionAvailable(provider: ProviderConfig): boolean {
  return ["responses", "xai-oauth"].includes(provider.kind) && ["https://api.openai.com/v1", "https://api.x.ai/v1"].includes(providerBase(provider.kind, provider.baseUrl));
}

export async function compactResponse(provider: ProviderConfig, messages: ChatMessage[], signal?: AbortSignal, request: typeof fetch = fetch): Promise<{ context: ProviderItems; usage: { input: number; output: number } }> {
  provider = await authenticatedProvider(provider, signal);
  if (!["responses", "xai-oauth"].includes(provider.kind)) throw new InputError("Native compaction requires a Responses endpoint");
  const identity = providerIdentity(provider);
  validateProviderItems(provider, messages);
  const response = await request(`${providerBase(provider.kind, provider.baseUrl)}/responses/compact`, { method: "POST", redirect: "error",
    signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(180000)]), headers: { "Content-Type": "application/json", ...providerHeaders(provider) }, body: JSON.stringify({ model: provider.model, input: responsesMessages(messages) }) });
  if (!response.ok) { await response.body?.cancel(); throw new InputError(`Native compaction returned HTTP ${response.status}`, 502); }
  const data = await readProviderJson(response) as { output?: unknown[]; usage?: { input_tokens?: number; output_tokens?: number } };
  if (!Array.isArray(data?.output) || data.output.length > 2000 || !data.output.some((value) => value && typeof value === "object" && (value as Record<string, unknown>).type === "compaction" && typeof (value as Record<string, unknown>).encrypted_content === "string" && (value as Record<string, string>).encrypted_content.length > 0)) throw new Error("Native compaction did not return a valid opaque checkpoint");
  const input = data.usage?.input_tokens, output = data.usage?.output_tokens;
  if (!Number.isSafeInteger(input) || !Number.isSafeInteger(output) || input! <= 0 || output! < 0) throw new Error("Native compaction did not report valid token usage");
  const retained = data.output.filter((value) => (value as Record<string, unknown>)?.type !== "compaction");
  // Count returned plaintext items; opaque bytes are not model tokens.
  const tokens = output! + Math.ceil(JSON.stringify(retained).length / 3);
  if (tokens >= input!) throw new Error("Native compaction did not reduce the working context");
  const context = { identity, items: data.output, tokens, compacted: true };
  validateProviderItems(provider, [{ role: "assistant", content: "", providerItems: context }]);
  return { context, usage: { input: input!, output: output! } };
}
