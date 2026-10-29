# 統合アプリの「Bot」タブと IyakusaiBot の取り決め

統合アプリの「Bot」タブから、IyakusaiBot の質問（`/ask`）・文書の起草（`/doc`）・リマインド・タスク候補の承認を使うための取り決めです。
節の番号はソースのコメントから参照しているので、変えないでください。ここに書く ID や値はすべて例です。

## 1. 全体の形

```text
ブラウザ ─> 統合アプリ  /api/assistant/*          ← §4（ブラウザ向け）
              │ 署名付き（svc-auth/v1・client "web-gateway"・actor "discord-<ID>"）
              ▼
Bot ホストのタスク API に同居する Bot の連携口  /api/integration/v1/assistant/*   ← §3
              │ 読む：リマインドの写し・タスク候補の台帳・ジョブ表
              │ 書く：ジョブ表だけ（受け付け）
              ▼
ジョブ表（SQLite、WAL）
              ▲ 2 秒ごとに受け取る
IyakusaiBot の Assistant Cog（Bot のプロセスの中）
   ask       → Discord の /ask と同じ処理をそのまま実行（同じ劣化の段階・同時実行の枠・使用量の記帳）
   doc       → Discord の /doc と同じ処理をそのまま実行
   remind    → リマインドの保存（書くのは Bot だけ）。通知は Discord のリマインドと同じく Bot が出す
   screening → Discord のタスク候補のボタンと同じ処理を呼ぶ。Discord の候補の投稿も同じく書き換わる
   → 結果をジョブ表に書き戻す。ask・doc は共有用のチャンネル（設定 share_channel_id）にも投稿する
```

- **書くのは 1 か所**：リマインド・候補の台帳・タスク DB を書くのは Bot のプロセスだけ。連携口はジョブを受け付けて、結果を読むだけ。
- **連携口は遅い記憶装置に触れない**：リマインドの保存先がネットワーク上のドライブにある構成では、ドライブが止まると同じプロセスのタスク API まで止まる。そこで、リマインドの一覧と件数は、Bot がジョブ表の `reminder_snapshot` に書き出した写し（30 秒ごとと、変更の直後）から返す。候補の台帳（ローカルの SQLite）は読み取り専用（`mode=ro`）で読む。
- **連携口がタスク API を巻き込まない**：待つルート（§3-3 の「最大 8 秒待つ」）は同時に 4 本まで（超えたら待たずに 202）。進み具合の問い合わせ（2〜3 秒ごと）での委員の確認はキャッシュから返し、Discord を呼ばない（キャッシュが切れたときだけ 1 回）。
- Discord との同期は「Bot が実行して Discord に出す」ことで成り立たせる。アプリだけに残るものは作らない（ask・doc は共有用のチャンネル、リマインドは Discord の通知、候補は元の投稿の書き換え）。
- Bot が止まっていると、ジョブは `queued` のまま。アプリは「Bot が応答していません」と出す（§3-3 の `bot` 欄）。
- 画像の作成（`image`）は型に残しているが、いまの Bot は使えない（`features.image=false` を返し、`image_enabled = true` では起動しない）。
- 「似た質問」は、アプリから出した質問だけが対象（Discord の `/ask` の履歴は含まない。§7）。

## 2. 設定（Bot ホストの `config.toml`、0600）

```toml
[assistant]
enabled = true
store_path = "/home/<user>/.iyakusai/assistant/assistant.sqlite3"   # 絶対パス。ローカルのディスク
files_dir = "/home/<user>/.iyakusai/assistant/files"                # 生成した文書。ローカルのディスク
share_channel_id = 1000000000000000001        # アプリから出した ask・doc を投稿するチャンネル
reminder_channel_ids = [1000000000000000001, 1000000000000000002]   # アプリのリマインドの通知先の候補（先頭が既定）
poll_sec = 2
image_enabled = false
max_active_per_user = 3                        # 受付中と実行中の ask・doc の上限（1 人あたり）
```

- `[assistant] enabled = false` か節が無ければ、Cog を読み込まない（従来どおりの Bot）。連携口は 404 を返す。
- タスク API の設定（JSON）に `assistant_enabled: true` を足すと、連携口が有効になる（無ければ 404）。
- 統合アプリの側は `SMM_ASSISTANT_MODE=on`（タスク API の URL と鍵を共用する）。

## 3. Bot ホストの連携口（タスク API に同居）

共通：タスク API と同じ TLS・署名・接続元の制限・Host の照合。actor が委員であることを確かめる（タスクの集計と同じ確かめ方。10 分のキャッシュを使い、要求ごとに Discord を何度も呼ばない）。委員でなければ 403 `FORBIDDEN`。
エラーの形はタスク API と同じ `{"error":{"code","message"}}`。`message` は利用者に見せてよい日本語。

### 3-1. 型

```ts
type JobKind = 'ask' | 'doc' | 'image' | 'remind' | 'screening';
type JobState = 'queued' | 'running' | 'done' | 'failed' | 'canceled';

interface Job {
  id: string;                 // "j_" + 20 文字（[a-z0-9]）
  kind: JobKind;
  op: string | null;          // remind: create/done/delete、screening: ok/ng/undo/return、ほかは null
  state: JobState;
  actor: { id: string; name: string };     // id は "discord-<ID>"、name は表示名
  input: Record<string, unknown>;          // 受け付けた入力（§3-4 の形）
  progress: { phase: string; text: string } | null;   // 実行中だけ。text は Discord の進み具合の表示と同じ文
  result: JobResult | null;   // done のときだけ
  error: { code: string; message: string } | null;   // failed のときだけ
  discordUrl: string | null;  // 共有用のチャンネルなどに出した最初のメッセージ（ask・doc）
  createdAt: string; startedAt: string | null; finishedAt: string | null;   // ISO 8601（+09:00）
}

interface JobResult {
  text: string;               // 本文（Discord の Markdown。-# の小さい行を含む）
  files: { name: string; mime: string; size: number; url: string }[];   // url は §3-3 の files の相対パス
  reminder?: Reminder;        // remind
  message?: string;           // remind・screening の結果の一文
  taskNumber?: number | null; // screening の ok
}
```

### 3-2. 一覧と入力の決まり

| 項目 | 値 |
|---|---|
| ask の model | `auto`（既定）・`sonnet`・`opus` |
| ask の effort | `auto`（既定）・`low`・`medium`・`high`・`xhigh` |
| ask の format | `null`（本文）・`docx`・`md`・`txt` |
| doc の docType | `request`（依頼文（対外））・`notice`（お知らせ）・`report`（報告書）・`minutes`（議事録のたたき台）・`mail`（メールの文面）・`free`（自由） |
| doc の model | `auto`・`sonnet`・`opus` |
| image の aspect | `1:1`（既定）・`16:9`・`9:16`・`4:3`・`3:4` |
| remind の repeat | `none`・`daily`・`weekly`・`monthly` |

使えるモデルは `GET /assistant/meta` の `models` で決まります。そこに無いモデルは 400 `MODEL_UNAVAILABLE`。

### 3-3. ルート

| メソッド・パス | 内容 |
|---|---|
| GET `/assistant/meta` | `{ features:{ask,doc,image,remind,screening:boolean}, models:[{id,label,ask:boolean,doc:boolean}], docTypes:[{id,label}], reminderChannels:[{id,name}], shareChannel:{id,name}\|null, isAdmin:boolean, bot:{alive:boolean, lastSeenAt:string\|null} }`。`bot.alive` は Cog の生存の記録（30 秒以内） |
| GET `/assistant/summary` | ホーム用。`{ pendingCandidates:number, reminders:{overdue:number, today:number, upcoming7d:number} }`（自分が登録者か対象の未完了） |
| POST `/assistant/jobs` | `{clientOperationId, kind:'ask'\|'doc'\|'image', input}` → 202 `{job}`。同じ actor・同じ clientOperationId なら同じジョブを返す。上限を超えたら 429 `TOO_MANY_JOBS` |
| GET `/assistant/jobs/<id>` | `{job}`。ask・doc は委員なら誰でも読める（共有用のチャンネルに出ているため）。remind・screening は本人だけ |
| GET `/assistant/jobs?kind=ask&mine=1&limit=20&before=<id>` | `{jobs:[Job], next:string\|null}`。新しい順。`mine` を省くと全員の ask・doc |
| GET `/assistant/similar?q=<質問>` | `{jobs:[{job, score}]}`。完了した ask から、文字の 2-gram の類似度 0.35 以上の上位 5 件 |
| POST `/assistant/jobs/<id>/cancel` | 本人の `queued` だけ取り消せる。`{job}` |
| GET `/assistant/files/<jobId>/<name>` | 生成物の本体（`Content-Type` と `Content-Disposition: attachment`）。最大 20 MB |
| GET `/assistant/members` | `{members:[{id:"discord-<ID>", name}]}`。リマインドの対象を選ぶため（委員だけ） |
| GET `/assistant/reminders?scope=mine\|all` | `{reminders:[Reminder], snapshotAt:string\|null}`。`mine` は自分が登録者か対象のもの。未完了だけ、期限の早い順。**Bot が書き出した写し（`reminder_snapshot`）から返す**。写しが 3 分より古ければ、`snapshotAt` で古さを示す（アプリは「◯分前の情報」と出す） |
| POST `/assistant/reminders` | `{clientOperationId, text, due, targetId?, repeat?, channelId?}` → ジョブを作り、最大 8 秒待つ。終われば 200 `{job}`（`job.result.reminder`）、終わらなければ 202 `{job}` |
| POST `/assistant/reminders/<id>/done` | `{clientOperationId}`。同上 |
| POST `/assistant/reminders/<id>/delete` | `{clientOperationId}`。同上 |
| GET `/assistant/candidates?state=open\|recent` | `{candidates:[Candidate]}`。open は承認待ち（posted）と、自動で起票したもの（created・auto）のうち差し戻せるもの。recent は直近 7 日のすべての状態 |
| POST `/assistant/candidates/<id>/<action>` | action は `ok`・`ng`・`undo`・`return`。`{clientOperationId, comment?}`（return は comment が必須・1000 字まで）。最大 8 秒待つ（同上） |

```ts
interface Reminder {
  id: number; text: string; due: string;   // ISO（+09:00）
  repeat: 'none' | 'daily' | 'weekly' | 'monthly';
  creator: { id: string; name: string }; target: { id: string; name: string };
  channel: { id: string; name: string } | null;
  canComplete: boolean; canDelete: boolean;   // Discord と同じ規則：完了は登録者・対象・役員（manage_guild）、削除は登録者・役員
}

interface Candidate {
  id: number; state: string; decision: string | null;   // 台帳の値（posted / created / rejected / returned / revised / undone …）
  title: string; description: string; deadline: string | null;
  departments: string[];                 // 部局のタグ
  assigneeName: string | null;
  sources: { label: string; excerpt: string }[];   // 個人情報は台帳と同じく伏せ字のまま
  taskNumber: number | null;
  discordUrl: string | null;             // 候補の投稿
  createdAt: string;
  actions: ('ok' | 'ng' | 'undo' | 'return')[];   // いまの状態で押せるもの（Discord のボタンと同じ）
}
```

### 3-4. ジョブの入力

```ts
// ask
{ question: string /* 1..1000 */, model?: string, effort?: string, tone?: string /* ..100 */, format?: string | null }
// doc
{ docType: string, content: string /* 1..2000 */, format: 'docx' | 'md' | 'txt', useSources: boolean, model?: string }
// image
{ prompt: string /* 1..1000 */, aspect?: string }
// remind（POST /assistant/reminders が作る）
{ text: string /* 1..500 */, due: string /* Discord の /remind と同じ書き方か ISO */, targetId?: string, repeat?: string, channelId?: string }
```

文字数・選択肢の外は 400 `VALIDATION`。前後の空白は削る。制御文字は、改行とタブ以外を削る。

## 4. 統合アプリのブラウザ向け API

ログインした委員だけ。actor はタスクと同じく、ログインを確かめた Discord アカウント（`discord-<ID>`）。Bot ホストの連携口が無効・未設定なら 404 `ASSISTANT_DISABLED`、つながらなければ 503 `ASSISTANT_UNAVAILABLE`。

| ブラウザ → アプリ | アプリ → Bot ホスト |
|---|---|
| GET `/api/assistant/meta` | GET `/assistant/meta` |
| GET `/api/assistant/summary` | GET `/assistant/summary` |
| POST `/api/assistant/jobs` | POST `/assistant/jobs`（clientOperationId に `ui-` を付ける） |
| GET `/api/assistant/jobs/:id` | GET `/assistant/jobs/<id>` |
| GET `/api/assistant/jobs` | GET `/assistant/jobs` |
| GET `/api/assistant/similar` | GET `/assistant/similar` |
| POST `/api/assistant/jobs/:id/cancel` | POST `/assistant/jobs/<id>/cancel` |
| GET `/api/assistant/files/:id/:name` | GET `/assistant/files/<id>/<name>`（そのまま流す。`Content-Type` は png・jpeg・webp・docx・md・txt だけ通す） |
| GET `/api/assistant/members` | GET `/assistant/members` |
| GET・POST `/api/assistant/reminders…` | 同じ名前 |
| GET・POST `/api/assistant/candidates…` | 同じ名前 |

- ファイルの `url` は、アプリが `/api/assistant/files/<id>/<name>` に書き換えて返す。
- 時間切れ：通常は 8 秒、リマインドと候補の POST は 12 秒（Bot ホストの側が 8 秒待つため）。

## 5. 画面（アプリ）

- 機能タブの「Bot」。物品画面（`app/src/rental-web/index.html`）のタブも同じにする（[ui-guidelines.md](../ui-guidelines.md) §2・§8）。物品画面を変えたら、Service Worker のキャッシュの名前を新しくし、物品のブラウザの試験も流し直す。
- Bot の中は、質問・文書・メール・リマインド・タスク候補。使えないもの（meta の features が false）は理由を表示する（タブは隠さない）。
- 質問：入力すると先に「似た質問」（§3-3 の similar）を出し、過去の回答を開ける。送ると進み具合（2〜3 秒ごとに取得）→ 回答・出典・Discord へのリンク。下に「最近の質問（全員）」。
- 文書：種類・内容・形式・資料の参照・モデル → 結果の本文とダウンロード。メールは、文書の種類 `mail` を使う。
- リマインド：自分の一覧（期限超過は赤・今日は黄）、追加（期限・内容・対象・繰り返し・通知先）、完了・削除。
- タスク候補：承認待ちの一覧（部局・期限・担当の候補・根拠の抜粋）→［起票する］［コメントして差し戻す］［不要］。自動で起票したものには［差し戻す］［誤起票として閉じる］。
- ホームの「Bot」のカード：承認待ちの候補の数と、自分のリマインド（超過・今日）。0 件なら色を付けない。
- アプリから出したものには、Discord で何が起きるかを書く（例「回答は共有用のチャンネルにも投稿されます」「通知は Discord の #◯◯ に届きます」）。

## 6. Bot の側の約束（担当をまたぐ部分）

- ask と doc は、Discord の `/ask`・`/doc` と同じ関数を呼ぶ。プロンプトの組み立て・資料の検索・使用量の記帳を、アプリ用に別に作らない。
- 生成物は `files_dir/<ジョブの id>/` に書き、連携口に見せる分だけ登録する。資料のフォルダには置かない。
- 失敗したジョブは `failed` にして、利用者に見せてよい日本語を `error.message` に入れる。

## 7. 残していること

- Discord の `/ask` の履歴を「似た質問」に含めること（Bot の `/ask` の回答を記録する口が要る）。
- ジョブと生成物の自動の削除（当面は手で整理する。生成物は 1 件数 MB 以内）。

## 8. 試験

- Bot ホストの側：ジョブ表（受け付け・取り合い・やり直し・上限・冪等）、連携口（署名・委員の確認・各ルートの入力の検査・ファイル）、Cog（偽の Discord で ask・doc・remind・screening が Discord に投稿し、結果を書き戻す）。試験は `bot/tests/` と `bot/gateway/`。
- アプリの側：署名付きの呼び出し（合成の Bot ホスト）、入力の検査、権限、ファイルの中継、画面（Playwright：質問 → 進み具合 → 回答、リマインドの追加・完了、候補の承認、375px で横のスクロールがないこと）。試験は `app/tests/api/assistant.test.ts` と `app/tests/e2e/`。
