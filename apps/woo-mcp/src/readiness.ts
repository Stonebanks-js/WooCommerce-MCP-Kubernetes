/**
 * Cached readiness probe. `/readyz` must answer quickly and must not turn
 * every kubelet poll into a WordPress request, so the result of the last probe
 * is reused for `ttlMs` (10 s per docs/contracts.md §12) and concurrent calls
 * share one in-flight probe.
 */

export interface ProbeResult {
  ok: boolean;
  status?: number;
  error?: string;
}

export interface ReadinessState extends ProbeResult {
  checkedAt: string;
  cached: boolean;
}

export interface ReadinessOptions {
  probe: () => Promise<ProbeResult>;
  ttlMs?: number;
  now?: () => number;
}

export interface Readiness {
  check(): Promise<ReadinessState>;
  /** Drop the cached result (tests). */
  reset(): void;
}

export function createReadiness(opts: ReadinessOptions): Readiness {
  const ttl = opts.ttlMs ?? 10_000;
  const now = opts.now ?? Date.now;
  let last: { at: number; result: ProbeResult } | undefined;
  let inflight: Promise<ProbeResult> | undefined;

  async function check(): Promise<ReadinessState> {
    const t = now();
    if (last && t - last.at < ttl) {
      return { ...last.result, checkedAt: new Date(last.at).toISOString(), cached: true };
    }
    if (!inflight) {
      inflight = opts
        .probe()
        .catch((err: unknown): ProbeResult => ({ ok: false, error: err instanceof Error ? err.message : String(err) }))
        .then((result) => {
          last = { at: now(), result };
          return result;
        })
        .finally(() => {
          inflight = undefined;
        });
    }
    const result = await inflight;
    return { ...result, checkedAt: new Date(last?.at ?? t).toISOString(), cached: false };
  }

  return {
    check,
    reset() {
      last = undefined;
    },
  };
}
