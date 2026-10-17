import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api.js';
import { errorMessage } from '../../lib/errors.js';
import type { AuditEntry, AuditQuery } from '../../types.js';

export interface AuditFilters { outcome: string; source: string; serverId: string; userId: string }
export const EMPTY_FILTERS: AuditFilters = { outcome: '', source: '', serverId: '', userId: '' };

const PAGE = 50;
const REFRESH_MS = 5000;

function toQuery(f: AuditFilters, before?: number): AuditQuery {
  return {
    limit: PAGE,
    before,
    outcome: f.outcome || undefined,
    source: f.source === 'mcp' || f.source === 'chat' ? f.source : undefined,
    serverId: f.serverId || undefined,
    userId: f.userId || undefined,
  };
}

/** First page + "Load more" cursor paging (nextBefore) + optional 5 s polling that prepends new rows. */
export function useAuditFeed(filters: AuditFilters, autoRefresh: boolean) {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const key = JSON.stringify(filters);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.audit.list(toQuery(filters)).then(
      (page) => {
        if (cancelled) return;
        setEntries(page.entries);
        setNextBefore(page.nextBefore ?? null);
        setLoading(false);
      },
      (err: unknown) => {
        if (cancelled) return;
        setError(errorMessage(err));
        setLoading(false);
      },
    );
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` is the serialised filters
  }, [key, tick]);

  useEffect(() => {
    if (!autoRefresh) return;
    let inFlight = false;
    const timer = window.setInterval(async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const page = await api.audit.list(toQuery(filters));
        setEntries((list) => {
          const top = list[0]?.id;
          const fresh = top === undefined ? page.entries : page.entries.filter((e) => e.id > top);
          if (fresh.length === 0) return list;
          return [...fresh, ...list];
        });
        setNextBefore((cursor) => cursor ?? page.nextBefore ?? null);
        setError(null);
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        inFlight = false;
      }
    }, REFRESH_MS);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` is the serialised filters
  }, [key, autoRefresh]);

  const loadMore = useCallback(async () => {
    if (nextBefore === null || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await api.audit.list(toQuery(filters, nextBefore));
      setEntries((list) => {
        const seen = new Set(list.map((e) => e.id));
        return [...list, ...page.entries.filter((e) => !seen.has(e.id))];
      });
      setNextBefore(page.nextBefore ?? null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoadingMore(false);
    }
  }, [filters, nextBefore, loadingMore]);

  const reload = useCallback(() => setTick((n) => n + 1), []);

  return { entries, nextBefore, loading, loadingMore, error, loadMore, reload };
}
