import { useEffect, useState } from 'react';
import { lineSignature, type SignatureView } from '../../shared/signature';
import { api } from '../api';

/**
 * The official LINE signature of the signed-in person (2026-11-10): asked once when a LINE form opens. Null until it
 * is known, and when the server has no signature settings (older server, or its file cannot be read): the form then
 * starts empty as before.
 */
export function useLineSignature(): string | null {
  const [signature, setSignature] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    api<SignatureView>('GET', '/api/signature', undefined, controller.signal)
      .then((view) => setSignature(lineSignature(view)))
      .catch(() => undefined);
    return () => controller.abort();
  }, []);
  return signature;
}
