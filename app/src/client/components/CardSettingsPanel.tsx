import { useCallback, useState, type FormEvent } from 'react';
import type { CardSettings } from '../../shared/card-login';
import { api, fmtDate, toFailure } from '../api';
import { useLoader } from '../useLoader';
import { LoadStatus } from './LoadStatus';

const date = (value: number) => fmtDate(new Date(value).toISOString());
const states = { pending: '書込み・有効化待ち', active: '利用可能', revoked: '停止済み', expired: '期限切れ' };
const without = (record: Record<string, true>, key: string) => {
  const rest = { ...record };
  delete rest[key];
  return rest;
};
/**
 * Committee cards and registered browsers. Only what was pressed waits ('enroll', 'issue', 'issued', 'device:<id>',
 * 'card:<id>'), and its result shows there (2026-10-26: every button stopped, and the result was at the top of the
 * panel, out of sight below a long list). A result whose row went away with the reload shows below its list.
 */
export function CardSettingsPanel({ admin, onChanged }: { admin: boolean; onChanged: () => void }) {
  const [refresh, setRefresh] = useState(0);
  const load = useCallback((signal: AbortSignal) => { void refresh; return api<CardSettings>('GET', '/api/auth/cards', undefined, signal); }, [refresh]);
  const data = useLoader(load);
  const [label, setLabel] = useState('自分のPC・スマホ');
  const [password, setPassword] = useState('');
  const [account, setAccount] = useState('');
  const [cardLabel, setCardLabel] = useState('委員カード');
  const [issued, setIssued] = useState<{ id: string; url: string } | null>(null);
  const [busy, setBusy] = useState<Record<string, true>>({});
  const [result, setResult] = useState<{ at: string; text: string; error: boolean } | null>(null);
  const proof = () => password ? { password } : {};
  const run = async (at: string, action: () => Promise<void>, text: string) => {
    setBusy(b => ({ ...b, [at]: true })); setResult(null);
    try { await action(); setPassword(''); setRefresh(n => n + 1); setResult({ at, text, error: false }); onChanged(); }
    catch (err) { setResult({ at, text: toFailure(err).message, error: true }); }
    finally { setBusy(b => without(b, at)); }
  };
  const resultAt = (at: string) => result?.at === at && <p role={result.error ? 'alert' : 'status'} className={`status card-result${result.error ? ' error' : ''}`}>{result.text}</p>;
  // The result of a row that is no longer listed (a removed browser, a card the list no longer shows).
  const gone = (prefix: string, ids: string[] = []) => result?.at.startsWith(prefix) && !ids.includes(result.at.slice(prefix.length)) ? resultAt(result.at) : null;
  const enroll = (e: FormEvent) => {
    e.preventDefault();
    void run('enroll', async () => { await api('POST', '/api/auth/cards/device', { label, ...proof() }); }, 'このブラウザを登録しました。次回から委員カードをタッチしてログインできます。');
  };
  const issue = (e: FormEvent) => {
    e.preventDefault();
    void run('issue', async () => { setIssued(await api('POST', '/api/auth/cards/issue', { account, label: cardLabel, ...proof() })); }, '書込み用の情報を作りました。10分以内に空の委員カードへ書き込み、読取確認後に有効化してください。');
  };
  return <section className="card-settings" aria-label="委員カード">
    <h3>委員カード</h3>
    <p>初回だけ本人確認して、このブラウザを登録します。以後はPCの読取機やスマホへのタッチでログインできます。</p>
    <LoadStatus loader={data} what="委員カードの設定" />
    <label>本人確認用パスワード<input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" maxLength={1024} /></label>
    <p className="hint">パスワードでログインしてから5分以内なら空欄で登録できます。共有PCでは、使う人ごとに一度登録してください。ブラウザのデータを消した場合は再登録が必要です。</p>
    <form onSubmit={enroll} className="account-form">
      <h4>このブラウザ</h4>
      <p>{data.data?.deviceRegistered ? '登録済みです（180日間有効）。' : '未登録です。'}</p>
      <label>端末の名前<input value={label} onChange={e => setLabel(e.target.value)} maxLength={80} required /></label>
      <button disabled={!!busy.enroll}>{busy.enroll ? '登録中…' : 'この端末を登録する'}</button>
      {resultAt('enroll')}
    </form>
    {data.data?.devices.map(d => <div className="card-list-row" key={d.id}>
      <div><strong>{d.label}{d.current ? '（このブラウザ）' : ''}</strong><p className="hint">有効期限 {date(d.expiresAt)}</p>{resultAt(`device:${d.id}`)}</div>
      <button type="button" className="secondary" disabled={!!busy[`device:${d.id}`]} onClick={() => void run(`device:${d.id}`, async () => { await api('POST', '/api/auth/cards/device/revoke', { id: d.id }); }, 'このアカウントの端末登録を解除しました。カードで入ったログインも終了します。')}>{busy[`device:${d.id}`] ? '処理中…' : '登録を解除'}</button>
    </div>)}
    {gone('device:', data.data?.devices.map(d => d.id))}
    <h4>{admin ? '発行済みカード' : '自分のカード'}</h4>
    <p className="hint">カードをなくしたときは、ここで停止してください。停止すると、そのカードで入った端末のログインも終了します。</p>
    {!data.data?.cards.length && <p>まだ発行されていません。</p>}
    {data.data?.cards.map(c => <div className="card-list-row" key={c.id}>
      <div><strong>{c.label}</strong><p>{admin && `${data.data?.people.find(p => p.account === c.account)?.name ?? c.account} ／ `}{states[c.state]}</p><p className="hint">期限 {date(c.expiresAt)}{c.lastUsedAt ? ` ／ 最終利用 ${date(c.lastUsedAt)}` : ''}</p>{resultAt(`card:${c.id}`)}</div>
      {(c.state === 'active' || c.state === 'pending') && <button type="button" className="secondary" disabled={!!busy[`card:${c.id}`]} onClick={() => void run(`card:${c.id}`, async () => { await api('POST', '/api/auth/cards/revoke', { id: c.id }); if (issued?.id === c.id) setIssued(null); }, 'カードを停止しました。再発行する場合は新しいカードを発行してください。')}>{busy[`card:${c.id}`] ? '処理中…' : 'カードを停止'}</button>}
    </div>)}
    {gone('card:', data.data?.cards.map(c => c.id))}
    {admin && <form onSubmit={issue} className="account-form">
      <h4>委員カードを発行</h4>
      <label htmlFor="committee-card-person">委員</label><select id="committee-card-person" value={account} onChange={e => setAccount(e.target.value)} required><option value="">委員を選択</option>{data.data?.people.map(p => <option key={p.account} value={p.account}>{p.name}</option>)}</select>
      <label>カードの呼び名<input value={cardLabel} onChange={e => setCardLabel(e.target.value)} maxLength={80} required /></label>
      <button disabled={!!busy.issue || !!issued}>{busy.issue ? '作成中…' : '書込み用の情報を作る'}</button>
      {!issued && (resultAt('issue') || resultAt('issued'))}
    </form>}
    {issued && <div className="status card-issuance">
      <h4>空の委員カードへ書き込んでください</h4>
      <p>書込み用の情報は、この画面で一度だけ表示します。専用の「委員カード書込み」ソフトへ貼り付けてください。</p>
      <button type="button" onClick={() => { void navigator.clipboard.writeText(issued.url).then(() => setResult({ at: 'issued', text: 'コピーしました。書込みソフトへ貼り付けてください。', error: false })).catch(() => setResult({ at: 'issued', text: 'コピーできません。下の「手動コピー」を開いてコピーしてください。', error: true })); }}>書込み情報をコピー</button>
      <details><summary>手動コピー</summary><textarea readOnly value={issued.url} aria-label="カード書込み情報" /></details>
      <p className="hint">この情報を知る人はカードを複製できます。チャット・共有ドライブへ貼り付けないでください。</p>
      <label><input type="checkbox" required id="card-write-verified" /> 書込みソフトで、同じカードの読取確認が成功しました</label>
      <button type="button" disabled={!!busy.issued} onClick={() => {
        if (!(document.getElementById('card-write-verified') as HTMLInputElement).checked) { setResult({ at: 'issued', text: '先にカードの書込みと読取確認を行ってください。', error: true }); return; }
        void run('issued', async () => { await api('POST', '/api/auth/cards/activate', { id: issued.id, ...proof() }); setIssued(null); }, 'カードを有効化しました。本人へ渡し、各端末の初回登録を案内してください。');
      }}>{busy.issued ? '処理中…' : '読取確認が済んだカードを有効化'}</button>
      <button type="button" className="secondary" disabled={!!busy.issued} onClick={() => void run('issued', async () => { await api('POST', '/api/auth/cards/revoke', { id: issued.id }); setIssued(null); }, '今回の発行を取り消しました。')}>今回の発行を取り消す</button>
      {resultAt('issue') || resultAt('issued')}
    </div>}
  </section>;
}
