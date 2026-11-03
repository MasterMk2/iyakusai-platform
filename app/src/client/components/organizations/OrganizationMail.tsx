import { useEffect, useState } from 'react';
import type { OrgMailBatch, OrgMeta, OrgTemplateView } from '../../../shared/organizations';
import { api, apiForm, toFailure } from '../../api';

// The batch mail (一斉送信・差し込み) to the checked organizations, in four steps: 作成 (the text with placeholders),
// 下見と確認 (each message, why one is held back, the shared attachments, the count and the From address), 送信 (a
// few messages per request, shown as progress), 結果 (what was sent, what was not, and 再送). One message goes to one
// address; the screen never sends a message twice. A batch that was started and not finished can be continued from
// the list (resumeBatchId).

type Step = 'loading' | 'compose' | 'review' | 'sending' | 'result';

/** A token for one draft (the server keeps it so the same draft is answered from its first creation). */
function newToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

const STATUS_TEXT: Record<string, string> = { pending: '送る', sending: '送っています', sent: '送った', failed: '送れなかった', unknown: '届いたか未確認（再送しない）', skipped: '送らない' };

function sizeText(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function OrganizationMail({
  meta,
  ids: initialIds,
  names: initialNames,
  resumeBatchId,
  onSent,
  onClose,
}: {
  meta: OrgMeta;
  ids: string[];
  names: Record<string, string>;
  /** A batch started earlier and not finished: the screen opens it (the list on the organizations screen offers it). */
  resumeBatchId?: string;
  /** Called after a sending request with the number of messages it sent (the screen clears its selection then). */
  onSent: (sent: number) => void;
  onClose: () => void;
}) {
  // The organizations are taken once: the list's selection may change while this screen stays open.
  const [ids] = useState(initialIds);
  const [names] = useState(initialNames);
  const [step, setStep] = useState<Step>(resumeBatchId ? 'loading' : 'compose');
  const [mailboxId, setMailboxId] = useState(meta.mail.from[0]?.mailboxId ?? '');
  const [templates, setTemplates] = useState<OrgTemplateView[]>([]);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [templateName, setTemplateName] = useState('');
  const [batch, setBatch] = useState<OrgMailBatch | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    api<OrgTemplateView[]>('GET', '/api/organizations/templates', undefined, controller.signal)
      .then(setTemplates)
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setNotice(`テンプレートを読めませんでした（${toFailure(err).message}）。文面は直接入れられます。`);
      });
    return () => controller.abort();
  }, []);

  // A batch to continue: opened as it stands (a finished one shows its result).
  useEffect(() => {
    if (!resumeBatchId) return;
    const controller = new AbortController();
    api<OrgMailBatch>('GET', `/api/organizations/mail/batches/${encodeURIComponent(resumeBatchId)}`, undefined, controller.signal)
      .then((b) => {
        setBatch(b);
        setStep(b.status === 'draft' ? 'review' : 'result');
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setError(`一斉送信を開けませんでした（${toFailure(err).message}）。一覧から開き直してください。`);
      });
    return () => controller.abort();
  }, [resumeBatchId]);

  const chosen = ids.map((id) => names[id] ?? id);

  const saveTemplate = async () => {
    setError(null);
    try {
      const made = await api<OrgTemplateView>('POST', '/api/organizations/templates', { name: templateName, subject, body });
      setTemplates((list) => [...list, made].sort((a, b) => a.name.localeCompare(b.name, 'ja')));
      setTemplateName('');
      setNotice(`テンプレート「${made.name}」を保存しました。`);
    } catch (err) {
      setError(toFailure(err).message);
    }
  };

  const pickTemplate = (id: string) => {
    const t = templates.find((x) => x.id === id);
    if (!t) return;
    // A text already written is not replaced without a word (the screen keeps what the person typed).
    if ((subject.trim() || body.trim()) && !window.confirm('今の件名と本文を、選んだテンプレートの文面に置き換えます。よろしいですか？')) return;
    setSubject(t.subject);
    setBody(t.body);
  };

  const makeDraft = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      // A new token for every draft: the text may have changed since the last one.
      const made = await api<OrgMailBatch>('POST', '/api/organizations/mail/batches', { clientToken: newToken(), mailboxId, templateId: null, subject, body, organizationIds: ids });
      setBatch(made);
      setStep('review');
    } catch (err) {
      setError(toFailure(err).message);
    } finally {
      setBusy(false);
    }
  };

  /** Adds files to the draft (shared by every message). The limits of the sending setting are checked first. */
  const addFiles = async (files: FileList | null) => {
    if (!batch || !files || files.length === 0) return;
    const list = Array.from(files);
    const count = batch.attachments.length + list.length;
    const bytes = batch.attachments.reduce((n, a) => n + a.size, 0) + list.reduce((n, f) => n + f.size, 0);
    if (count > meta.limits.attachments) {
      setAttachmentError(`添付は合わせて ${meta.limits.attachments} 個までです。`);
      return;
    }
    if (bytes > meta.limits.attachmentBytes) {
      setAttachmentError(`添付は合わせて ${Math.floor(meta.limits.attachmentBytes / 1024 / 1024)} MB までです。`);
      return;
    }
    const form = new FormData();
    for (const f of list) form.append('attachments', f, f.name);
    setBusy(true);
    setAttachmentError(null);
    try {
      setBatch(await apiForm<OrgMailBatch>(`/api/organizations/mail/batches/${encodeURIComponent(batch.id)}/attachments`, form));
    } catch (err) {
      setAttachmentError(`添付を追加できませんでした（${toFailure(err).message}）。`);
    } finally {
      setBusy(false);
    }
  };

  const removeFile = async (index: number) => {
    if (!batch || busy) return;
    setBusy(true);
    setAttachmentError(null);
    try {
      setBatch(await api<OrgMailBatch>('DELETE', `/api/organizations/mail/batches/${encodeURIComponent(batch.id)}/attachments/${index}`));
    } catch (err) {
      setAttachmentError(`添付を外せませんでした（${toFailure(err).message}）。`);
    } finally {
      setBusy(false);
    }
  };

  /**
   * Sends: the screen repeats the request (five messages each) until nothing is pending, or the hourly limit stops it.
   * A retry walks the batch forward (afterIndex), so each failed message is tried once in this retry.
   */
  const send = async (retry: boolean) => {
    if (!batch || busy) return;
    if (!retry && !window.confirm(`${batch.counts.pending} 件を ${batch.mailboxAddress} から送ります。送った後は取り消せません。${batch.attachments.length > 0 ? `添付 ${batch.attachments.length} 個も付きます。` : ''}送りますか？`)) return;
    const sentBefore = batch.counts.sent;
    setBusy(true);
    setError(null);
    setNotice(null);
    setStep('sending');
    let last: OrgMailBatch = batch;
    try {
      let cursor = -1;
      for (let i = 0; i < 200; i += 1) {
        const answer = await api<{ batch: OrgMailBatch; stopped: boolean; lastIndex: number | null }>(
          'POST',
          `/api/organizations/mail/batches/${encodeURIComponent(batch.id)}/send`,
          retry ? { includeFailed: true, afterIndex: cursor } : { includeFailed: false },
        );
        last = answer.batch;
        setBatch(answer.batch);
        if (answer.stopped) break;
        if (retry) {
          if (answer.lastIndex === null) break;
          cursor = answer.lastIndex;
        } else if (answer.batch.counts.pending === 0) {
          break;
        }
      }
    } catch (err) {
      setError(`送信を続けられませんでした（${toFailure(err).message}）。届いたかは下の結果で確かめてください。`);
    } finally {
      setBusy(false);
      setStep('result');
      onSent(Math.max(0, last.counts.sent - sentBefore));
    }
  };

  if (step === 'loading') {
    return (
      <div className="orgs-form">
        {error ? (
          <p className="status error" role="alert">
            {error}
          </p>
        ) : (
          <p className="status loading" role="status">
            読み込み中…
          </p>
        )}
        <div className="actions">
          <button type="button" className="secondary" onClick={onClose}>
            一覧に戻る
          </button>
        </div>
      </div>
    );
  }

  if (step === 'compose') {
    if (ids.length === 0) {
      return (
        <div className="orgs-form">
          <p className="status warning">一斉送信する団体が選ばれていません。一覧で選び直してください。</p>
          <button type="button" onClick={onClose}>
            一覧に戻る
          </button>
        </div>
      );
    }
    const missing = !mailboxId ? '送信元の受信箱を選んでください。' : !subject.trim() ? '件名を入れてください。' : !body.trim() ? '本文を入れてください。' : null;
    return (
      <div className="orgs-form" aria-label="一斉送信の作成">
        <div className="pane-head">
          <div className="pane-title">
            <h2>団体へ一斉送信</h2>
            <span className="pane-sub">
              {ids.length} 団体（上限 {meta.limits.batch} 団体）
            </span>
          </div>
        </div>
        <p className="hint">選んだ団体: {chosen.join('、')}</p>
        {error && (
          <p className="status error" role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className="status info" role="status">
            {notice}
          </p>
        )}
        <div className="form-grid">
          <label>
            送信元の受信箱（送れるのは権限のある受信箱だけ）
            <select value={mailboxId} onChange={(e) => setMailboxId(e.target.value)}>
              {meta.mail.from.map((m) => (
                <option key={m.mailboxId} value={m.mailboxId}>
                  {m.name}（{m.address}）
                </option>
              ))}
            </select>
          </label>
          <label>
            テンプレートを使う
            <select value="" onChange={(e) => pickTemplate(e.target.value)}>
              <option value="">選んでください</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field-wide">
            件名
            <input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} placeholder="例: {団体名} 様 協賛のご案内" />
          </label>
          <label className="field-wide">
            本文
            <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={10} maxLength={meta.limits.templateBody} placeholder={'例:\n{担当者名} 様\n\nいつもお世話になっております。{団体名} のご担当者様へ……'} />
          </label>
        </div>
        <p className="hint">
          差し込めるもの: {meta.placeholders.map((p) => `{${p}}`).join(' ')}。団体の内容が空の差し込みがある団体は送らず、下見に理由を出します。宛先は、団体の相手の担当者の連絡先のメールアドレスです。
        </p>
        <div className="actions">
          <button type="button" disabled={busy || missing !== null} onClick={() => void makeDraft()} data-testid="org-mail-draft">
            {busy ? '下見を作っています…' : '下見を作る（まだ送りません）'}
          </button>
          <button type="button" className="secondary" onClick={onClose}>
            やめる
          </button>
        </div>
        {missing && <p className="hint">{missing}（入れると「下見を作る」が押せます）</p>}
        <details>
          <summary>この文面をテンプレートとして保存する（一斉送信の画面だけで使えます）</summary>
          <div className="orgs-form">
            <label>
              テンプレート名
              <input value={templateName} onChange={(e) => setTemplateName(e.target.value)} maxLength={40} />
            </label>
            <div className="actions">
              <button type="button" className="secondary" disabled={!templateName.trim() || !subject.trim() || !body.trim()} onClick={() => void saveTemplate()}>
                テンプレートに保存
              </button>
            </div>
            {(!templateName.trim() || !subject.trim() || !body.trim()) && <p className="hint">テンプレート名と件名・本文を入れると保存できます。</p>}
          </div>
        </details>
      </div>
    );
  }

  if (step === 'review' && batch) {
    const sendable = batch.counts.pending;
    return (
      <div className="orgs-form" aria-label="一斉送信の下見と確認">
        <div className="pane-head">
          <div className="pane-title">
            <h2>下見と確認</h2>
          </div>
        </div>
        <p className="status info" role="status">
          {sendable} 件を {batch.mailboxAddress} から、1 通ずつ別々に送ります。送らないのは {batch.counts.skipped} 件です。
        </p>
        <p className="hint">件名（差し込み前）: {batch.subject}</p>
        {error && (
          <p className="status error" role="alert">
            {error}
          </p>
        )}
        <section aria-labelledby="org-mail-files" className="orgs-form">
          <h3 id="org-mail-files">共通の添付（全員に同じファイルを付けます）</h3>
          {batch.attachments.length === 0 ? (
            <p className="hint">付けるファイルはありません。</p>
          ) : (
            <ul className="orgs-mail-list" aria-label="添付ファイル">
              {batch.attachments.map((a) => (
                <li key={a.index} className="orgs-attach-item">
                  <span>
                    {a.filename}（{sizeText(a.size)}）
                  </span>
                  <button type="button" className="secondary" disabled={busy} onClick={() => void removeFile(a.index)}>
                    外す
                    <span className="sr-only">（{a.filename}）</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <label>
            ファイルを追加
            <input
              type="file"
              multiple
              disabled={busy}
              onChange={(e) => {
                void addFiles(e.target.files);
                e.target.value = '';
              }}
            />
          </label>
          <p className="hint">
            1 通に付くのは合わせて {meta.limits.attachments} 個・{Math.floor(meta.limits.attachmentBytes / 1024 / 1024)} MB までです。ファイルは送るまでこの下見に保存され、送信中は変えられません。
          </p>
          {attachmentError && (
            <p className="status error" role="alert">
              {attachmentError}
            </p>
          )}
        </section>
        <ul className="orgs-mail-list" aria-label="下見の一覧">
          {batch.items.map((item) => (
            <li key={item.index} className="orgs-batch-item">
              <span>
                <strong>{item.orgName}</strong> · {STATUS_TEXT[item.status] ?? item.status}
              </span>
              {item.skipReason && <span className="status warning">{item.skipReason}</span>}
              {item.warning && <span className="status info">{item.warning}</span>}
              <span className="hint">宛先: {item.toAddress || '（なし）'}</span>
              <details>
                <summary>文面を見る</summary>
                <p>件名: {item.subject}</p>
                <pre>{item.body}</pre>
              </details>
            </li>
          ))}
        </ul>
        {sendable === 0 ? (
          <p className="status warning" role="status">
            送れる宛先がありません。団体の相手の担当者のメールや、差し込みの内容を直してから、もう一度作ってください。
          </p>
        ) : (
          <div className="actions">
            <button type="button" onClick={() => void send(false)} disabled={busy} data-testid="org-mail-send">
              {sendable} 件を送る
            </button>
            <button type="button" className="secondary" onClick={() => setStep('compose')} disabled={busy}>
              文面を直す
            </button>
          </div>
        )}
      </div>
    );
  }

  if (step === 'sending' && batch) {
    const total = batch.counts.pending + batch.counts.sending + batch.counts.sent + batch.counts.failed + batch.counts.unknown;
    const done = batch.counts.sent + batch.counts.failed + batch.counts.unknown;
    return (
      <div className="orgs-form" aria-label="送信の進み具合">
        <p className="status loading" role="status">
          送っています… {done} / {total} 件
        </p>
        <div className="orgs-progress" aria-hidden="true">
          <span style={{ width: `${total === 0 ? 100 : Math.round((done / total) * 100)}%` }} />
        </div>
        <p className="hint">送っている間は、この画面を閉じないでください。</p>
      </div>
    );
  }

  if (step === 'result' && batch) {
    const c = batch.counts;
    const failed = batch.items.filter((i) => i.status === 'failed' || i.status === 'unknown');
    const sentNames = batch.items.filter((i) => i.status === 'sent').map((i) => i.orgName);
    const trouble = c.failed + c.unknown > 0;
    return (
      <div className="orgs-form" aria-label="送信の結果">
        <div className="pane-head">
          <div className="pane-title">
            <h2>送信の結果</h2>
          </div>
        </div>
        <p className={`status ${trouble ? 'warning' : 'ok'}`} role="status">
          送った {c.sent} 件 · 送れなかった {c.failed} 件 · 届いたか未確認 {c.unknown} 件 · 残り {c.pending} 件 · 送らなかった {c.skipped} 件
        </p>
        {sentNames.length > 0 && <p className="hint">送った団体: {sentNames.join('、')}</p>}
        {batch.notice && (
          <p className="status warning" role="status">
            {batch.notice}
          </p>
        )}
        {error && (
          <p className="status error" role="alert">
            {error}
          </p>
        )}
        {failed.length > 0 && (
          <ul className="orgs-mail-list" aria-label="送れなかった宛先">
            {failed.map((item) => (
              <li key={item.index} className="orgs-batch-item">
                <span>
                  <strong>{item.orgName}</strong> · {item.toAddress} · {STATUS_TEXT[item.status]}
                </span>
                {item.error && <span className="hint">{item.error}</span>}
              </li>
            ))}
          </ul>
        )}
        <div className="actions">
          {c.failed > 0 && (
            <button type="button" className="secondary" disabled={busy} onClick={() => void send(true)} data-testid="org-mail-retry">
              送れなかった {c.failed} 件を再送する
            </button>
          )}
          {c.pending > 0 && (
            <button type="button" disabled={busy} onClick={() => void send(false)}>
              続きを送る（残り {c.pending} 件）
            </button>
          )}
          <button type="button" className="secondary" onClick={onClose}>
            閉じる
          </button>
        </div>
        <p className="hint">
          送った内容は、各団体の履歴に「一斉送信」として残ります。再送は、送れなかった宛先にだけ行い、届いたか分からない宛先は再送しません。途中で閉じても、一覧の「送りかけの一斉送信」から続きを送れます。
        </p>
      </div>
    );
  }

  return null;
}
