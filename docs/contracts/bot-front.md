# 統合アプリの「Bot」タブと IyakusaiBot の取り決め

統合アプリの「Bot」タブから、IyakusaiBot の質問（`/ask`）・文書の起草（`/doc`）・リマインド・タスク候補の承認を使うための取り決めです。タスク画面の起票支援（概略からタスクの分け方と担当の案を作る、§9）も同じ仕組みを使います。
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
   taskdraft → /doc と同じ AI で、概略からタスクの分け方と担当の案を作る（§9）。Discord には投稿しない
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
type JobKind = 'ask' | 'doc' | 'image' | 'remind' | 'screening' | 'taskdraft';
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
  draft?: TaskDraft;          // taskdraft（§9-3）
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
| POST `/assistant/jobs` | `{clientOperationId, kind:'ask'\|'doc'\|'image'\|'taskdraft', input}` → 202 `{job}`。同じ actor・同じ clientOperationId なら同じジョブを返す。上限を超えたら 429 `TOO_MANY_JOBS` |
| GET `/assistant/jobs/<id>` | `{job}`。ask・doc は委員なら誰でも読める（共有用のチャンネルに出ているため）。remind・screening・taskdraft は本人だけ |
| GET `/assistant/jobs?kind=ask&mine=1&limit=20&before=<id>` | `{jobs:[Job], next:string\|null}`。新しい順。`mine` を省くと全員の ask・doc |
| GET `/assistant/similar?q=<質問>` | `{jobs:[{job, score}]}`。完了した ask から、文字の 2-gram の類似度 0.35 以上の上位 5 件 |
| POST `/assistant/jobs/<id>/cancel` | 本人の `queued` だけ取り消せる。`{job}` |
| GET `/assistant/files/<jobId>/<name>` | 生成物の本体（`Content-Type` と `Content-Disposition: attachment`）。最大 20 MB |
| GET `/assistant/members` | `{members:[{id:"discord-<ID>", name}]}`。リマインドの対象を選ぶため（委員だけ） |
| GET `/assistant/reminders?scope=mine\|all` | `{reminders:[Reminder], snapshotAt:string\|null}`。`mine` は自分が登録者か対象のもの。未完了だけ、期限の早い順。**Bot が書き出した写し（`reminder_snapshot`）から返す**。写しが 3 分より古ければ、`snapshotAt` で古さを示す（アプリは「◯分前の情報」と出す） |
| POST `/assistant/reminders` | `{clientOperationId, text, due, targetId?, repeat?, channelId?}` → ジョブを作り、最大 8 秒待つ。終われば 200 `{job}`（`job.result.reminder`）、終わらなければ 202 `{job}` |
| POST `/assistant/reminders/<id>/done` | `{clientOperationId}`。同上 |
| POST `/assistant/reminders/<id>/delete` | `{clientOperationId}`。同上 |
| POST `/assistant/notices` | 個人あての知らせ（2026-11-11）。`{clientOperationId, targetIds:["discord-<ID>", …], text}` → Bot が `text` を各対象に DM で送る。対象は 1〜30 人で、委員でない人は外して残りに送る（全員が委員でなければ 400）。`text` は 1〜500 字（改行可）。ジョブは `remind` の `op:"notice"`（リマインドは作らない）。最大 8 秒待つ（同上）。Bot が知らせを扱えない版なら 400 `FEATURE_UNAVAILABLE` |
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

個人あての知らせ（`POST /assistant/notices`）の決まり：

- 呼ぶのは統合アプリのサーバーだけです（ブラウザからの口は作らない）。actor は、その知らせのもとになった操作をした人。
- いまの使い道は、メールの送信前の承認（依頼が来た → 校閲者、承認されて送られた・差し戻された → 書いた人。`app/docs/mail-approval.md`）。
- `text` はアプリが作り、メールのアドレス・件名・本文・差し戻しの理由は入れません。DM を受け取らない設定の人には、Bot が知らせ用のチャンネル（`[notify]` の `app_notice`。無ければ共有用のチャンネル）でその人だけにメンションして同じ文を出すためです。
- 1 人にも届かなければジョブは失敗（`UNAVAILABLE`）。アプリは結果を待たず、失敗しても元の操作は変えません。
- 同じ知らせを 2 度送らないよう、`clientOperationId` は「依頼の ID・知らせの種類・依頼の版」から作ります。
- Bot は、知らせを扱えることを能力の写しの `notice: true` で示します。連携口はそれが無い Bot にはジョブを積みません。

## 4. 統合アプリのブラウザ向け API

ログインした委員だけ。actor はタスクと同じく、ログインを確かめた Discord アカウント（`discord-<ID>`）。Bot ホストの連携口が無効・未設定なら 404 `ASSISTANT_DISABLED`、つながらなければ 503 `ASSISTANT_UNAVAILABLE`。

| ブラウザ → アプリ | アプリ → Bot ホスト |
|---|---|
| GET `/api/assistant/meta` | GET `/assistant/meta` |
| GET `/api/assistant/summary` | GET `/assistant/summary` |
| POST `/api/assistant/jobs` | POST `/assistant/jobs`（clientOperationId に `ui-` を付ける） |
| POST `/api/assistant/taskdraft` | POST `/assistant/jobs`（kind は taskdraft。名簿と未完了のタスクをアプリが足す。§9-2） |
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

## 9. タスクの起票支援（taskdraft・2026-11-09）

委員がタスク画面で「やりたいことの概略」を書くと、Bot がタスクの分け方と担当の案を出し、委員が確かめて直してから起票する。

### 9-1. 流れ

1. タスク画面の「＋ 新しいタスク」→「Bot に下書きを頼む」（どちらの作り方かはブラウザに覚える）。親タスクの「＋ 子タスクを追加」からも使え、そのときは子タスクだけを案にする。
2. ブラウザ → アプリ POST `/api/assistant/taskdraft` `{clientOperationId, overview, deadline?, tags?, parentId?, useSources?}`。
3. アプリは、頼んだ本人としてタスク API から委員の一覧（`members`）と全部局のタスク（`/tasks/all`、無い構成では最初の部局の一覧）を読み、名簿と未完了のタスクを組み立てて、ジョブ `taskdraft` を作る（§9-2）。閲覧だけの委員（viewer）は 403（タスクを登録できる人だけ）。
4. Bot は ask・doc と同じ枠（2 本）で実行する。`useSources` なら委員会の資料を探し（60 秒まで。失敗しても続ける）、/doc と同じ AI に指示文を渡して JSON を受け、コードで確かめて `result.draft` に書く（§9-3）。使用量は `assistant.taskdraft` で記帳する。Discord には投稿しない。
5. ブラウザは 2.5 秒ごとにジョブを読み、下書きを表に出す。委員は題・担当・副担当・期限・部局・内容を直し、起票しないものを外して「選んだ N 件を起票する」。アプリの既存のタスク作成（POST `/api/tasks/workspaces/<部局>/tasks`）で、親タスク→子タスク（`parentId`）の順に 1 件ずつ作る。行ごとに操作 ID を持つので、途中で失敗しても残りだけをやり直せ、同じ内容の再送で二重にならない。

### 9-2. ジョブの入力（アプリのサーバーが組み立てる）

```ts
{
  overview: string;            // 1..2000（改行可）
  deadline: string | null;     // 全体の期限の目安（YYYY-MM-DD）
  tags: string[];              // 部局のヒント（キー、0..5）。親タスクの下に作るときは、指定が無ければ親の部局
  parent: { id: string; title: string } | null;   // 既存の親の下に作るとき（新しい親は提案しない）
  useSources: boolean;
  roster: {                    // 担当の案に使ってよい人（0..80）。在籍中で、閲覧だけでない委員
    id: string;                // タスク API のユーザー ID（discord-<ID>）
    name: string;              // ..40
    departments: string[];     // 所属（Discord のロール × discord-auth.json の departmentRoleIds を部局キーにしたもの）
    lead: number; helper: number; overdue: number;   // 未完了の主担当・副担当・期限超過の件数
    history: string[];         // 担当したことのあるタスクの部局キー（完了も含む）
  }[];
  openTasks: { title: string; tags: string[]; assigneeId: string | null; deadline: string | null }[];   // 0..40。重ねて作らないため
}
```

- 連携口（`assistant_logic.taskdraft_input`）でも同じ規則で確かめる。名簿の外の担当は `openTasks` でも `null` にして送る。本文は連携口の上限（64 KB）に収まる。
- 指示文には ID を出さず、名簿の人を P1・P2… の番号で示す。AI の答えの番号を名簿で ID に戻す（名簿の外の番号・名前は使わない）。

### 9-3. 結果（`result.draft`）

```ts
interface TaskDraft {
  parent: TaskDraftItem | null;   // 2 件以上に分けたときの新しい親。既存の親の下・1 件だけのときは null
  items: TaskDraftItem[];         // 1..10
  notes: string;                  // Bot からの前提の一言
  questions: string[];            // 決めておくこと（..5）
  parentTask: { id: string; title: string } | null;
  sources: { label: string; excerpt: string }[];   // 参考にした資料（..4）
  model?: string;
}
interface TaskDraftItem {
  title: string; tags: string[]; deadline: string | null;   // 期限は今日〜1 年以内だけ（外れたら null）
  purpose: string; deliverable: string; completionCriteria: string; openQuestions: string;
  assigneeId: string | null; assigneeName: string | null;
  assigneeBy: 'ai' | 'rule' | null;   // AI が選んだ／AI が選ばず規則で選んだ／案なし
  assigneeFacts: string;              // コードが数えた事実「企画課｜主担当 2・副担当 1・期限超過 1」
  reason: string;
  helperIds: string[]; helperNames: string[];   // 副担当の案（..2、主担当と別の人）
  alternatives: { id: string; name: string; facts: string }[];   // ほかの候補（..3）
}
```

- 規則（`taskdraft_logic.rank_people`）：タスクの部局に所属する人（3）→ 部と課の関係（内務部の人と企画課のタスクなど、2）→ その部局の担当をしたことがある（1）の順。同じ近さなら持ち（主担当＋副担当、この下書きで割り当てた分を足す）の少ない順、期限超過の少ない順。同じ部の別の課（会計課とシステム課など）は近いとみなさない。近い人がいなければ担当の案は出さない。規則で選ぶときは、近い人がほかにいれば 1 人に 3 件以上まとめない。
- 電話番号・メールアドレス・口座番号は伏せ字にする（タスク候補と同じ）。
- アプリのサーバーは `taskdraft` のジョブにだけ `draft` を通し、形が違えば落とす（`browserDraft`）。画面は担当の案を、いまの委員の一覧にいる人のときだけ選んだ状態にする。

### 9-4. 機能の有無と古い版

- meta の `features.taskdraft`（Bot に /doc の AI があるとき true）。無い・false なら、画面に作り方の切り替えを出さない。古い Bot は taskdraft を受け付けない（400 `FEATURE_UNAVAILABLE`）。
- ジョブ表の `kind` の CHECK に taskdraft を足した。古い表は開いたときに作り直す（同じ列の表に写して入れ替える。`schema_version` は 1 のまま）。古い Bot・連携口もこの表を開けて今までどおり動くので、切り戻しでジョブ表を戻す必要はない。
- 権限：`assistant.taskdraft` は「書く（write）」（タスクの作成と同じ）。起票そのものはタスク API の権限で決まる。

### 9-5. 試験

- Bot：`bot/tests/test_taskdraft.py`（担当の順位、指示文に ID を出さないこと、出力の検証、ジョブ表の作り直し、Cog の実行と失敗）、`bot/tests/test_assistant_gateway.py` の `TaskDraftTests`（受け付け・入力の検査・本人だけが読めること）。
- アプリ：`app/tests/api/assistant-taskdraft.test.ts`（名簿と未完了のタスクの組み立て、閲覧だけの委員の拒否、draft の形の検査）、`app/tests/e2e/task-draft.spec.ts`（入力→待ち→確認・修正→親子の順に起票、既存の親の下、失敗、機能が無いとき、375px）。
