import { decisionNewHref, type DecisionPrefill } from './decisionLinks';
import { useDecisionMeta } from './decisionsApi';

/**
 * 決定として登録: opens the form with the day and the source already in it (mail and LINE screens). Shown only
 * to a committee member while the register is on. The screen it is opened from goes with it, so "やめる" returns there.
 */
export function DecisionRegisterLink({ prefill }: { prefill: DecisionPrefill }) {
  const meta = useDecisionMeta();
  if (!meta?.canRegister) return null;
  return (
    <a className="button secondary" href={decisionNewHref(prefill, window.location.hash)} data-testid="decision-register-link">
      決定として登録
    </a>
  );
}
