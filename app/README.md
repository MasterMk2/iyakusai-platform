# 統合アプリ（委員会アプリ）

医薬祭の実行委員会が使う Web アプリです。ホーム・タスク・物品貸出・メール・連絡先・Bot・設定を 1 つの画面にまとめています。
全体の中での位置づけは [リポジトリ直下の README](../README.md) と [全体の構成](../docs/architecture.md) を見てください。

## できること

- **ホーム**：いま対応が必要な数（期限超過のタスク、未対応のメール、返却待ちの物品、承認待ちのタスク候補）だけを出す。
- **タスク**：Discord の `/todo` と同じタスクを、委員会ごとに一覧・詳細・作成・更新する。複数の部局、親子、副担当、部局ごとの木と関係図。タスクはこのアプリには保存せず、Bot ホストのタスク API を署名付きで呼ぶ。
- **物品貸出**：NFC カードや QR を読んで、団体への貸出・返却・随時の点検を記録する。写真を撮って残す。通信が切れても端末に残し、つながったら送る。記録は Google ドライブへも複製できる。カードの発行と PC の読取機のためのソフトは `clients/`。
- **メール**：委員会のメール（Google Workspace のグループ）と LINE 公式アカウントの会話を 1 つの一覧で読み、担当・状態・ラベル・メモを付ける。権限を持つ人は委員会のアドレスで送信・返信できる。メールからタスクを作れる（[委員会メールの扱い](../docs/mail.md)）。
- **連絡先**：委員会の連絡先の検索と管理。
- **Bot**：IyakusaiBot の質問・文書の起草・リマインド・タスク候補の承認（[取り決め](../docs/contracts/bot-front.md)）。
- **設定**：画面の色（若葉・ライト・ダーク）、パスワード、受信箱ごとの権限、ログインの記録。

画面の決まりは [画面設計の方針](../docs/ui-guidelines.md) にあります。

## 試す

Node.js 22.12 以上と npm 10 が要ります。

```sh
npm ci
npm run build
npm start
```

<http://127.0.0.1:5178/> を開き、デモ用のペルソナを選びます（パスワードは要りません）。
タスクと物品貸出も試す方法は [試し方と試験](../docs/getting-started.md) にあります。

## 認証のモード

`SMM_AUTH_MODE` で選びます。それ以外の値では起動しません。

| モード | 用途 |
|---|---|
| `demo`（既定） | 合成データ。ペルソナを選ぶだけのモック認証。ループバックでしか待ち受けない |
| `account-mock` | 合成データ。メールアドレスと、模擬の DM で届くコードによるログインを試す。ループバック専用 |
| `trusted-proxy` | 前段のリバースプロキシが認証し、決まったソケットから `X-Mail-User` ヘッダーで利用者を伝える。データは合成のもの |
| `account` | メールアドレスとパスワード。本人の確認と DM を外部の仕組み（本人 bridge）に頼る |
| `discord` | 運用のモード。Discord の `/register` で登録し、学籍番号とパスワードでログインする（[全体の構成](../docs/architecture.md) §5） |

運用（`discord`）の環境変数・設定ファイル・鍵は [配置](../docs/deployment.md) にあります。

### `demo` と `trusted-proxy` の設定

| 環境変数 | 既定値 | 説明 |
| --- | --- | --- |
| `SMM_HOST` | `127.0.0.1` | `demo` ではループバック（`127.0.0.1`・`::1`・`localhost`）以外を断る |
| `SMM_PORT` | `5178` | 待ち受けのポート |
| `SMM_DATA_FILE` | `data/demo-state.json` | デモの変更を保存する JSON（Git の管理外）。1 プロセス用 |
| `SMM_LINE_MODE` | `demo`：`mock`、`trusted-proxy`：`off` | LINE の模擬。`off` か `mock` だけ |
| `SMM_LINE_DATA_FILE` | `demo`：`SMM_DATA_FILE` と同じ場所の `*.line.json` | LINE の模擬の JSON。`trusted-proxy` で `mock` にするときは必須 |
| `SMM_TASK_DATA_FILE` | なし | 同じプロセスにタスクを置いて試す（合成データ） |
| `SMM_RENTAL_DATA_DIR` | なし | 物品の台帳と写真の保存先。設定すると物品貸出を使える |

`trusted-proxy` では、次がそろっていないと起動しません（不備があればデータを作らず・上書きせずに終わる）。

| 環境変数 | 説明 |
| --- | --- |
| `SMM_PUBLIC_ORIGIN` | 正規形の `https://` のオリジン（末尾のスラッシュ・パス・クエリなし） |
| `SMM_TRUSTED_PROXY_ADDRESSES` | 信頼するプロキシのソケットの IP（カンマ区切り、完全一致）。範囲・ワイルドカード・ホスト名は不可 |
| `SMM_USER_MAP_FILE` | 利用者の対応表の JSON（形は `deploy/user-map.example.json`） |

- 利用者は、許可したプロキシのソケットから届いた 1 つの `X-Mail-User` ヘッダーだけで決める。Cookie や転送系のヘッダーは使わない。
- 変更の要求には、公開のオリジンと完全に一致する `Origin` が要る。ペルソナの選択・リセット・障害のシミュレーションは API ごと無い（404）。

`deploy/` の `*.example*` は、`trusted-proxy` と `account` のモードの配置の例です（動作は確かめていません）。運用のコンテナは `deploy/unified/Dockerfile` から作ります。

## 開発と試験

```sh
npm run check       # 下の 6 つを順に。最初の失敗で止まる
npm run lint        # ESLint
npm run typecheck   # サーバー・画面・試験の型検査
npm run test:unit   # 単体の試験（Vitest）
npm run test:api    # API の試験（Vitest と Fastify の inject）
npm run build       # 画面（Vite）とサーバー（tsc）のビルド
npm run test:e2e    # ブラウザの試験（Playwright の Chromium。ビルドしてから）
```

- Playwright のブラウザが無いときは `npx playwright install chromium`。
- ブラウザの試験は、ループバックの専用のポート（5179〜5182）で試験用のサーバーと合成のプロキシを起動し、データは `.tmp/`（Git の管理外）に置く。外部へは通信しない。
- 開発のときは `npm run dev:server` と `npm run dev:client`（<http://127.0.0.1:5173/>）を別々に起動できる。開発用のプロキシは既定のポート `5178` の API に転送するので、`SMM_PORT` を変えない。
- サーバーは、`Host` がループバックの名前と待ち受けのポートの組である要求だけを受け付ける（DNS リバインディングの対策）。運用のモードでは `SMM_PUBLIC_ORIGIN` の `Host` だけ。
- 既知の失敗がある（[試し方と試験](../docs/getting-started.md) §6）。

## 文書

- [要件（合成データ版）](docs/requirements.md)・[設計（合成データ版）](docs/architecture.md)：受信箱・認証・LINE の模擬の初期の設計
- [共通入口とアカウント認証](docs/unified-integration.md)・[グループの所属と Bot の DM によるログイン](docs/group-discord-auth.md)・[Bot の認証の取り決め](docs/bot-auth-contract.md)
- [LINE 連携](docs/line-integration.md)・[LINE の返信の取り決め](docs/line-reply-contract.md)
- [タスクサービスの API](docs/task-service/integration-api.md) とその設計（`docs/task-service/`）
- 物品貸出：`docs/unified/rental-workflow.md` など
