import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { errorMessage } from './errors.js';

export interface AsyncState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
  setData: Dispatch<SetStateAction<T | null>>;
}

/**
 * Runs an async loader on mount and whenever the cache key changes (or reload() is called). Stale
 * results from a superseded run are dropped so a slow earlier request never overwrites a newer one.
 */
export function useAsync<T>(load: () => Promise<T>, key: string): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  const loadRef = useRef(load);
  useEffect(() => { loadRef.current = load; });

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    loadRef.current().then(
      (result) => {
        if (cancelled) return;
        setData(result);
        setLoading(false);
      },
      (err: unknown) => {
        if (cancelled) return;
        setError(errorMessage(err));
        setLoading(false);
      },
    );
    return () => { cancelled = true; };
  }, [tick, key]);

  return { data, error, loading, reload, setData };
}
