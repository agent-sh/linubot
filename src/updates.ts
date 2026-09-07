import { readFileSync } from "node:fs";
import { fetchPublicJson } from "./network/http.ts";
import { InputError } from "./errors.ts";

export interface ReleaseUpdate { version: string; url: string; assetUrl: string }
const REPOSITORY = "https://github.com/agent-sh/linubot";
export const appVersion: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
export function newerVersion(candidate: string, installed: string): boolean {
  if (![candidate, installed].every((v) => /^\d+\.\d+\.\d+$/.test(v))) return false;
  const a = candidate.split(".").map(Number), b = installed.split(".").map(Number);
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
export function parseRelease(value: unknown, installed: string, arch = process.arch): ReleaseUpdate | undefined {
  if (!value || typeof value !== "object") return;
  const release = value as { draft?: boolean; prerelease?: boolean; tag_name?: unknown; html_url?: unknown; assets?: { name?: string; browser_download_url?: string }[] };
  if (release.draft || release.prerelease || typeof release.tag_name !== "string" || !/^v\d+\.\d+\.\d+$/.test(release.tag_name)) return;
  const version = release.tag_name.slice(1), url = `${REPOSITORY}/releases/tag/v${version}`;
  if (!newerVersion(version, installed) || release.html_url !== url || !Array.isArray(release.assets)) return;
  const name = `linubot-${version}-${arch}.tar.gz`, assetUrl = `${REPOSITORY}/releases/download/v${version}/${name}`;
  if (!release.assets.some((asset) => asset?.name === name && asset.browser_download_url === assetUrl) || !release.assets.some((asset) => asset?.name === "SHA256SUMS" && asset.browser_download_url === `${REPOSITORY}/releases/download/v${version}/SHA256SUMS`)) return;
  return { version, url, assetUrl };
}
export function createUpdates(options: { version?: string; check?: () => Promise<unknown>; install?: (release: ReleaseUpdate) => Promise<void> } = {}) {
  const version = options.version || appVersion;
  let latest: ReleaseUpdate | undefined, checkedAt = 0, error: string | undefined, checking: Promise<void> | undefined, installing = false;
  const status = () => ({ currentVersion: version, latest, checkedAt, error, installing, canInstall: Boolean(options.install) });
  async function check(force = false) {
    if (checking) { await checking; return status(); }
    if (checkedAt && Date.now() - checkedAt < (force ? 60000 : 6 * 3600000)) return status();
    checking = (async () => {
      try { latest = parseRelease(await (options.check ? options.check() : fetchPublicJson("https://api.github.com/repos/agent-sh/linubot/releases/latest")), version); error = undefined; }
      catch { error = "Could not check GitHub releases. Try again later."; }
      finally { checkedAt = Date.now(); }
    })();
    try { await checking; } finally { checking = undefined; }
    return status();
  }
  return { status, check, async install() {
    if (!options.install) throw new InputError("Open the release to update this installation", 409);
    if (!latest) throw new InputError("No newer release is available", 409);
    if (installing) throw new InputError("An update is already being installed", 409);
    installing = true;
    try { await options.install(latest); } finally { installing = false; }
    return status();
  } };
}
export type Updates = ReturnType<typeof createUpdates>;
