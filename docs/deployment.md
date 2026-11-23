# 配置

運用の構成で動かすときの考え方と、設定・鍵・バックアップ・GAS の置き方をまとめます。
委員会の実際の配置（ホスト・アドレス・アカウント・名簿・手順書）はこのリポジトリに入れていません。ここでは自分の環境に置き換えて読めるように、形だけを書きます。部品のつながりは [architecture.md](architecture.md)。

## 1. 置くもの

| 部品 | 置き場所の例 | 外への公開 |
|---|---|---|
| 統合アプリ（`app/`） | アプリ用のホストのコンテナ 1 つ | リバースプロキシの後ろ。コンテナのポートはホストに公開しない |
| リバースプロキシ | 同じホスト（Caddy・nginx など） | HTTPS だけ |
| IyakusaiBot・タスク API・登録（`bot/`） | Bot 用のホスト（常時動く小さな Linux 機でよい） | タスク API と登録の口は、統合アプリからだけ届くようにする（同じホストなら Docker の内部ネットワークから） |
| 収集（`collectors/`） | Bot 用のホスト | LINE の Webhook の受け口だけ、LINE から届くようにする |
| GAS | 委員会の Google アカウント | — |

アプリと Bot を別のホストに置くと、片方が止まってももう片方の機能を使えます。

1 台にまとめてもかまいません（VPS 1 台など）。そのときも、アプリと Bot は別のコンテナにし、外に出すのはリバースプロキシの HTTPS だけにして、タスク API・登録・LINE の受け口の取り込み用の口はホストの外へ公開しません。議事録の文字起こし（large-v3、CPU だけ）まで同じ機械で動かすなら、メモリは 8GB を目安にしてください（測定は [`app/deploy/minutes-worker/README.md`](../app/deploy/minutes-worker/README.md) の「6 コア・8GB の VPS で動かす」）。

## 2. 統合アプリのコンテナ

イメージは [`app/deploy/unified/Dockerfile`](../app/deploy/unified/Dockerfile) で作ります。イメージにはコードだけが入り、鍵・アカウント・名簿・台帳は入りません。

```sh
cd app
docker build -f deploy/unified/Dockerfile -t iyakusai-app:<タグ> .
```

compose の例（値はすべて例）：

```yaml
services:
  iyakusai-app:
    image: iyakusai-app:${IYAKUSAI_APP_TAG:?set the image tag}
    restart: unless-stopped
    user: "<UID>:<GID>"            # ホストの専用ユーザー。Dockerfile の USER と合わせる
    read_only: true
    tmpfs:
      - /tmp
    environment:
      SMM_AUTH_MODE: discord
      SMM_HOST: 0.0.0.0
      SMM_PORT: "5178"
      SMM_PUBLIC_ORIGIN: https://app.example.org
      SMM_TRUSTED_PROXY_ADDRESSES: ${PROXY_IP:?set the proxy address}
      SMM_STATIC_DIR: /app/dist/client
      SMM_DATA_FILE: /data/mail/state.json
      SMM_DISCORD_AUTH_CONFIG: /config/discord-auth.json
      SMM_TASK_SERVICE_URL: https://bot-host.example.internal:8443
      SMM_TASK_GATEWAY_KEY_FILE: /config/task-gateway.key
      SMM_TASK_LINK_FILE: /data/mail/task-links.json
      NODE_EXTRA_CA_CERTS: /config/bot-host-ca.crt
      SMM_RENTAL_DATA_DIR: /data/rental
      SMM_RENTAL_ITEM_ORIGIN: https://app.example.org
      SMM_RENTAL_WEB_DIR: /app/dist/rental-web
      SMM_MAIL_DIR: /data/mailbox
      SMM_MAIL_CONFIG: /config/mailbox.json
    volumes:
      - ./config:/config:ro
      - ./state:/data
      - ./backups:/backups
    networks:
      - proxy
    mem_limit: 1g
    pids_limit: 256
```

- コンテナは読み取り専用で、書くのは `/data`（状態）・`/backups`・`/tmp` だけ。
- `config/` は読み取り専用でつなぐ。中のファイルは所有者だけが読める権限（0600、フォルダは 0700）にする。
- ヘルスチェックは `GET /api/health`（Dockerfile に入っている）。

## 3. 環境変数（`SMM_AUTH_MODE=discord`）

| 変数 | 内容 |
|---|---|
| `SMM_AUTH_MODE` | `discord`（運用）。合成データ用の `demo` などは [`app/README.md`](../app/README.md) |
| `SMM_HOST`・`SMM_PORT` | 待ち受け。コンテナの中では `0.0.0.0` |
| `SMM_PUBLIC_ORIGIN` | 公開する `https://` のオリジン。`Host` と `Origin` はこれと一致しなければ断る |
| `SMM_TRUSTED_PROXY_ADDRESSES` | リバースプロキシの IP（カンマ区切り、完全一致）。ここから来た要求だけを受け付ける |
| `SMM_STATIC_DIR` | 画面のファイル（`dist/client`） |
| `SMM_DATA_FILE` | アプリの状態の JSON |
| `SMM_DISCORD_AUTH_CONFIG` | ログインの設定（§4） |
| `SMM_TASK_SERVICE_URL`・`SMM_TASK_GATEWAY_KEY_FILE` | タスク API の URL と、その経路の鍵。`discord` モードでは必須 |
| `SMM_TASK_LINK_FILE` | メールとタスクのつながりの記録 |
| `NODE_EXTRA_CA_CERTS` | Bot ホストが自前の CA で TLS を出すときの CA 証明書 |
| `SMM_RENTAL_DATA_DIR` | 物品の台帳（SQLite）と写真。無ければ物品の機能は無い |
| `SMM_RENTAL_ITEM_ORIGIN` | 物品のカード・QR に書く URL のオリジン（`<オリジン>/i/<個体コード>`）。一度カードを作ったら変えない |
| `SMM_RENTAL_WEB_DIR` | 物品画面のファイル（`dist/rental-web`） |
| `SMM_RENTAL_ALL_MEMBERS_ADMIN` | `true` で、委員全員に物品の管理の権限を付ける（既定 `false`） |
| `SMM_RENTAL_DRIVE_SYNC_KEY_FILE` | 物品の記録を Google ドライブへ複製する GAS の鍵（§6）。無ければ複製しない |
| `SMM_MAIL_DIR`・`SMM_MAIL_CONFIG` | 委員会のメールの保存先と設定（[mail.md](mail.md)）。2 つ一緒に設定する。連絡先・決定事項・団体の台帳・予定・入金確認・当日の画面・年度の切り替え・掲示板の保存ファイル（`*.sqlite3`、起動のときに作る）も `SMM_MAIL_DIR` に置く |
| `SMM_BOT_DATASOURCE_KEY_FILE` | Bot のデータソースの鍵（[contracts/bot-datasource.md](contracts/bot-datasource.md)）。無ければその口は無い |
| `SMM_CALENDAR_ICAL` | 予定の取り込み用 URL（iCal）。`on`・`off` のどちらかで、未設定なら demo だけ `on`、ほかは `off`。それ以外の値では起動しない。`on` にするときは、前段のプロキシで `/api/calendar/ical/<トークン>.ics` をブラウザ向けの認証の外で統合アプリへ通し、URL にトークンが入るので、プロキシのアクセスログの保存期間と見られる人を決める |
| `SMM_ASSISTANT_MODE` | `on` で Bot タブを使う（[contracts/bot-front.md](contracts/bot-front.md)）。既定 `off` |
| `SMM_TEMPORARY_STAFF_RANGE` | 当日だけの臨時スタッフの番号の範囲（`先頭-末尾`、8 桁ずつ、両端を含む）。実在の学籍番号と重ならない範囲を選ぶ。**アカウントのファイルに臨時スタッフがいるのに設定しないと、起動しない** |
| `SMM_TEMPORARY_STAFF_DISABLED` | `1` で臨時スタッフのログインを止める |

設定が足りない・矛盾しているときは、データを作らず・上書きせずに起動を断ります。

## 4. 設定ファイルと鍵

`config/` に置くもの（名前は例。環境変数と設定ファイルで場所を指す）：

| ファイル | 内容 |
|---|---|
| `discord-auth.json` | ログインの設定。下の例 |
| `names.json` | Discord の ID → 本名の名簿（任意）。画面とデータソースの名前に使う |
| `student-ids.json` | Discord の ID → 学籍番号の名簿（任意）。はじめから学籍番号でログインできるようにする |
| `mailbox.json` | 委員会のメールの設定（例は [`app/deploy/unified/mailbox.example.json`](../app/deploy/unified/mailbox.example.json)、説明は [mail.md](mail.md)） |
| `line.json` | LINE 公式アカウント（`mailbox.json` と同じフォルダ）。あれば LINE をメールの画面に出す。`send` とチャネルのアクセストークンが無ければ読むだけ。Bot からの返信（`discord`）は `"auth": "signed"`（svc-auth/v1、鍵 32 バイト以上）にする |
| `books-sheets.json` | 会計のマスターシート（`mailbox.json` と同じフォルダ。任意）。あれば帳簿の写しをスプレッドシートに書く。下の「会計のマスターシート」 |
| `books-sheets-key.json` | 上のサービスアカウントの JSON 鍵（名前は例。所有者だけが読める権限 600） |
| `availability.json` | 空き具合（委員の Google カレンダーの「予定あり」。`mailbox.json` と同じフォルダ。任意）。あれば設定 →「空き具合の共有」と、担当の欄・カレンダーの表示が出る。下の「空き具合」 |
| `availability-key.json` | 上のサービスアカウントの JSON 鍵（名前は例。会計のマスターシートと同じ鍵でもよい。権限 600） |
| `bank.json` | 銀行の連携（GMOあおぞらネット銀行 API。`mailbox.json` と同じフォルダ。任意）。あれば設定の画面から銀行とつなげる。下の「銀行の連携」 |
| `bank-client-secret`・`bank-token.key` | 上のクライアントシークレット（銀行の画面の値を 1 行）と、トークンを暗号化する鍵（32 バイト以上の乱数）。名前は例。どちらも権限 600 |
| `vault.json` | パスワード帳（`mailbox.json` と同じフォルダ。任意）。あれば設定 →「パスワード帳」が、区分のメンバーと権限管理者に出る。下の「パスワード帳」 |
| `vault.key` | 上の項目を暗号化する鍵（32 バイト以上の乱数。名前は例。権限 600。銀行のトークンの鍵とは別の値） |
| `site-editor.json` | Webサイトの編集（`mailbox.json` と同じフォルダ。任意）。あれば設定 →「Webサイト」が、名前の挙がった委員と権限管理者に出る。説明は [site-editor.md](site-editor.md) |
| `site-editor.key` | 上の編集サーバー（WebGenEngine）と共有する署名の鍵（32 バイト以上の乱数。名前は例。権限 600。ほかの鍵とは別の値） |
| `*.key` | 経路ごとの鍵。32 バイト以上の乱数 |
| `bot-host-ca.crt` | Bot ホストの CA 証明書 |

`discord-auth.json` の例：

```json
{
  "guildId": "100000000000000001",
  "bootstrapDiscordUserId": "100000000000000002",
  "excludedSharedDiscordUserIds": ["100000000000000003"],
  "adminDiscordUserIds": [],
  "adminRoleIds": [],
  "departmentRoleIds": { "100000000000000020": "総務部" },
  "registrationAudience": "https://app.example.org",
  "memberUrl": "https://bot-host.example.internal:8444/v1/discord/member",
  "registrationDmUrl": "https://bot-host.example.internal:8444/v1/dm/registration-code",
  "stateFile": "/data/accounts/accounts.json",
  "pepperFile": "/config/auth-pepper.key",
  "bridgeKeyFile": "/config/identity-bridge.key",
  "namesFile": "/config/names.json",
  "studentIdsFile": "/config/student-ids.json"
}
```

- `bootstrapDiscordUserId` は最初のマスター管理者（委員長）。マスター管理者は、設定 →「権限設定者」で権限設定者（権限の管理者）とほかのマスター管理者を選ぶ。選んだ内容は `stateFile` に保存され、一度変えたあとは `bootstrapDiscordUserId` の人も画面から外せる（マスター管理者は 0 人にできない）。`excludedSharedDiscordUserIds` は共用の PC などの個人でない Discord アカウントで、登録させない。
- `adminDiscordUserIds`・`adminRoleIds` に書いた人・ロールも権限設定者になる。画面からは外せないので、画面で選ぶ運用にするときは空にする。
- 知らない項目があると起動を断ります。ほかに `sessionDays`・`memberGraceHours`・`memberCacheMinutes` で、ログインの期間・Bot ホストに届かないときの猶予・参加の確認を使い回す時間を変えられます。

会計のマスターシート（[app/docs/books.md](../app/docs/books.md) §3）を使うとき：

1. Google Cloud でプロジェクトを作り、Google Sheets API を有効にする。サービスアカウントを作り、JSON の鍵を作って `config/` に置く（権限 600）。サービスアカウントにほかの権限は付けない。
2. 共有ドライブに空のスプレッドシートを作り、サービスアカウントのアドレス（`…@….iam.gserviceaccount.com`）を**編集者**として共有する。委員は閲覧者のままにする（基盤が書くタブは保護されるので、編集者の委員がいても書けない）。Workspace の設定で外部への共有を止めていると、サービスアカウントを足せないことがある。
3. `books-sheets.json` を置いてアプリを再起動する。起動すると最初の書き込みをし、以後は帳簿が変わるたびに書く。会計 →「科目と設定」で、最後に書けた時刻と失敗の種類を確かめられる。

```json
{
  "version": 1,
  "spreadsheetId": "スプレッドシートの URL の /d/ と /edit の間",
  "serviceAccountKeyFile": "/config/books-sheets-key.json",
  "tabPrefix": "",
  "debounceSeconds": 30
}
```

- 知らない項目があると、会計のスプレッドシートだけを無効にして起動する（帳簿は使える）。`tabPrefix` は基盤が作るタブの名前の前に付ける文字（既定はなし）、`debounceSeconds` は帳簿が変わってから書くまでの秒数（5〜3600）。
- 鍵の中身は `client_email` と `private_key` だけを読む。鍵をログ・画面・スプレッドシートに出さない。

空き具合（[app/docs/availability.md](../app/docs/availability.md)）を使うとき：

1. Google Cloud のプロジェクトで Google Calendar API を有効にする（会計のマスターシートと同じプロジェクト・同じサービスアカウントでよい）。サービスアカウントにほかの権限は付けない。
2. `availability.json` を置いてアプリを再起動する。委員は設定 →「空き具合の共有」で、自分のカレンダーをサービスアカウントのアドレスに「予定の表示（時間枠のみ、詳細は非表示）」で共有してからつなぐ。
3. アプリのコンテナから `oauth2.googleapis.com` と `www.googleapis.com` へ HTTPS で出られること（外への通信を絞っている環境では足す）。

```json
{
  "version": 1,
  "serviceAccountKeyFile": "/config/availability-key.json",
  "refreshMinutes": 15,
  "horizonDays": 42
}
```

- `refreshMinutes` は Google に問い合わせる間隔（5〜120 分）、`horizonDays` は今日から何日先まで読むか（7〜60 日）。知らない項目があると、空き具合だけを無効にして起動する（理由は起動のログ。鍵の中身は出さない）。
- 読み取りのスコープは `calendar.freebusy` だけ。Google から来るのは「予定あり」の時間帯だけで、題名・場所・メモは来ない。その時間帯はアプリのメモリにだけ置き、ファイルにもバックアップにも書かない。ファイル（`SMM_MAIL_DIR/availability.sqlite3`）にあるのは、委員ごとのカレンダー ID と、見せる相手・見せ方の選択だけ。

銀行の連携（[app/docs/bank.md](../app/docs/bank.md)）を使うとき：

1. 銀行の画面（いまは sunabar ポータル）でアカウントを足し、認可利用を ON、認証プロトコルは OAuth2.0、Redirect_uri は `https://<公開ホスト>/bank/callback`、スコープは `private:account` と `private:virtual-account` だけを ON にする。
2. 鉛筆アイコンで出るクライアントシークレットを、画面に出さずに `config/bank-client-secret` へ 1 行で保存し、権限を 600 にする。トークン用の鍵は `openssl rand -hex 32 > config/bank-token.key` で作り、同じく 600 にする（ほかの鍵と別の値）。
3. `bank.json` を置いてアプリを再起動する（例は [`app/deploy/unified/bank.example.json`](../app/deploy/unified/bank.example.json)）。設定 →「銀行の連携」で権限管理者が「銀行と接続する」を押す。

- 銀行の URL は設定に書かない（コードで固定。設定を書き換えてもシークレットやトークンをほかへ送れない）。`environment` はいまは `sunabar` だけを受け付ける。
- 振込のスコープを書くと、銀行の連携だけを無効にして起動する（ほかは動く）。理由は起動のログに出る（シークレットは出さない）。
- トークンは `SMM_MAIL_DIR/bank-tokens.json` に暗号化して置く。バックアップには入れない（復元したら設定の画面からつなぎ直す）。

パスワード帳（[app/docs/vault.md](../app/docs/vault.md)）を使うとき：

1. 鍵を `openssl rand -hex 32 > config/vault.key` で作り、権限を 600 にする（ほかの鍵と別の値。メールの取り込みの鍵か銀行のトークンの鍵と同じ値だと、パスワード帳だけを無効にして起動する）。
2. `vault.json` を置いてアプリを再起動する（例は [`app/deploy/unified/vault.example.json`](../app/deploy/unified/vault.example.json)）。権限管理者が設定 →「パスワード帳」で区分を作り、見られる部局と人を付ける。

- 項目は `SMM_MAIL_DIR/vault.sqlite3` に暗号化して置く（名前・URL・ID も暗号化）。アプリのバックアップはこのファイルを写すが、鍵は写さない。鍵を失うと項目は開けない（紙の控えから入れ直す）。
- 鍵と `vault.sqlite3` が一緒に写った写し（設定フォルダごとのバックアップ、ホストを移すときの写し）からは中身が読める。設定フォルダの写しの置き場所も、パスワード帳と同じ扱いにする。
- 鍵がサーバーにあるので、サーバーを乗っ取られると中身はすべて読める。
- `revealMinutes` は、その端末でパスワードを入れてから項目を開ける分数（1〜60、既定 10）。知らない項目があると、パスワード帳だけを無効にして起動する。

鍵の決まり：

- 経路ごとに別の鍵にする（ペッパー・Bot ホストの登録・タスク連携・メールの取り込み・物品の複製・Bot のデータソース）。同じ値があると起動を断ります。
- 作るときは、例えば `openssl rand -hex 32` を直接ファイルへ書き、画面に出さない。相手のホストや GAS へは 1 回だけ安全な経路で写す。
- 鍵・名簿・アカウントのファイルを Git・共有のドライブ・チャットに置かない。

## 5. バックアップと戻し方

動いたままバックアップを取れます（コンテナの中で実行）：

```sh
docker exec <コンテナ名> node dist/server/ops/backup.js
```

`/backups/iyakusai-app-<UTC の時刻>/` に、状態の JSON・物品の台帳・メール・連絡先・決定事項・団体の台帳・予定・入金確認・当日の画面・年度の切り替え・掲示板・空き具合の設定（予定ありの時間帯は含まない）・会計の帳簿（SQLite のオンラインバックアップ）・それらが指す写真と添付と領収書（記録の SHA-256 と照合したもの）・`manifest.json` を書きます。何も消しません。毎日など定期的に動かしてください。

戻すとき：コンテナを止め、バックアップのフォルダの中身を `/data` に当たるフォルダへ写し戻してから起動します。

## 6. GAS の設置

GAS は 3 つあります。どれも Gmail・ドライブに対して読むか作るだけで、上書き・削除はしません。鍵は「プロジェクトの設定 → スクリプト プロパティ」に置き、コードやシートに書きません。

| スクリプト | 置くアカウント | スクリプト プロパティ | 役目 |
|---|---|---|---|
| [`app/deploy/unified/gas/send_mail_to_app.gs`](../app/deploy/unified/gas/send_mail_to_app.gs) | 委員会の共用アカウント（新着）。過去の分は別のアカウントで 1 回だけ | `INGEST_KEY`（`mailbox.json` の `ingestKeyFile` と同じ値） | Gmail のメールを 1 通ずつ統合アプリの `/v1/mail/ingest` へ送る |
| [`app/deploy/unified/gas/sync_rental_to_drive.gs`](../app/deploy/unified/gas/sync_rental_to_drive.gs) | ドライブに書けるアカウント。**1 つのプロジェクトにだけ**置く | `RENTAL_SYNC_KEY`（`SMM_RENTAL_DRIVE_SYNC_KEY_FILE` と同じ値） | 物品の写真・記録・状況の一覧を、統合アプリから署名付きで取ってドライブに作る |
| [`gas/mail/collect_mail.gs`](../gas/mail/collect_mail.gs) | 委員会の共用アカウント | `RAW_FOLDER_ID`・`ATT_FOLDER_ID` | メールを月ごとの JSONL としてドライブに保存する（Bot の資料の検索用） |

手順：

1. Apps Script のプロジェクトを作り、スクリプトを貼る。冒頭の「設定」の値（アプリの URL・保存先のフォルダの ID・送り込みの種類など）を自分のものにする。
2. スクリプト プロパティに鍵やフォルダの ID を入れる。
3. 一度だけ手で実行して、権限を許可する。
4. 時間主導のトリガーを付ける。どのスクリプトにも、間隔の設定（`TRIGGER_MINUTES`）と、トリガーを作る関数 `installTrigger` がある。
5. 統合アプリの側で鍵の環境変数（または `mailbox.json`）を設定して入れ替え、取り込み・複製が進むことを確かめる。

止めるときは、トリガーを消します。

## 7. 更新と切り戻し

運用に入れる版は、いつも main のコミットから作ります。作業の枝・手元の作業ツリー・ビルド済みのファイルへの差し替えからは作りません。運用中のファイルを直接直すこともしません（直したいときは main への PR にする）。

1. 変更を main への PR にし、CI（`.github/workflows/ci.yml`）が通ってからマージする。CI は lint・型検査・ビルド・試験（既知の失敗は `app/tests/known-failures.json`）と、イメージのビルドと起動を確かめる。
2. 入れる main のコミットを決め、そのコミットからイメージを作る。タグは `<日付>-<コミットの先頭 12 文字>` にする。古いイメージは消さない（戻すために使う）。

   ```sh
   git clone https://github.com/MasterMk2/iyakusai-platform.git && cd iyakusai-platform
   git checkout <コミット>
   cd app
   docker build -f deploy/unified/Dockerfile --build-arg GIT_COMMIT="$(git rev-parse HEAD)" -t iyakusai-app:<日付>-<コミットの先頭 12 文字> .
   ```

   作ったコミットは、イメージのラベル `org.opencontainers.image.revision` に入る。動いている版のコミットは `docker inspect -f '{{ index .Config.Labels "org.opencontainers.image.revision" }}' <コンテナ名>` で確かめる。
3. compose のタグを変えて `docker compose up -d`。
4. コンテナが healthy になること、ログインできること、物品の画面が開くことを確かめる。healthy にならず再起動を繰り返すときは、すぐに前のタグへ戻してから原因を調べる。
5. データの形が変わる更新では、先に §5 のバックアップを取る。
6. 前の版へ戻すときは、Bot の `config.toml` の `[kiban]` の `sources` に、戻す先の版が知らない値（例：`"decisions"`）が無いかを先に見る。あれば外して Bot を再起動してから戻す。統合アプリは知らない `sources` を 401 で断るので、残したまま戻すと、物品・受信箱の写しまで Bot に届かなくなる。新しい保存ファイルは前の版では使われないが、消さずに残せば、もう一度新しい版にしたときにそのまま使える。

物品画面のファイルを変えた更新では、Service Worker のキャッシュの名前を新しくしてください。古い画面が端末に残ります。

## 8. Bot ホスト

- **IyakusaiBot**：`config.example.toml` を `config.toml` に写して値を入れ、Discord の Bot のトークンをファイルで渡して起動する（[`bot/README.md`](../bot/README.md)）。委員会の正式な名前・キャンパス・伏せずに残す学校の事務のメールドメインは `[org]` に書く（書かないと、AI への指示文とメールの署名が既定の名前になり、学校の事務のアドレスも伏せられる）。
- **タスク API**（`bot/gateway/`）：`site.example.json` を写した `site.json`（0600）に待ち受けと接続元を書く。TLS の証明書と、アプリとの経路の鍵を置く。Bot と同じタスク DB を読む。
- **登録**（`bot/registration/`）：`site.example.json` を写した `site.json` に値を書く。Bot の起動のときに読み込まれる。
- **収集**（`collectors/`）：systemd のユニットの例が `collectors/line-oa/systemd/` にある（[`collectors/README.md`](../collectors/README.md)）。
- ホストの時刻を NTP で合わせる（署名の時刻のずれは 30 秒まで）。

## 9. ホストを移すとき

運用中のホストから別のホストへ、データごと移したときに分かった注意です（§1 の 1 台にまとめる形のまま、別の Linux の VPS へ移した）。

移す前：

- 利用者の UID・GID は前のホストと同じにする。コンテナの `user:`（§2）とファイルの持ち主がそのまま使える。
- 利用者名や家のパスを変えるときは、Python の venv と `.pyc` は運ばずに作り直す（中に元のパスが入っている）。設定ファイルに書いた絶対パスは読み替え、元の名前が残っていないことを数えて確かめる。
- イメージを `docker save`・`docker load` で運び、イメージの ID で照らすなら、両方のホストで Docker のストレージドライバーを揃える。揃っていないと ID が合わなかった。
- コンテナのメモリの上限（`--memory`）は、前のホストの値をそのまま使わない。小さいホストへ移したら、上限がホストのメモリ全部と同じになっていた。常駐の分と文字起こしの分を分けて抑え、片方が使い切ってももう片方を巻き込まないようにする（文字起こしの目安は [`app/deploy/minutes-worker/README.md`](../app/deploy/minutes-worker/README.md)）。
- 議事録の文字起こしのユニットの例（`app/deploy/minutes-worker/iyakusai-minutes-transcribe.service`）は `/usr/local/bin/docker` を呼ぶ。Docker の入れ方によってはそこに無いので、リンクを作るかユニットを直す。
- ホストのファイアウォール（ufw など）は、Docker が公開したポートを止めない。リバースプロキシ以外のポートは公開しない（§1）。
- リバースプロキシの証明書のデータも運ぶと、DNS を向ける前から新しいホストで HTTPS が通る。DNS が届けば、プロキシが自分で更新する。

番地が変わるとき（Docker のネットワークの範囲を変えたときなど）：

- 設定の文字列を読み替えるだけでは直らないものがある。タスク API と登録の口の TLS 証明書の宛先（subjectAltName）には、統合アプリが呼ぶ URL（`SMM_TASK_SERVICE_URL`、`discord-auth.json` の `memberUrl`・`registrationDmUrl`）のホスト部が入っていなければならない。番地で呼んでいるなら、番地が変わったら同じ CA で証明書を作り直し、タスク API と Bot を再起動する（登録の口は Bot の起動のときに証明書を読む）。合わないと、アプリのタスクの画面と、Discord の委員の照合（メール・公式LINE の画面の Discord との連携など）がつながらない。アプリのログには `ERR_TLS_CERT_ALTNAME_INVALID` と出る。
- 公式LINE の受け口の `pull_allowed_clients` を、新しい範囲とゲートウェイの番地に直す（[`collectors/README.md`](../collectors/README.md) の「LINE 公式アカウントの受信」）。
- コンテナの `--add-host` やホストの `/etc/hosts` で公開の名前を固定しているなら、新しい番地に直す。ホストで動く処理（議事録の要約など）は、DNS を切り替える前だと前のホストへ行ってしまうので、移す先のリバースプロキシへ固定しておく。

切り替え：

- 議事録の文字起こしの途中や、録音の送信の途中でないときに切り替える。
- 前のホストを止めてから最後の写しを取る。止めたあとの写しでは、どのサービスも止まった状態に見えるので、新しいホストで起こすサービスは、止める前に控えておく。
- DNS は、管理画面に出る TTL と、権威サーバーが実際に答える TTL が違うことがあった（60 秒の設定で、片方のサーバーが 3600 秒で答えた）。`dig` でサーバーごとに確かめ、古い向け先に届く人が残る時間を見込む。
- 移したら、一度再起動して確かめる。資料のドライブを rclone でマウントしていると、再起動のあとに制御用のソケットのファイルが残って、マウントが上がらず、マウントに頼る Bot も起動しなかった。起動の前に残ったソケットを消すようにする。
