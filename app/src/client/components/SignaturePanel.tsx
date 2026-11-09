import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import { lineSignature, mailSignature, SIGNATURE_LIMITS, type SignatureView } from '../../shared/signature';
import { api, fmtDate, toFailure } from '../api';
import { useLoader } from '../useLoader';
import { LoadStatus } from './LoadStatus';

const SIGNATURE_URL = '/api/signature';

/**
 * The signature the mail and official LINE forms start with (2026-11-10): the committee's shape. Each person sets
 * their title and own address; an access administrator sets the committee's address line and contact address. Both
 * previews follow what is typed. A server without the committee mailbox answers 404: the part leaves the list.
 */
export function SignaturePanel({ onAvailable }: { onAvailable?: (available: boolean) => void }) {
  const load = useCallback(async (signal: AbortSignal) => {
    try {
      return await api<SignatureView>('GET', SIGNATURE_URL, undefined, signal);
    } catch (error) {
      if (toFailure(error).status === 404) return null;
      throw error;
    }
  }, []);
  const loader = useLoader(load);
  const [saved, setSaved] = useState<SignatureView | null>(null);
  const data = saved ?? loader.data;
  const absent = !loader.loading && !loader.error && !data;
  useEffect(() => {
    if (!loader.loading) onAvailable?.(!absent);
  }, [loader.loading, absent, onAvailable]);
  if (absent) return null;

  return (
    <section className="admin signature-settings" aria-labelledby="signature-title" data-testid="signature-settings">
      <h3 id="signature-title">署名</h3>
      <p className="hint">メールと公式LINE の送信画面で、本文の最後に最初から入る署名です。送る前に本文の中で書き換えることもできます。</p>
      <LoadStatus loader={loader} what="署名" compact />
      {data && <SignatureForms view={data} onSaved={setSaved} />}
    </section>
  );
}

function SignatureForms({ view, onSaved }: { view: SignatureView; onSaved: (view: SignatureView) => void }) {
  const id = useId();
  const [title, setTitle] = useState(view.own.title);
  const [personalEmail, setPersonalEmail] = useState(view.own.personalEmail);
  const [address, setAddress] = useState(view.address);
  const [contactEmail, setContactEmail] = useState(view.contactEmail);
  const [busy, setBusy] = useState<'own' | 'committee' | null>(null);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  const parts = { ...view, title: title.trim() || view.defaultTitle, personalEmail: personalEmail.trim(), address: address.trim(), contactEmail: contactEmail.trim() };

  async function save(kind: 'own' | 'committee', e: FormEvent) {
    e.preventDefault();
    setBusy(kind);
    setMessage(null);
    try {
      const next =
        kind === 'own'
          ? await api<SignatureView>('PUT', SIGNATURE_URL, { title, personalEmail })
          : await api<SignatureView>('PUT', `${SIGNATURE_URL}/committee`, { address, contactEmail });
      onSaved(next);
      // The fields show what was kept (trimmed by the server).
      if (kind === 'own') {
        setTitle(next.own.title);
        setPersonalEmail(next.own.personalEmail);
      } else {
        setAddress(next.address);
        setContactEmail(next.contactEmail);
      }
      setMessage({ text: kind === 'own' ? '自分の署名を保存しました。次に開く送信画面から使われます。' : '委員会の行を保存しました。全員の署名に入ります。', error: false });
    } catch (error) {
      setMessage({ text: toFailure(error).message, error: true });
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      {message && (
        <p className={`status ${message.error ? 'error' : 'ok'}`} role={message.error ? 'alert' : 'status'} data-testid="signature-message">
          {message.text}
        </p>
      )}
      <form className="signature-form" onSubmit={(e) => void save('own', e)} aria-label="自分の署名">
        <h4>自分の行</h4>
        <label htmlFor={`${id}-title`}>肩書き</label>
        <input
          id={`${id}-title`}
          type="text"
          value={title}
          maxLength={SIGNATURE_LIMITS.title}
          placeholder={view.defaultTitle || '例：委員長'}
          aria-describedby={`${id}-title-hint`}
          onChange={(e) => setTitle(e.target.value)}
          data-testid="signature-title"
        />
        <p className="hint" id={`${id}-title-hint`}>
          名前の前に入ります（例：委員長、副委員長、内務部）。空欄なら{view.defaultTitle ? `所属の「${view.defaultTitle}」` : '名前だけ'}です。
        </p>
        <label htmlFor={`${id}-email`}>自分のメールアドレス</label>
        <input
          id={`${id}-email`}
          type="email"
          value={personalEmail}
          maxLength={SIGNATURE_LIMITS.email}
          autoComplete="email"
          aria-describedby={`${id}-email-hint`}
          onChange={(e) => setPersonalEmail(e.target.value)}
          data-testid="signature-personal-email"
        />
        <p className="hint" id={`${id}-email-hint`}>
          メールの署名の「委員個人email」の行に入ります。空欄ならその行は出ません。
        </p>
        <div className="actions">
          <button type="submit" disabled={busy !== null} data-testid="signature-save">
            {busy === 'own' ? '保存しています…' : '保存'}
          </button>
          {view.updatedAt && <span className="hint">最後に保存：{fmtDate(view.updatedAt)}</span>}
        </div>
      </form>

      {view.canEditCommittee ? (
        <form className="signature-form" onSubmit={(e) => void save('committee', e)} aria-label="委員会の行">
          <h4>委員会の行（全員の署名に入ります）</h4>
          <label htmlFor={`${id}-address`}>住所の行</label>
          <input
            id={`${id}-address`}
            type="text"
            value={address}
            maxLength={SIGNATURE_LIMITS.address}
            placeholder="〒"
            onChange={(e) => setAddress(e.target.value)}
            data-testid="signature-address"
          />
          <label htmlFor={`${id}-contact`}>団体代表のメールアドレス</label>
          <input
            id={`${id}-contact`}
            type="email"
            value={contactEmail}
            maxLength={SIGNATURE_LIMITS.email}
            aria-describedby={`${id}-contact-hint`}
            onChange={(e) => setContactEmail(e.target.value)}
            data-testid="signature-contact-email"
          />
          <p className="hint" id={`${id}-contact-hint`}>
            「団体代表email」の行に入ります。どちらも空欄ならその行は出ません。
          </p>
          <div className="actions">
            <button type="submit" disabled={busy !== null} data-testid="signature-committee-save">
              {busy === 'committee' ? '保存しています…' : '委員会の行を保存'}
            </button>
            {view.committeeUpdatedAt && <span className="hint">最後に保存：{fmtDate(view.committeeUpdatedAt)}</span>}
          </div>
        </form>
      ) : (
        !view.address &&
        !view.contactEmail && <p className="hint">住所と団体代表のアドレスの行は、権限管理者が設定すると全員の署名に入ります。</p>
      )}

      <h4>見え方</h4>
      <p className="hint">メール</p>
      <pre className="mail-text signature-preview" data-testid="signature-preview-mail">
        {mailSignature(parts)}
      </pre>
      <p className="hint">公式LINE</p>
      <pre className="mail-text signature-preview" data-testid="signature-preview-line">
        {lineSignature(parts)}
      </pre>
    </>
  );
}
