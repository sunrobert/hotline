// Checks a public HTTPS address without trusting the Mac's DNS cache. A brand-new or recently
// dead quick-tunnel hostname can be cached as "no such host" for minutes, so this resolves
// through Cloudflare's resolver and connects to that address directly.

import { Resolver } from "node:dns/promises";
import { get } from "node:https";
import type { LookupFunction } from "node:net";

export async function publicHealthy(publicUrl: string): Promise<boolean> {
  const host = new URL(publicUrl).hostname;
  const resolver = new Resolver();
  resolver.setServers(["1.1.1.1", "1.0.0.1"]);
  let ip: string | undefined;
  try { ip = (await resolver.resolve4(host))[0]; } catch { return false; }
  if (!ip) return false;
  const address = ip;
  return new Promise((resolve) => {
    const req = get(`${publicUrl.replace(/\/+$/, "")}/health`, {
      timeout: 8000,
      lookup: ((_host, opts, cb) =>
        opts.all ? cb(null, [{ address, family: 4 }]) : cb(null, address, 4)) as LookupFunction,
    }, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.on("error", () => resolve(false));
  });
}
