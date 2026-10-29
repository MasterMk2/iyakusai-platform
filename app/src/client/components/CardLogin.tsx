import { useCallback, useEffect, useRef, useState } from 'react';
import { parseLoginCardUrl } from '../../shared/card-login';
import { api, toFailure } from '../api';

/** Card credentials live in memory only; the entry URL is cleared before React starts. */
export function CardLanding({ token }: { token: string | null }) {
  const [error, setError] = useState<string | null>(token ? null : 'カードの情報がありません。もう一度、委員カードにタッチしてください。');
  const [switching, setSwitching] = useState(false);
  const [busy, setBusy] = useState(false);
  const started = useRef(false);
  const login = useCallback(async (switchAccount = false) => {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      await api('POST', '/api/auth/cards/login', { token, switchAccount });
      window.location.replace('/#/home');
    } catch (err) {
      const failure = toFailure(err);
      setSwitching(failure.body?.error === 'account_switch');
      setError(failure.message);
    } finally { setBusy(false); }
  }, [token]);
  useEffect(() => {
    if (!started.current && token) { started.current = true; void login(); }
  }, [login, token]);
  return <main className="card-entry">
    <p className="card-brand">医薬祭実行委員会</p>
    <h1>委員カードでログイン</h1>
    {busy ? <p role="status">カードと、この端末の登録を確認しています…</p> : <>
      {error && <p className="status error" role="alert">{error}</p>}
      {token && <button onClick={() => void login(switching)}>{switching ? '入力を保存したので、アカウントを切り替える' : 'もう一度ログインする'}</button>}
      <p><a href="/login">パスワードでログインする</a></p>
    </>}
    <p className="hint">はじめて使うブラウザでは、ログイン後に「設定 → 委員カード」で端末を登録してください。カード情報はこの画面を閉じると破棄されます。</p>
  </main>;
}

interface ReaderReply {
  login_cards?: boolean;
  ok: boolean; code?: string; error?: string; seq: number; revision: number; event_seq: number; instance: string;
  reader: { state: string; text: string };
  reads: { seq: number; code: string; url: string; age_ms: number }[];
  events?: { text: string }[];
}

/** Explicitly starts a single-tab claim; never takes over the rental reader on page load. */
export function CardReaderLogin({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [state, setState] = useState('PCはUSB読取機に、スマホは本体にカードをタッチします。');
  const [active, setActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [switching, setSwitching] = useState<string | null>(null);
  const aborter = useRef<AbortController | null>(null);
  const device = useRef<AbortController | null>(null);
  useEffect(() => () => { aborter.current?.abort(); device.current?.abort(); }, []);

  const finish = async (token: string, switchAccount = false) => {
    aborter.current?.abort(); device.current?.abort(); setActive(false);
    setState('カードと端末の登録を確認しています…');
    try {
      await api('POST', '/api/auth/cards/login', { token, switchAccount });
      setSwitching(null);
      onLoggedIn();
    } catch (err) {
      const failure = toFailure(err);
      setSwitching(failure.body?.error === 'account_switch' ? token : null);
      setError(failure.message);
      setState('確認が必要です');
    }
  };

  const start = async () => {
    aborter.current?.abort();
    const controller = new AbortController(); aborter.current = controller;
    setActive(true); setError(null); setSwitching(null); setState('PCの読取機に接続しています…');
    const client = crypto.randomUUID();
    let seq: number | null = null, revision = 0, eventSeq = 0, instance: string | null = null;
    try {
      while (!controller.signal.aborted) {
        const query = new URLSearchParams({ client, wait: seq === null ? '0' : '2', purpose: 'login', revision: String(revision), event_after: String(eventSeq) });
        if (seq === null) query.set('claim', '1'); else query.set('after', String(seq));
        const response = await fetch(`http://127.0.0.1:48731/v1/reads?${query}`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(6000)]), credentials: 'omit' });
        const result = await response.json() as ReaderReply;
        if (!response.ok || !result.ok) throw new Error(result.error ?? '読取機を使えません。');
        if (result.login_cards !== true) throw new Error('委員カード対応の読取ソフトを起動してください。いまの読取ソフトは物品専用です。');
        if (controller.signal.aborted || document.visibilityState !== 'visible') break;
        if (instance !== null && instance !== result.instance) throw new Error('読取ソフトが再起動しました。もう一度接続してください。');
        instance = result.instance; seq = result.seq; revision = result.revision; eventSeq = result.event_seq;
        setState(result.reader.text);
        if (result.reader.state === 'disconnected' || result.reader.state === 'error') throw new Error(result.reader.text);
        for (const read of result.reads) {
          if (read.age_ms > 4000) continue;
          const token = parseLoginCardUrl(read.url, window.location.origin);
          if (!token) { setError('委員カードをタッチしてください。物品カードではログインできません。'); continue; }
          // Acknowledge delivery before leaving the reader, without transferring the secret in a URL.
          await fetch(`http://127.0.0.1:48731/v1/reads?${new URLSearchParams({ client, after: String(seq), wait: '0', purpose: 'login' })}`, { signal: controller.signal, credentials: 'omit' });
          await finish(token); return;
        }
        if (result.events?.length) setError(result.events.at(-1)!.text);
      }
    } catch (err) {
      if (!controller.signal.aborted) setError(err instanceof TypeError ? '読取ソフトに接続できません。委員カード対応版を起動し、ブラウザのローカルネットワーク接続を許可してから再接続してください。' : err instanceof Error ? err.message : '読取機に接続できません。');
    } finally { if (aborter.current === controller) setActive(false); }
  };
  useEffect(() => {
    const hide = () => { if (document.visibilityState !== 'visible') { aborter.current?.abort(); device.current?.abort(); setActive(false); } };
    document.addEventListener('visibilitychange', hide);
    return () => document.removeEventListener('visibilitychange', hide);
  }, []);

  interface NfcReader {
    scan: (options: { signal: AbortSignal }) => Promise<void>;
    onreading: ((event: { message: { records: { recordType: string; data: DataView }[] } }) => void) | null;
    onreadingerror: (() => void) | null;
  }
  const mobileScan = async () => {
    const Reader = (window as unknown as { NDEFReader?: new () => NfcReader }).NDEFReader;
    if (!Reader) { setError('このブラウザでは、画面を閉じてスマホ本体にカードをタッチし、表示される通知を開いてください。'); return; }
    aborter.current?.abort(); device.current?.abort();
    const controller = new AbortController(); device.current = controller;
    try {
      const reader = new Reader();
      reader.onreading = event => {
        if (controller.signal.aborted || document.visibilityState !== 'visible') return;
        const urls = event.message.records.filter(r => r.recordType === 'url').map(r => new TextDecoder().decode(r.data));
        const token = urls.map(url => parseLoginCardUrl(url, location.origin)).find(Boolean);
        if (token) void finish(token); else setError('委員カードをタッチしてください。');
      };
      reader.onreadingerror = () => setError('カードを読み取れませんでした。位置を変えて、もう一度タッチしてください。');
      await reader.scan({ signal: controller.signal });
      setActive(true); setState('スマホに委員カードをタッチしてください'); setError(null);
    } catch { if (!controller.signal.aborted) setError('NFCの使用を許可し、スマホのNFCをオンにしてから再試行してください。'); }
  };

  return <section className="card-login-block" aria-label="委員カードでログイン">
    <div className="card-touch-mark" aria-hidden="true">▯</div>
    <div><h2>委員カードでログイン</h2><p role="status">{state}</p>
      <div className="actions">
        <button type="button" onClick={() => void start()} disabled={active}>PCの読取機に接続</button>
        {'NDEFReader' in window && <button type="button" className="secondary" disabled={active} onClick={() => void mobileScan()}>スマホで読み取る</button>}
        {active && <button type="button" className="secondary" onClick={() => { aborter.current?.abort(); device.current?.abort(); setActive(false); setState('読取りを終了しました'); }}>読取りを止める</button>}
      </div>
      <p className="hint">iPhoneなどでは、スマホ本体にカードをタッチし、表示された通知を開いてください。初回は下からログインし、設定で端末を登録します。</p>
      {error && <p className="status error" role="alert">{error}</p>}
      {switching && <button type="button" onClick={() => void finish(switching, true)}>入力を保存したので、アカウントを切り替える</button>}
    </div>
  </section>;
}
