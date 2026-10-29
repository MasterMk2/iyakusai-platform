# 配置

運用の構成で動かすときの考え方と、設定・鍵・バックアップ・GAS の置き方をまとめます。
委員会の実際の配置（ホスト・アドレス・アカウント・名簿・手順書）はこのリポジトリに入れていません。ここでは自分の環境に置き換えて読めるように、形だけを書きます。部品のつながりは [architecture.md](architecture.md)。

## 1. 置くもの

| 部品 | 置き場所の例 | 外への公開 |
|---|---|---|
| 統合アプリ（`app/`） | アプリ用のホストのコンテナ 1 つ | リバースプロキシの後ろ。コンテナのポートはホストに公開しない |
| リバースプロキシ | 同じホスト（Caddy・nginx など） | HTTPS だけ |
| IyakusaiBot・タスク API・登録（`bot/`） | Bot 用のホスト（常時動く小さな Linux 機でよい） | タスク API と登録の口は、アプリのホストからだけ届くようにする |
| 収集（`collectors/`） | Bot 用のホスト | LINE の Webhook の受け口だけ、LINE から届くようにする |
| GAS | 委員会の Google アカウント | — |

アプリと Bot を別のホストに置くと、片方が止まってももう片方の機能を使えます。

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
| `SMM_MAIL_DIR`・`SMM_MAIL_CONFIG` | 委員会のメールの保存先と設定（[mail.md](mail.md)）。2 つ一緒に設定する。連絡先も `SMM_MAIL_DIR` に保存する |
| `SMM_BOT_DATASOURCE_KEY_FILE` | Bot のデータソースの鍵（[contracts/bot-datasource.md](contracts/bot-datasource.md)）。無ければその口は無い |
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
| `line.json` | LINE 公式アカウント（`mailbox.json` と同じフォルダ）。あれば LINE をメールの画面に出す。`send` とチャネルのアクセストークンが無ければ読むだけ |
| `*.key` | 経路ごとの鍵。32 バイト以上の乱数 |
| `bot-host-ca.crt` | Bot ホストの CA 証明書 |

`discord-auth.json` の例：

```json
{
  "guildId": "100000000000000001",
  "bootstrapDiscordUserId": "100000000000000002",
  "excludedSharedDiscordUserIds": ["100000000000000003"],
  "adminDiscordUserIds": [],
  "adminRoleIds": ["100000000000000010"],
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

- `bootstrapDiscordUserId` は最初のアカウント（いつも権限の管理者）。`excludedSharedDiscordUserIds` は共用の PC などの個人でない Discord アカウントで、登録させない。
- 知らない項目があると起動を断ります。ほかに `sessionDays`・`memberGraceHours`・`memberCacheMinutes` で、ログインの期間・Bot ホストに届かないときの猶予・参加の確認を使い回す時間を変えられます。

鍵の決まり：

- 経路ごとに別の鍵にする（ペッパー・Bot ホストの登録・タスク連携・メールの取り込み・物品の複製・Bot のデータソース）。同じ値があると起動を断ります。
- 作るときは、例えば `openssl rand -hex 32` を直接ファイルへ書き、画面に出さない。相手のホストや GAS へは 1 回だけ安全な経路で写す。
- 鍵・名簿・アカウントのファイルを Git・共有のドライブ・チャットに置かない。

## 5. バックアップと戻し方

動いたままバックアップを取れます（コンテナの中で実行）：

```sh
docker exec <コンテナ名> node dist/server/ops/backup.js
```

`/backups/iyakusai-app-<UTC の時刻>/` に、状態の JSON・物品の台帳・メール・連絡先（SQLite のオンラインバックアップ）・それらが指す写真と添付（記録の SHA-256 と照合したもの）・`manifest.json` を書きます。何も消しません。毎日など定期的に動かしてください。

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

1. 手元で `npm run check`（[getting-started.md](getting-started.md) §2）を通す。
2. 新しいタグでイメージを作る。古いイメージは消さない（戻すために使う）。
3. compose のタグを変えて `docker compose up -d`。
4. コンテナが healthy になること、ログインできること、物品の画面が開くことを確かめる。healthy にならず再起動を繰り返すときは、すぐに前のタグへ戻してから原因を調べる。
5. データの形が変わる更新では、先に §5 のバックアップを取る。

物品画面のファイルを変えた更新では、Service Worker のキャッシュの名前を新しくしてください。古い画面が端末に残ります。

## 8. Bot ホスト

- **IyakusaiBot**：`config.example.toml` を `config.toml` に写して値を入れ、Discord の Bot のトークンをファイルで渡して起動する（[`bot/README.md`](../bot/README.md)）。委員会の正式な名前・キャンパス・伏せずに残す学校の事務のメールドメインは `[org]` に書く（書かないと、AI への指示文とメールの署名が既定の名前になり、学校の事務のアドレスも伏せられる）。
- **タスク API**（`bot/gateway/`）：`site.example.json` を写した `site.json`（0600）に待ち受けと接続元を書く。TLS の証明書と、アプリとの経路の鍵を置く。Bot と同じタスク DB を読む。
- **登録**（`bot/registration/`）：`site.example.json` を写した `site.json` に値を書く。Bot の起動のときに読み込まれる。
- **収集**（`collectors/`）：systemd のユニットの例が `collectors/line-oa/systemd/` にある（[`collectors/README.md`](../collectors/README.md)）。
- ホストの時刻を NTP で合わせる（署名の時刻のずれは 30 秒まで）。
