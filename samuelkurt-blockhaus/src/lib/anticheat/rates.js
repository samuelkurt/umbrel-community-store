'use strict';
// Sliding-window counters. Everything lives in memory and is rebuilt from the console as it arrives.
class Rates {
  constructor() { this.m = new Map(); }
  /** Records one event for `key` at time `t` and returns how many fall into the last `windowMs`. */
  hit(key, t, windowMs) {
    let a = this.m.get(key);
    if (!a) { a = []; this.m.set(key, a); }
    a.push(t);
    const from = t - windowMs;
    let i = 0;
    while (i < a.length && a[i] < from) i++;
    if (i) a.splice(0, i);
    if (a.length > 500) a.splice(0, a.length - 500);
    return a.length;
  }
  count(key, t, windowMs) {
    const a = this.m.get(key);
    return a ? a.filter((x) => x >= t - windowMs).length : 0;
  }
  gc(t, maxAgeMs) {
    for (const [k, a] of this.m) if (!a.length || a[a.length - 1] < t - maxAgeMs) this.m.delete(k);
  }
}
const isPrivateIp = (ip) => /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1$|fe80:|f[cd][0-9a-f]{2}:|localhost$)/i.test(String(ip || ''));
module.exports = { Rates, isPrivateIp };
