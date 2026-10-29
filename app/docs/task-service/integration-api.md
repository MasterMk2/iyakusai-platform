# 保護モードの統合 API と Discord 連携契約

委員会タスク管理を、共通 Web（shared-mail-manager）と Discord の両方から使うための **唯一のタスク保存先** として動かす
`DTM_MODE=protected` の仕様。Web と Discord は同じ `TaskService` の操作・タスク ID・版・委員会権限・変更履歴・操作 ID を使う。

## 状態の区別

| 対象 | 状態 |
| --- | --- |
| 保護モードの内部 API（署名付き要求のみ） | 実装済み・合成データで検証（共通 Web との統合テストを含む） |
| Discord コマンドの契約（guild/channel → 委員会、Discord 利用者 → 内部利用者） | 実装済み。模擬送信（`dist/server/tools/mockDiscord.js`）とテストで確認 |
| 実際の Discord Bot・Gateway 接続・DM・送信 | **未接続**。既存 Bot 側の連携は運用者が提供する非秘密の契約（本書）に従って実装する |
| 従来のデモ（`DTM_MODE` 未指定） | 変更なし。模擬ログイン・模擬 Bot・障害注入・初期化はデモ専用 |

## 起動（保護モード）

すべて必須（Discord 連携は 2 項目をそろえた場合だけ有効）。不足・不正なら起動を拒否し、デモへ切り替えない。
保存ファイルがない・読めない・形式が違う場合も、見本データの作成や退避をせずに停止する。

| 環境変数 | 内容 |
| --- | --- |
| `DTM_MODE=protected` | 保護モード |
| `HOST`、`PORT` | 待受。既定はループバック（`127.0.0.1` または `::1`）だけ。それ以外は下記「通信路」の確認値があり、私設ネットワークのアドレスの場合だけ（`0.0.0.0` / `::` は常に不可） |
| `DTM_DATA_FILE` | 既存のタスク状態ファイル（運用者が用意。試用は `dist/server/tools/initSyntheticState.js` で架空データを作れる） |
| `DTM_TRUSTED_CLIENT_ADDRESSES` | 接続を許可する送信元ソケット。単一 IP の列挙。ループバック待受では `127.0.0.1` / `::1` だけ（共通 Web と連携 Bot を同じホストに置く）。ループバック以外では TLS 終端のアドレス（私設ネットワーク）だけ |
| `DTM_NON_LOOPBACK_TRANSPORT_ACK` | 任意・秘密ではない。ループバック以外で待ち受ける場合だけ、`operator-tls-termination-for-gateway-and-discord-bridge` を指定する（下記の前提を運用者が確認した印）。値の違い・ループバック待受での指定は起動を拒否 |
| `DTM_GATEWAY_KEY_FILE` | 共通 Web ゲートウェイ用の鍵ファイル（32 バイト以上の乱数、16 進または base64、POSIX では権限 600） |
| `DTM_DISCORD_BRIDGE_KEY_FILE`、`DTM_DISCORD_BINDINGS_FILE` | Discord 連携 Bot 用の別の鍵と、対応表（下記） |

テンプレート: [`deploy/task-service/protected.env.example`](../deploy/task-service/protected.env.example)。架空の対応表: [`deploy/task-service/discord-bindings.synthetic.json`](../deploy/task-service/discord-bindings.synthetic.json)（試用・テスト専用）。

保護モードに存在するのは `GET /api/health`（`{"ok":true}`）と `/api/integration/v1/*` だけ。画面配信、模擬ログイン（`X-Demo-User`）、
人物一覧、模擬 Bot、障害注入、初期化はない。

## 署名（svc-auth/v1）

すべての `/api/integration/v1/*` 要求に次のヘッダーを付ける。

| ヘッダー | 内容 |
| --- | --- |
| `X-Svc-Client` | `web-gateway` または `discord-bridge` |
| `X-Svc-Timestamp` | 送信時刻（エポックミリ秒）。±30 秒を超えると拒否 |
| `X-Svc-Nonce` | 22〜64 文字の base64url。同じクライアントで再利用すると拒否 |
| `X-Svc-Actor` | `web-gateway` だけ: 操作する内部利用者 ID（共通 Web が認証済み本人から対応付けたもの）。`discord-bridge` は付けない |
| `X-Svc-Signature` | HMAC-SHA256（クライアントの鍵）の 16 進。対象は `svc-auth/v1`・クライアント ID・メソッド・クエリ込みのパス・時刻・ノンス・actor・本文の SHA-256（16 進）を改行で連結した文字列 |

署名の不一致・欠落・時刻ずれ・再利用は 401。クライアントの鍵が違えば別の利用者として振る舞えない（ゲートウェイ鍵で Discord の入口は使えず、その逆も不可）。

## ゲートウェイ用エンドポイント（`X-Svc-Client: web-gateway`）

| メソッド・パス | 内容 |
| --- | --- |
| `GET /me` | 操作者の表示名と有効な所属（委員会・役割） |
| `GET /workspaces/:workspaceId/tasks?status&assignee&deadline` | 一覧（従来の絞り込み） |
| `POST /workspaces/:workspaceId/tasks` | 作成。`operationId` 必須（同じ操作 ID・同じ内容は再実行せず同じタスク、内容が違えば 409） |
| `GET /tasks/:taskId`、`GET /tasks/:taskId/history` | 取得・履歴（所属外は存在しない場合と同じ 404） |
| `PATCH /tasks/:taskId` | `{ expectedVersion, operationId?, changes }`。版が違えば 409 `VERSION_CONFLICT` |
| `POST /tasks/:taskId/reopen` | `{ expectedVersion, operationId? }` |
| `GET /workspaces/:workspaceId/members` | 担当候補（メールアドレスは返さない） |

権限・担当者（同じ委員会の有効なメンバーだけ）・版・履歴の規則は従来の `TaskService` と同じ。履歴の入口は `web`（共通 Web）と `discord` を区別する。

## Discord コマンド（`X-Svc-Client: discord-bridge`）

`POST /api/integration/v1/discord/commands`

```json
{ "interactionId": "<Discord interaction ID>", "guildId": "<guild ID>", "channelId": "<channel ID>", "userId": "<操作者の Discord 利用者 ID>",
  "command": { "name": "status", "taskId": "task-1", "to": "in_progress", "version": 3 } }
```

- 連携 Bot は Discord が検証した interaction の数値 ID だけを送る（表示名・ニックネームは使わない）。
- `command.name`: `list`（`status`、`assignee`）、`show`、`create`（`title`、`assignee`、`deadline`）、`assign`（`assignee`: `me` / `none` / Discord 利用者 ID）、
  `status`（`to`）、`deadline`（`date` または null）、`require`（`field`: purpose / deliverable / completionCriteria / openQuestions、`text`）、`reopen`。
- 既存タスクを変更する `assign`・`status`・`deadline`・`require`・`reopen` は **`version`（表示中の版、1 以上の整数）が必須**。
  Web の `expectedVersion` と同じ版付きの操作を通り、版が古ければ 409 `VERSION_CONFLICT`（最新の状態は再取得してから送り直す）。
  省略・数値以外・小数・0 以下・安全な整数の範囲外は、どれも同じ 400 `VALIDATION`（`command.version`）になり、タスクを読む前に拒否する
  （タスクの内容や存否は返さず、変更も履歴も残らない。その interaction ID も消費しない）。`list`・`show`・`create` は版を使わない。
- 従来のデモ専用の模擬 Bot（`DTM_MODE` 未指定の画面内の模擬チャンネル、`version:N` は任意）は保護モードに存在せず、この契約とは別物。
  版を省略した模擬 Bot の変更が最新版に適用されるのは、デモの合成データの中だけ。
- 対応表にない guild/channel・利用者は、どれが欠けているかを区別せず 403。チャンネルに対応する委員会のタスクだけを扱う（他の委員会のタスクは 404）。
- `interactionId` を操作 ID として再配信を判定する。指紋には guild/channel を含むため、同じ ID の別チャンネルからの再送は 409 で拒否し、
  他チャンネルのタスクは返さない。同じチャンネルの再配信は再実行せず `replayed: true`。
- 応答 `{ ok, replayed, reply, task? , tasks? }`。`reply` は日本語の返信文。エラーは `{ error: { code, message } }`。

### 対応表（`DTM_DISCORD_BINDINGS_FILE`）

```json
{ "version": 1,
  "guilds": [{ "guildId": "<guild ID>", "channels": [{ "channelId": "<channel ID>", "workspaceId": "<委員会 ID>" }] }],
  "users": [{ "discordUserId": "<確認済みの Discord 利用者 ID>", "userId": "<内部利用者 ID>" }] }
```

チャンネルは 1 委員会だけに対応し、利用者は 1 対 1。存在しない委員会・利用者を指す対応表では起動しない。実際の値は運用者が確認済みの名簿から作り、Git に入れない。

## 模擬送信（試用・テスト専用）

```sh
node dist/server/tools/mockDiscord.js http://127.0.0.1:<PORT> <連携鍵ファイル> '<上記の JSON>'
```

ループバックの Task API にだけ送れる。実際の Discord には接続せず、Bot トークンも使わない。変更コマンドには上記のとおり現在の `version` を入れる。

## 通信路（ゲートウェイと連携 Bot の両方）

svc-auth/v1 の署名は **要求** の改ざん・なりすまし・再送を防ぐだけで、通信路の暗号化ではない。**応答**（タスクの内容・履歴・担当者・返信文）は
暗号化も署名もされない。そのため Task API への接続は、共通 Web のゲートウェイと Discord 連携 Bot の **どちらも** 次のどちらかに限る。

1. **同じホストのループバック（既定・推奨）**: `HOST=127.0.0.1`（または `::1`）、`DTM_TRUSTED_CLIENT_ADDRESSES` は `127.0.0.1` / `::1` だけ。
   ゲートウェイは `http://127.0.0.1:<PORT>`、連携 Bot も同じホストから `http://127.0.0.1:<PORT>` に送る。
   ループバック以外の送信元を許可する設定は起動を拒否する（Bot を別ホストから平文で接続させない）。
2. **運用者の TLS 終端の背後（明示的な確認が必要）**: `DTM_NON_LOOPBACK_TRANSPORT_ACK=operator-tls-termination-for-gateway-and-discord-bridge`
   を指定した場合だけ、私設ネットワーク（10/8、172.16/12、192.168/16、fc00::/7）の `HOST` で待ち受けられる。この値は次の前提をすべて
   運用者が確認したことを表す（アプリはこれらを確認できない）。
   - ゲートウェイと連携 Bot は、どちらも TLS 終端に `https://` で接続し、証明書を通常どおり検証する（検証の無効化・自己署名の無条件許可をしない）。
     Task API に平文で直接接続する経路は残さない。
   - `DTM_TRUSTED_CLIENT_ADDRESSES` には **TLS 終端が Task API へ接続するときの送信元アドレスだけ** を書く（私設ネットワークのみ。
     ゲートウェイや Bot 自体のアドレス、ループバック、公開アドレスは書かない／書くと起動を拒否）。
   - TLS 終端から Task API までの平文区間は、運用者が管理する単一の私設ネットワーク内にあり、ほかの利用者・テナントの機器から
     盗聴・なりすましできない（ホストのファイアウォールで `PORT` への接続を TLS 終端だけに絞る）。
   - TLS 終端は要求ヘッダー（`X-Svc-*`）と本文を変えずに転送し、応答をキャッシュしない。

公開アドレス・リンクローカル・`127.0.0.1` 以外のループバックでの待受、確認値の欠落・不一致は、どれも起動を拒否する（エラーにアドレスは含めない）。
このリポジトリでは証明書の作成・設置、プロキシや TLS 終端の設定、実ホストへの接続は行っていない。統合テスト（`npm run test:cross`）と試用はループバックだけを使う。

## 単一プロセスと保存

状態全体（タスク・版・履歴・操作記録・メンバー）を 1 つの JSON 文書として置き換え保存する。1 回の変更はこの文書の 1 回の
置き換えで確定するため、タスクの版・履歴・操作 ID の記録が別々に確定することはない。データ形式は従来どおりで、移行・初期化・
自動の退避はしない。

### 保存の手順と応答の時点

`src/server/storage/fileStore.ts`。成功の応答を返すのは、次をすべて終えてから。

1. 同じディレクトリに一意な名前の一時ファイル `.<ファイル名>.<pid>.<UUID>.tmp` を排他作成する（同名のファイルやリンクを再利用・追従しない。POSIX では権限 600）。
2. 全体を書き込み、fsync してから閉じる。
3. rename で保存ファイルを置き換える（EPERM・EACCES・EBUSY のときは数回再試行。主に Windows で一時的に置き換えられない場合のため）。
4. POSIX では親ディレクトリを fsync する（rename 自体を確定させる）。
5. メモリ上の状態を新しい内容に切り替え、応答する。

起動時と読み直しのときも、POSIX では保存ファイルとディレクトリを fsync してから内容を使う（前回のプロセスが 3 と 4 の間で止まっていても、
確定させてから使う）。

### 失敗したときの結果

| 失敗した段階 | 保存ファイル | 応答 | その後 |
| --- | --- | --- | --- |
| 1〜3（一時ファイルの作成・書込・fsync・close、rename） | 前の内容のまま。この保存が作った一時ファイルだけを消す | 503 `SAVE_FAILED`（変更は反映されていない） | メモリも前のまま。同じ操作 ID で再試行すると 1 回だけ適用される |
| 4（rename 後のディレクトリ fsync） | 新しい内容が見えているが、電源断の後に残るかは不明 | 503 `SAVE_FAILED`（反映されたかどうかは確定していない） | 古いメモリ上の状態は使わず、次の読み取り・変更の前に保存ファイルを読み直す（上の fsync を含む）。読み直せない間は読み取り・変更とも 503 `LOAD_FAILED` で、ファイルを書き換えない。同じ操作 ID で再送すると、反映済みなら重複せずに現在の内容を返し（`replayed: true`）、未反映なら 1 回だけ適用される |
| 保存の直前に、保存ファイルが最後の読み込み・保存の後に変わっていたと分かった | 書き込まない | 503 `SAVE_FAILED`（他の処理で変更されていた） | 次の操作の前に読み直し、版（`expectedVersion`）で判断し直す。古い状態で上書きしない |

応答を受け取れなかった操作（タイムアウト・切断・再起動）は、同じ操作 ID で再送する。操作記録はタスク・履歴と同じ文書にあるため、
再起動後も重複しない（記録は最新 2000 件まで）。ゲートウェイの作成要求は操作 ID が必須。古い版を前提にした別の操作 ID の変更は
`VERSION_CONFLICT` になる。

### プラットフォームの境界

- **POSIX（Linux のローカルファイルシステム。ext4・XFS などディレクトリの fsync に対応するもの）**: 上の手順をすべて行う。応答した変更は、
  ディスク・ファイルシステム・仮想化層が fsync を正しく扱う限り、電源断の後も残る（書き込みキャッシュを偽る装置はアプリでは検出できない）。
  ディレクトリの fsync に対応しないファイルシステム（一部のネットワーク共有など）では、保存も起動時の読み込みも失敗する（安全側に止まる）。
- **Windows**: Node からディレクトリを fsync できないため手順 4 を行わない。ファイルの内容は rename 前に fsync するので保存ファイルは旧版か
  新版のどちらかだが、電源断の直後に、直前に応答した保存が失われうる。保護モードの起動ログにもそう表示する。電源断に対する永続性が
  必要な運用は POSIX で行う。共通 Web の保存ファイルにも同じ Windows の制限がある（別に記載）。
- 確認の範囲: テストは各段階での errno の注入、POSIX の手順の順序と応答の時点の記録（このリポジトリの検査は Windows 上で実行するため、
  POSIX の fsync は呼び出し順として確認し、実際の POSIX ホストでは実行していない）、テストが起動した子プロセスの段階ごとの強制終了と
  別プロセスでの再起動・再送（`tests/unit/fileStoreFaults.test.ts`・`taskServiceCommit.test.ts`・`fileStoreCrash.test.ts`）。
  プロセスの強制終了では OS のキャッシュが残るため電源断とは異なり、実機での電源断は試していない。

### 単一書込者・権限・残った一時ファイル

- 同じ保存ファイルを書くのは 1 プロセスだけ（2 つ目のプロセス、複数台・複数レプリカでの書込には対応しない）。同じプロセス内では
  同じファイルへの読み書きを 1 件ずつ行い、変更は版で判断する。
- 保存の直前に、最後に読み込み・保存したファイル（デバイス・i ノード・サイズ）と比べ、違えば上書きしない（上の表）。読み込む前の保存も
  しない。これはプロセス間の排他ではなく、確認から置き換えまでの間の変更は検出できない。
- 保存ファイルがシンボリックリンクや通常のファイル以外なら、読み込み・保存とも拒否する。読めない・形式が違う・途中で切れたファイルは、
  保護モードでは変更せずに起動を拒否する（デモモードだけが退避してサンプルデータで起動する）。
- 置き換え後の保存ファイルは一時ファイルの権限になる（POSIX では 600、所有者はサービス利用者）。運用者が別の権限を付けていても、
  最初の保存で 600 になる。バックアップはサービス利用者（または管理者）の権限で取得する。
- 親ディレクトリの権限はアプリが変更しない（無い場合だけ 700 で作る）。運用者がサービス利用者だけが書けるように用意する
  （他の利用者が書けるディレクトリでは、ファイルの差し替えや削除を防げない）。
- 異常終了で残った `.<ファイル名>.<pid>.<UUID>.tmp` は、再起動後も消さない（保存処理は自分が作った一時ファイルだけを消す）。
  サービスの停止中に、保存ファイルが読めることを確かめてから削除してよい。

### バックアップと復元

- Task サービスの停止中に、共通 Web の関連付けファイルと同じ時点で取得する（[配置](../../../docs/deployment.md) §5）。
  稼働中にコピーしたファイルは、その後に応答した変更を含まない。
- 復元は停止中にファイルを置き換え、起動して読み込めること、共通 Web の関連付けと整合することを確認する。復元時点より後の変更と
  操作記録は失われるため、その後の同じ操作 ID の再送は新しい操作として適用される。

## 未決事項

既存 Bot での実装（interaction の検証、コマンド定義、返信）、実際の guild/channel と委員会の対応、Discord 利用者と内部利用者の確認済み対応、
連携 Bot の配置と送信元アドレス、鍵の保管、運用中の対応表の更新手順。
