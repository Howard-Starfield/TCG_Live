// Small mutation helper for the stickies, channels and tickets tabs: pending flag, safe error text, result note.
import { useCallback, useState } from 'react';
import { describeError } from '../../evidence/api';

export function useAction() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const run = useCallback(async <T,>(action: () => Promise<T>, fallback: string, success?: (result: T) => string | null): Promise<T | undefined> => {
    setPending(true); setError(null); setNote(null);
    try {
      const result = await action();
      setNote(success ? success(result) : null);
      return result;
    } catch (cause) {
      setError(describeError(cause, fallback));
      return undefined;
    } finally { setPending(false); }
  }, []);
  return { pending, error, note, run, clear: () => { setError(null); setNote(null); } };
}
