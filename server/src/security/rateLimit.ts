/**
 * Klizni prozor u memoriji (po instanci). Za više instanci zameniti Redis-om — interfejs ostaje isti.
 */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(private limit: number, private windowMs: number, private now: () => number = Date.now) {}

  /** Vraća koliko sekundi treba čekati; 0 znači da je zahtev dozvoljen (i zabeležen). */
  take(key: string): number {
    const t = this.now();
    const list = (this.hits.get(key) || []).filter(x => t - x < this.windowMs);
    if (list.length >= this.limit) {
      this.hits.set(key, list);
      return Math.ceil((list[0] + this.windowMs - t) / 1000);
    }
    list.push(t);
    this.hits.set(key, list);
    if (this.hits.size > 50_000) this.gc(t);
    return 0;
  }
  reset(key: string) { this.hits.delete(key); }
  private gc(t: number) { for (const [k, v] of this.hits) if (!v.some(x => t - x < this.windowMs)) this.hits.delete(k); }
}

/** Zaključavanje naloga posle uzastopnih neuspeha: 5 → 15 min, pa se trajanje udvostručuje (max 24h). */
export function lockoutMinutes(failedLogins: number): number {
  if (failedLogins < 5) return 0;
  return Math.min(15 * 2 ** (failedLogins - 5), 24 * 60);
}
