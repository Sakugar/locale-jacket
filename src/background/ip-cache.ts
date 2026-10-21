// Server addresses observed by Chrome, per hostname, for IP rules.
//
// Extensions cannot resolve DNS themselves (chrome.dns is not available on desktop
// Chrome), and querying a DNS-over-HTTPS service would send every visited hostname to
// a third party. Instead, the address Chrome actually connected to is taken from
// webRequest (details.ip) and remembered in memory only, never stored.

import { parseIp, type IpAddr } from '../shared/ip.js';

const MAX_ENTRIES = 5000;

export class IpCache {
  private readonly map = new Map<string, IpAddr>();

  set(host: string, ip: string): void {
    const parsed = parseIp(ip);
    if (!parsed) return;
    this.map.delete(host); // keep insertion order = recency
    this.map.set(host, parsed);
    if (this.map.size > MAX_ENTRIES) this.map.delete(this.map.keys().next().value!);
  }

  get(host: string): IpAddr | null {
    return this.map.get(host) ?? null;
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}
