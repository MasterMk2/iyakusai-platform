import { connect as netConnect } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import type { Duplex } from 'node:stream';

// A small SMTP submission client for one message at a time (the committee's Gmail account,
// smtp.gmail.com): implicit TLS on 465 or STARTTLS on 587, AUTH PLAIN with the
// account's app password, then MAIL / RCPT / DATA. Nothing about the message, its addresses or the
// password is logged or put into an error; errors carry the step and the server's reply code only.

export interface SmtpSettings {
  host: string;
  port: number;
  security: 'tls' | 'starttls';
  user: string;
  password: string;
}

export interface SmtpEnvelope {
  from: string;
  to: string[];
}

/**
 * Where it failed. `delivered` is "no" when the server did not take the message (it can be sent again)
 * and "unknown" when the connection ended after the message was handed over but before the server
 * answered (it may have been sent: sending again could send it twice).
 */
export class SmtpError extends Error {
  constructor(
    readonly step: 'connect' | 'greeting' | 'starttls' | 'auth' | 'sender' | 'recipient' | 'data',
    readonly code: number | null,
    readonly delivered: 'no' | 'unknown',
    message: string,
  ) {
    super(message);
  }
}

export interface MailTransport {
  /** Resolves when the server accepted the message; rejects with SmtpError. */
  send(envelope: SmtpEnvelope, raw: Buffer): Promise<void>;
}

interface Reply {
  code: number;
  lines: string[];
}

const STEP_TIMEOUT_MS = 30_000;
const DATA_TIMEOUT_MS = 120_000;

/** Reads SMTP replies (multi-line "250-..." up to "250 ...") from a socket that can be swapped for TLS. */
class Conversation {
  private buffer = '';
  private waiting: { resolve: (r: Reply) => void; reject: (e: Error) => void } | null = null;
  private ended: Error | null = null;
  private pending: string[] = [];
  /** Replies that arrived before anyone asked for them (the greeting can come first). */
  private replies: Reply[] = [];
  private socket!: Duplex;

  constructor(socket: Duplex) {
    this.attach(socket);
  }

  attach(socket: Duplex): void {
    this.socket = socket;
    this.buffer = '';
    this.pending = [];
    this.replies = [];
    socket.on('data', (chunk: string | Buffer) => this.onData(typeof chunk === 'string' ? chunk : chunk.toString('latin1')));
    socket.on('error', (err: Error) => this.fail(err));
    socket.on('close', () => this.fail(new Error('connection closed')));
  }

  /** Stops listening to the current socket (before STARTTLS wraps it). */
  detach(): Duplex {
    this.socket.removeAllListeners('data');
    this.socket.removeAllListeners('error');
    this.socket.removeAllListeners('close');
    return this.socket;
  }

  private onData(text: string): void {
    this.buffer += text;
    if (this.buffer.length > 64 * 1024) {
      this.fail(new Error('reply too long'));
      return;
    }
    let at: number;
    while ((at = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, at).replace(/\r$/, '');
      this.buffer = this.buffer.slice(at + 1);
      this.pending.push(line);
      if (/^\d{3} /.test(line) || /^\d{3}$/.test(line)) {
        const reply: Reply = { code: Number(line.slice(0, 3)), lines: this.pending };
        this.pending = [];
        const w = this.waiting;
        this.waiting = null;
        if (w) w.resolve(reply);
        else this.replies.push(reply);
      }
    }
  }

  private fail(err: Error): void {
    this.ended ??= err;
    const w = this.waiting;
    this.waiting = null;
    w?.reject(err);
  }

  read(timeoutMs = STEP_TIMEOUT_MS): Promise<Reply> {
    const queued = this.replies.shift();
    if (queued) return Promise.resolve(queued);
    if (this.ended) return Promise.reject(this.ended);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting = null;
        reject(new Error('timeout'));
      }, timeoutMs);
      this.waiting = {
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      };
    });
  }

  /** Anything received but not yet asked for (nothing may follow the STARTTLS go-ahead in plain text). */
  get unread(): boolean {
    return this.replies.length > 0 || this.pending.length > 0 || this.buffer.length > 0;
  }

  write(data: string | Buffer): void {
    this.socket.write(data);
  }

  /** Writes and resolves once the data is handed to the system (a large message takes a while to go out). */
  writeAll(data: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.write(data, (err?: Error | null) => (err ? reject(err) : resolve()));
    });
  }

  close(): void {
    this.socket.destroy();
  }
}

/** The message as SMTP DATA: CRLF line ends, a leading "." doubled, ended by "<CRLF>.<CRLF>". */
export function dotStuff(raw: Buffer): Buffer {
  const text = raw.toString('latin1').replace(/\r?\n/g, '\r\n');
  const stuffed = text.replace(/(^|\r\n)\./g, '$1..');
  return Buffer.from(`${stuffed}${stuffed.endsWith('\r\n') ? '' : '\r\n'}.\r\n`, 'latin1');
}

export type Connector = (s: SmtpSettings) => Promise<Duplex>;
export type TlsUpgrade = (socket: Duplex, s: SmtpSettings) => Promise<Duplex>;

const connectSocket: Connector = (s) =>
  new Promise((resolve, reject) => {
    const socket: Duplex =
      s.security === 'tls'
        ? tlsConnect({ host: s.host, port: s.port, servername: s.host, minVersion: 'TLSv1.2' }, () => resolve(socket))
        : netConnect({ host: s.host, port: s.port }, () => resolve(socket));
    socket.once('error', reject);
    // Idle limit of the connection; each step has its own shorter wait.
    (socket as { setTimeout?: (ms: number, cb: () => void) => void }).setTimeout?.(DATA_TIMEOUT_MS, () => socket.destroy(new Error('timeout')));
  });

const upgradeSocket: TlsUpgrade = (socket, s) =>
  new Promise((resolve, reject) => {
    const secure: TLSSocket = tlsConnect({ socket: socket as never, servername: s.host, minVersion: 'TLSv1.2' }, () => resolve(secure));
    secure.once('error', reject);
  });

/** An envelope address: printable ASCII without angle brackets (the message builder checked the form). */
function path(address: string): string {
  if (!/^[\x21-\x3b\x3d\x3f-\x7e]{3,254}$/.test(address)) throw new SmtpError('recipient', null, 'no', 'メールアドレスの形式が正しくありません。');
  return address;
}

/** SMTP with the account's password. `connect` and `upgrade` are replaced by the tests. */
export function smtpTransport(s: SmtpSettings, connect: Connector = connectSocket, upgrade: TlsUpgrade = upgradeSocket): MailTransport {
  return {
    async send(envelope, raw) {
      let socket: Duplex;
      try {
        socket = await connect(s);
      } catch {
        throw new SmtpError('connect', null, 'no', 'メールサーバーに接続できませんでした。');
      }
      const c = new Conversation(socket);
      const expect = async (step: SmtpError['step'], ok: (code: number) => boolean, timeoutMs?: number): Promise<Reply> => {
        let reply: Reply;
        try {
          reply = await c.read(timeoutMs);
        } catch {
          throw new SmtpError(step, null, step === 'data' ? 'unknown' : 'no', 'メールサーバーとの通信が途中で切れました。');
        }
        if (!ok(reply.code)) throw new SmtpError(step, reply.code, 'no', `メールサーバーが受け付けませんでした（${reply.code}）。`);
        return reply;
      };
      const command = async (line: string, step: SmtpError['step'], ok: (code: number) => boolean) => {
        c.write(`${line}\r\n`);
        return expect(step, ok);
      };
      try {
        await expect('greeting', (code) => code === 220);
        let ehlo = await command('EHLO app.iyakusai.com', 'greeting', (code) => code === 250);
        if (s.security === 'starttls') {
          if (!ehlo.lines.some((l) => /^250[ -]STARTTLS\b/i.test(l))) throw new SmtpError('starttls', null, 'no', 'メールサーバーが暗号化（STARTTLS）に対応していません。');
          await command('STARTTLS', 'starttls', (code) => code === 220);
          // Plain text after the go-ahead would be read as the encrypted server's replies (an injection): refuse.
          if (c.unread) throw new SmtpError('starttls', null, 'no', 'メールサーバーとの暗号化の前に、余分な応答がありました。');
          let secure: Duplex;
          try {
            secure = await upgrade(c.detach(), s);
          } catch {
            throw new SmtpError('starttls', null, 'no', 'メールサーバーとの暗号化に失敗しました。');
          }
          c.attach(secure);
          ehlo = await command('EHLO app.iyakusai.com', 'greeting', (code) => code === 250);
        }
        if (!ehlo.lines.some((l) => /^250[ -]AUTH\b.*\bPLAIN\b/i.test(l))) throw new SmtpError('auth', null, 'no', 'メールサーバーがこのログイン方式に対応していません。');
        const token = Buffer.from(`\u0000${s.user}\u0000${s.password}`, 'utf8').toString('base64');
        await command(`AUTH PLAIN ${token}`, 'auth', (code) => code === 235);
        await command(`MAIL FROM:<${path(envelope.from)}>`, 'sender', (code) => code === 250);
        for (const to of envelope.to) await command(`RCPT TO:<${path(to)}>`, 'recipient', (code) => code === 250 || code === 251);
        await command('DATA', 'data', (code) => code === 354).catch((err: unknown) => {
          // The message itself has not been sent yet.
          if (err instanceof SmtpError) throw new SmtpError('data', err.code, 'no', err.message);
          throw err;
        });
        // The wait for the answer starts once the whole message is handed over (a large one takes a while);
        // a failure while writing means the ending "." was not sent, so the server did not take it.
        try {
          await c.writeAll(dotStuff(raw));
        } catch {
          throw new SmtpError('data', null, 'no', 'メールサーバーとの通信が途中で切れました。');
        }
        await expect('data', (code) => code === 250, DATA_TIMEOUT_MS);
        c.write('QUIT\r\n');
      } finally {
        // QUIT is a courtesy: the message is accepted at the 250 after DATA.
        setTimeout(() => c.close(), 200).unref?.();
      }
    },
  };
}
