import { useEffect, useRef, useState, type FormEvent } from 'react';
import { cleanText, type AssistantJob, type AssistantMeta } from '../../../shared/assistant';
import { composeMailRequest, MAIL_LIMITS, MAIL_RELATIONS, splitMailDraft, type MailRelation } from '../../../shared/mailDraft';
import { api, toFailure, type ApiFailure } from '../../api';
import type { BotReplyRequest, MailBotLink } from '../../../shared/mailHandoff';
import { BotText } from './BotText';
import type { BotSection } from './BotView';
import { ErrorLine, FeatureOff, operationFor, type OperationSlots, settleOperation } from './common';
import { JobPanel } from './JobPanel';
import { RecentJobs } from './RecentJobs';
import { useJobPoll } from './useJobPoll';

const MODEL_FALLBACK = { id: 'auto', label: '自動', ask: true, doc: true };
const isMailJob = (job: AssistantJob) => job.kind === 'doc' && job.input.docType === 'mail';

type Field = 'to' | 'purpose' | 'received';

/**
 * The mail screen (the Bot's /mail): who it is for and what it is about, optionally the mail being answered
 * and the sender; the Bot returns a subject and a body to copy into the committee's mail. It is sent as a
 * /doc job (docType mail, txt) with the labelled request of shared/mailDraft.ts. The inputs stay after
 * sending so a draft can be made again with a changed purpose; 新しく作る clears them.
 */
export function MailView({ meta, jobId, onNavigate, mail }: { meta: AssistantMeta; jobId: string | null; onNavigate: (section: BotSection, jobId?: string | null) => void; mail?: MailBotLink }) {
  // A message from the mailbox to answer fills the form when the screen opens (the app then forgets it).
  const [initialRequest] = useState<BotReplyRequest | null>(() => mail?.request ?? null);
  const [to, setTo] = useState(initialRequest?.to ?? '');
  const [purpose, setPurpose] = useState('');
  const [received, setReceived] = useState(initialRequest?.received ?? '');
  const [sender, setSender] = useState('');
  const [relation, setRelation] = useState<'' | MailRelation>('');
  const [useSources, setUseSources] = useState(true);
  const [model, setModel] = useState('auto');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<ApiFailure | null>(null);
  const [formMessage, setFormMessage] = useState<{ field: Field; text: string } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // The job this screen just sent or opened from the list: its panel is brought into view once.
  const [opened, setOpened] = useState<string | null>(null);
  const operation = useRef<OperationSlots>({});
  const result = useRef<HTMLDivElement>(null);
  const toField = useRef<HTMLInputElement>(null);
  const purposeField = useRef<HTMLTextAreaElement>(null);
  const receivedField = useRef<HTMLTextAreaElement>(null);
  const details = useRef<HTMLDetailsElement>(null);
  const poll = useJobPoll(jobId);
  // The message being answered, and the drafts made for one (job → that message).
  const [replyTarget, setReplyTarget] = useState<BotReplyRequest | null>(initialRequest);
  const [replyJobs, setReplyJobs] = useState<Record<string, BotReplyRequest>>({});
  const onRequestUsed = mail?.onRequestUsed;
  useEffect(() => {
    if (!initialRequest) return;
    onRequestUsed?.();
    // The text sits under 詳細: open it, and start at the purpose (the one field left to write).
    if (details.current) details.current.open = true;
    purposeField.current?.focus();
  }, [initialRequest, onRequestUsed]);
  const draftAction = (job: AssistantJob) =>
    mail?.canSend
      ? (draft: { subject: string; body: string }) => {
          const target = replyJobs[job.id];
          mail.onUseDraft({ reply: target ? { receiptId: target.receiptId, threadId: target.threadId } : null, subject: draft.subject, body: draft.body });
        }
      : undefined;

  const enabled = meta.features.doc;
  const docModels = meta.models.filter((m) => m.doc);
  const share = meta.shareChannel ? `作った草案は Discord の #${meta.shareChannel.name} にも投稿されます。` : null;

  // The answer appears above the form: move there (on a phone it would be out of sight).
  useEffect(() => {
    if (!jobId || opened !== jobId) return;
    result.current?.scrollIntoView({ block: 'start' });
    result.current?.focus({ preventScroll: true });
  }, [jobId, opened]);

  const open = (id: string) => {
    setOpened(id);
    onNavigate('mail', id);
  };

  function refuse(field: Field, text: string) {
    setFormMessage({ field, text });
    // The mail being answered sits under 詳細: open it so the reason and the field can be seen.
    if (field === 'received' && details.current) details.current.open = true;
    ({ to: toField, purpose: purposeField, received: receivedField })[field].current?.focus();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const toText = cleanText(to);
    const purposeText = cleanText(purpose);
    const receivedText = cleanText(received);
    if (!toText) return refuse('to', '相手を入力してください。');
    if (!purposeText) return refuse('purpose', '要件を入力してください。');
    if (purposeText.length > MAIL_LIMITS.purposeMax) return refuse('purpose', `要件は ${MAIL_LIMITS.purposeMax} 字までです。短くしてから送ってください。`);
    if (receivedText.length > MAIL_LIMITS.receivedMax) {
      return refuse('received', `返信先のメール本文は ${MAIL_LIMITS.receivedMax} 字までです。質問や依頼の部分だけを残してください。`);
    }
    setFormMessage(null);
    setSubmitError(null);
    const content = composeMailRequest({ to: toText, purpose: purposeText, sender, relation: relation || null, received: receivedText });
    const input = { docType: 'mail', content, format: 'txt', useSources, model };
    const clientOperationId = operationFor(operation.current, 'submit', JSON.stringify({ kind: 'doc', input }));
    setSubmitting(true);
    try {
      const answer = await api<{ job: AssistantJob }>('POST', '/api/assistant/jobs', { clientOperationId, kind: 'doc', input });
      operation.current.submit = null;
      setReloadKey((n) => n + 1);
      // A draft asked for from a mailbox message is sent as a reply to it (only while the text is the one put in).
      const target = replyTarget && cleanText(replyTarget.received) === receivedText ? replyTarget : null;
      if (target) setReplyJobs((m) => ({ ...m, [answer.job.id]: target }));
      open(answer.job.id);
    } catch (err) {
      settleOperation(operation.current, 'submit', err);
      setSubmitError(toFailure(err));
    } finally {
      setSubmitting(false);
    }
  }

  function startOver() {
    setTo('');
    setPurpose('');
    setReceived('');
    setSender('');
    setRelation('');
    setFormMessage(null);
    setSubmitError(null);
    setReplyTarget(null);
    setOpened(null);
    onNavigate('mail', null);
    window.setTimeout(() => toField.current?.focus(), 0);
  }

  const errorId = (field: Field) => `mail-${field}-error`;
  const invalid = (field: Field) => (formMessage?.field === field ? true : undefined);
  const describedBy = (field: Field, hint: string) => (formMessage?.field === field ? `${hint} ${errorId(field)}` : hint);
  const message = (field: Field) =>
    formMessage?.field === field ? (
      <p className="status error" role="alert" id={errorId(field)}>
        {formMessage.text}
      </p>
    ) : null;

  return (
    <div className="bot-mail">
      {jobId && (
        <div className="bot-open" ref={result} tabIndex={-1} role="region" aria-label="メールの草案" data-testid="mail-result">
          <JobPanel
            job={poll.job}
            loading={poll.loading}
            error={poll.error}
            title="メールの草案"
            shareNote={share}
            onRetry={poll.reload}
            renderResult={(job) => (
              <MailDraftView key={job.id} text={job.result?.text ?? ''} bcc={meta.mailBcc ?? null} onUse={draftAction(job)} reply={!!replyJobs[job.id]} />
            )}
          />
          <button type="button" className="secondary" onClick={startOver} data-testid="mail-new">
            新しく作る
          </button>
        </div>
      )}
      <section className="panel" aria-labelledby="mail-form-title">
        <h2 id="mail-form-title">メールの草案を作る</h2>
        <p className="hint">
          相手と要件を書くと、Bot が件名と本文の草案を作ります。メールの送信はしません。
          {mail?.canSend && 'できた草案は、「メール」の送信欄に入れて送れます。'}
        </p>
        {replyTarget && (
          <div className="status info mail-reply-target" data-testid="mail-reply-target">
            <p>
              「メール」の「{replyTarget.subject}」への返信の草案を作ります。届いたメールの本文を「返信先のメール本文」に入れました
              {replyTarget.cut ? `（長いので最初の ${MAIL_LIMITS.receivedMax} 字だけです。質問や依頼の部分が入っているか確かめてください）` : ''}。
              「草案を作る」を押すと、この本文が Bot（AI）に渡ります。
            </p>
            <button type="button" className="quiet" onClick={() => setReplyTarget(null)}>
              返信としてつなげない
            </button>
          </div>
        )}
        {!enabled && <FeatureOff reason="メールの草案は、いまこの Bot では使えません。Bot の設定が済むまでお待ちください。" />}
        <form className="bot-form" onSubmit={submit} noValidate>
          <fieldset disabled={!enabled || submitting}>
            <label htmlFor="mail-to">相手</label>
            <p className="field-hint" id="mail-to-hint">
              例：〇〇レンタル ご担当者様／学務課 ご担当者様
            </p>
            <input
              id="mail-to"
              ref={toField}
              type="text"
              maxLength={MAIL_LIMITS.toMax}
              value={to}
              onChange={(e) => setTo(e.target.value)}
              aria-invalid={invalid('to')}
              aria-describedby={describedBy('to', 'mail-to-hint')}
              data-testid="mail-to"
            />
            {message('to')}

            <label htmlFor="mail-purpose">要件（伝えたいこと・お願いしたいこと）</label>
            <textarea
              id="mail-purpose"
              ref={purposeField}
              rows={5}
              value={purpose}
              onChange={(e) => setPurpose(e.target.value)}
              aria-invalid={invalid('purpose')}
              aria-describedby={describedBy('purpose', 'mail-purpose-count')}
              data-testid="mail-purpose"
            />
            <p id="mail-purpose-count" className={`counter ${purpose.length > MAIL_LIMITS.purposeMax ? 'over' : ''}`}>
              {purpose.length}／{MAIL_LIMITS.purposeMax}字
            </p>
            {message('purpose')}

            <label htmlFor="mail-sender">差出人（任意）</label>
            <p className="field-hint" id="mail-sender-hint">
              名乗りと署名に入ります。例：渉外課 山田
            </p>
            <input
              id="mail-sender"
              type="text"
              maxLength={MAIL_LIMITS.senderMax}
              value={sender}
              onChange={(e) => setSender(e.target.value)}
              aria-describedby="mail-sender-hint"
              data-testid="mail-sender"
            />

            <details className="bot-details" ref={details} data-testid="mail-details">
              <summary>
                詳細（返信先のメール・やりとり・資料・モデル）
                {cleanText(received) && <span className="bot-tag bot-tag-info mail-reply-tag">返信先のメールあり</span>}
              </summary>
              <label htmlFor="mail-received">返信先のメール本文</label>
              <p className="field-hint" id="mail-received-hint">
                相手から届いたメールに返信するときは、本文をここに貼り付けます。新しく送るメールなら空のままにします。
              </p>
              <textarea
                id="mail-received"
                ref={receivedField}
                rows={5}
                value={received}
                onChange={(e) => setReceived(e.target.value)}
                aria-invalid={invalid('received')}
                aria-describedby={describedBy('received', 'mail-received-hint mail-received-count')}
                data-testid="mail-received"
              />
              <p id="mail-received-count" className={`counter ${received.length > MAIL_LIMITS.receivedMax ? 'over' : ''}`}>
                {received.length}／{MAIL_LIMITS.receivedMax}字
              </p>
              {message('received')}
              <label htmlFor="mail-relation">相手とのこれまでのやりとり</label>
              <select id="mail-relation" value={relation} onChange={(e) => setRelation(e.target.value as '' | MailRelation)}>
                <option value="">資料から判断する</option>
                {(Object.keys(MAIL_RELATIONS) as MailRelation[]).map((key) => (
                  <option key={key} value={key}>
                    {MAIL_RELATIONS[key]}
                  </option>
                ))}
              </select>
              <div className="bot-check">
                <input id="mail-sources" type="checkbox" checked={useSources} onChange={(e) => setUseSources(e.target.checked)} />
                <label htmlFor="mail-sources">委員会の資料を参照する</label>
              </div>
              <label htmlFor="mail-model">モデル</label>
              <select id="mail-model" value={model} onChange={(e) => setModel(e.target.value)}>
                {(docModels.length > 0 ? docModels : [MODEL_FALLBACK]).map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </details>

            {jobId && <p className="hint">入力はそのまま残っています。要件などを直して、もう一度作れます。</p>}
            {submitError && <ErrorLine error={submitError} what="草案の依頼を送る" />}
            <button type="submit" className="primary" data-testid="mail-submit">
              {submitting ? '送信しています…' : '草案を作る'}
            </button>
          </fieldset>
        </form>
        {share && !jobId && <p className="hint">{share}</p>}
      </section>
      <RecentJobs kind="doc" title="最近のメールの草案（全員）" reloadKey={reloadKey} onOpen={open} filter={isMailJob} testId="recent-mail" />
    </div>
  );
}

/** The finished draft: the subject and the body, each with its copy button. Null when the text has no 件名 line. */
function MailDraftView({ text, bcc, onUse, reply = false }: { text: string; bcc: string | null; onUse?: (draft: { subject: string; body: string }) => void; reply?: boolean }) {
  const draft = splitMailDraft(text);
  const [copied, setCopied] = useState<{ ok: boolean; text: string } | null>(null);
  if (!draft) return null;

  const copy = (what: '件名' | '本文', value: string) => {
    const done = () => setCopied({ ok: true, text: `${what}をコピーしました。メールの${what}の欄に貼り付けてください。` });
    const failed = () => setCopied({ ok: false, text: `${what}をコピーできませんでした。下の${what}を選んでコピーしてください。` });
    if (!navigator.clipboard) {
      failed();
      return;
    }
    navigator.clipboard.writeText(value).then(done, failed);
  };

  return (
    <div className="mail-draft" data-testid="mail-draft">
      {draft.notes && <BotText text={draft.notes} />}
      <div className="mail-part">
        <div className="mail-part-head">
          <h3>件名</h3>
          <button type="button" className="secondary" onClick={() => copy('件名', draft.subject)} data-testid="mail-copy-subject">
            件名をコピー
          </button>
        </div>
        <p className="mail-subject" data-testid="mail-subject">
          {draft.subject}
        </p>
      </div>
      <div className="mail-part">
        <div className="mail-part-head">
          <h3>本文</h3>
          <button type="button" className="secondary" onClick={() => copy('本文', draft.body)} data-testid="mail-copy-body">
            本文をコピー
          </button>
        </div>
        <div className="mail-body" data-testid="mail-body">
          {draft.body}
        </div>
      </div>
      {copied && (
        <p className={`status ${copied.ok ? 'ok' : 'error'}`} role={copied.ok ? 'status' : 'alert'} data-testid="mail-copied">
          {copied.text}
        </p>
      )}
      {onUse && (
        <div className="mail-draft-send">
          <button type="button" onClick={() => onUse({ subject: draft.subject, body: draft.body })} data-testid="mail-use-draft">
            {reply ? 'この草案で返信する' : 'この草案でメールを作る'}
          </button>
          <p className="hint">
            {reply ? '返信先のスレッドで、返信の欄に件名と本文が入ります。' : '「メール」の「新しいメールを書く」に件名と本文が入ります。'}
            宛先・【 】の箇所を確かめてから、委員会のアドレスで送れます（送る前に確認の画面が出ます）。
          </p>
        </div>
      )}
      <p className="hint">
        【 】の箇所を埋め、宛先・日時・金額などを確かめてから、各自の委員会のメールアドレスで送ってください。
        {bcc && <>委員会の受信箱にも残すときは、BCC に {bcc} を入れます。</>}
      </p>
    </div>
  );
}
