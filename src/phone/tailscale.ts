import { execFile } from "node:child_process";
import { InputError } from "../errors.ts";
const publicPort = 45874, target = "http://127.0.0.1:45873";
export type TailscaleRunner = (args: string[]) => Promise<string>;
const run: TailscaleRunner = args => new Promise((resolve, reject) => execFile("tailscale", args, { timeout: 20000, maxBuffer: 1024 * 1024 }, (error, stdout) => error ? reject(new InputError("Tailscale could not configure access. Sign in to Tailscale on this Linux computer and allow Serve for your user.", 503)) : resolve(stdout)));
export async function phoneNetwork(command: TailscaleRunner = run) {
  const status = JSON.parse(await command(["status", "--json"]));
  const name = String(status.Self?.DNSName ?? "").replace(/\.$/, "");
  if (status.BackendState !== "Running" || !/^[a-z0-9.-]+\.ts\.net$/i.test(name)) throw new InputError("Sign in to Tailscale on this computer first", 409);
  const current = JSON.parse(await command(["serve", "status", "--json"]));
  const web = current.Web?.[`${name}:${publicPort}`], tcp = current.TCP?.[publicPort];
  if ((tcp || web) && (tcp?.HTTPS !== true || web?.Handlers?.["/"]?.Proxy !== target || Object.keys(web.Handlers).length !== 1)) throw new InputError("The phone port is already used by another Tailscale service", 409);
  if (current.AllowFunnel?.[`${name}:${publicPort}`]) throw new InputError("This port is public. Disable Funnel before using it for Linubot", 409);
  return { origin: `https://${name}:${publicPort}`, configure: async () => { await command(["serve", "--bg", `--https=${publicPort}`, "--yes", target]); } };
}
