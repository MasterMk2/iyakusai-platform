# IyakusaiBot

委員会の Discord サーバーで動く Bot と、Bot ホストで一緒に動く部品です。

| ディレクトリ | 中身 |
|---|---|
| `src/iyakusai_bot/` | Bot の本体（discord.py） |
| `src/config.example.toml` | 設定の例。写して `config.toml` にする |
| `src/smoke_test.py` | Discord に接続しない、通しの確認 |
| `tests/`・`reference-tests/` | 試験 |
| `gateway/` | タスク API。統合アプリが署名付きでタスクを読み書きする口と、Bot タブの連携口 |
| `registration/` | ログイン用の登録。Discord の `/register` と、登録コードの DM |

## できること

| コマンド・機能 | 内容 | 主なモジュール |
|---|---|---|
| `/ask` | 委員会の資料（議事録・Discord・メールの記録など）を検索して、出典付きで答える。資料は機微な行を伏せた写し（ミラー）だけを読む | `knowledge.py`・`knowledge_search.py`・`mirror.py`・`semantic_index.py` |
| `/doc` | 依頼文・お知らせ・報告書・議事録のたたき台・メールの文面を起草し、docx・md・txt で添付する | `documents.py`・`docgen.py`・`mail_draft.py` |
| `/remind` | リマインドの登録・一覧・完了・削除と、期限の通知 | `reminders.py`・`remind_logic.py` |
| `/todo` | 委員会のタスク。統合アプリのタスク画面と同じデータ | `task_cog.py`・`task_domain.py`・`task_store.py` |
| タスク候補 | Discord の会話からタスクの候補を抜き出し、承認されたら起票する | `screening_*.py` |
| 統合アプリの Bot タブ | アプリから受けた依頼（ジョブ）を実行して結果を返す（[取り決め](../docs/contracts/bot-front.md)） | `assistant_*.py` |
| 基盤のデータ | 統合アプリの物品と受信箱の状態を `/ask` の資料に加える（[取り決め](../docs/contracts/bot-datasource.md)） | `kiban.py`・`kiban_cog.py` |
| 収集 | Discord の記録の収集（`collectors/discord/`）を定期的に動かす | `collector.py` |
| そのほか | 使い方（`/help`）、AI の使用量（`/usage`）、口調の設定、連絡先の案内、俳句の検出など | `help.py`・`usage.py`・`persona*.py`・`contact.py`・`haiku*.py` |

AI の呼び出しは `ai_provider.py` にまとめています。Claude のコマンドライン（`claude -p`）を使い、つながらないときは検索の結果をそのまま返します。

## 動かす

Python 3.12 以上。

```sh
cd bot/src
python -m venv ~/.iyakusai/venv
~/.iyakusai/venv/bin/pip install -r requirements.txt
cp config.example.toml ~/.iyakusai/config.toml     # 値を自分のものにする
DISCORD_TOKEN_FILE=~/.iyakusai/discord_token.txt ~/.iyakusai/venv/bin/python -m iyakusai_bot
```

- Discord の Bot のトークンは、環境変数 `DISCORD_TOKEN` か、ファイルの場所を `DISCORD_TOKEN_FILE` で渡します。トークンをリポジトリ・共有のドライブ・Discord に置かないでください。
- 設定の各節（`[paths]`・`[ai]`・`[knowledge]`・`[org]`・`[assistant]`・`[kiban]` など）の意味は `config.example.toml` のコメントにあります。ID はすべて例なので、自分のサーバーのものにします。委員会の正式な名前とキャンパスは `[org]` に書きます（コードには学校名を書いていません）。
- 同じ Bot を 2 か所で動かさないよう、起動のときにロック（ハートビート付き）を取ります。別のホストで動いていると起動を断ります。相手が確実に止まっているのにロックが残っているときだけ、`--force` で引き継ぎます。

Discord の側で要るもの：

- 招待のときに `bot` と `applications.commands` のスコープ。
- 権限は View Channels・Send Messages・Embed Links など、使う機能に要るものだけ。Administrator は付けない。

## 試験

```sh
cd bot
python -m unittest discover -s tests -p "test_*.py"
PYTHONPATH=src python -m unittest discover -s reference-tests -p "test_*.py"
python src/smoke_test.py
```

タスク API の試験は Linux 専用です（[docs/getting-started.md](../docs/getting-started.md) §4）。

## タスク API（`gateway/`）

`bot_task_gateway.py` は、Bot のタスク DB（SQLite）を正本のまま、統合アプリから署名付きで読み書きさせる Web API です。Discord には接続せず、タスクの写しも持ちません。

```sh
python3 bot_task_gateway.py --config <設定の JSON>
```

- 待ち受けのアドレスと、受け付ける接続元は、同じフォルダの `site.json`（所有者だけが読める権限）から読みます。形は `site.example.json`。既定の値はありません。
- TLS で待ち受け、`svc-auth/v1` の署名・接続元・`Host` を確かめます。
- 統合アプリのホームのための集計（`GET /api/integration/v1/summary`）は、閲覧の権限を確かめてからタスク DB を 1 回読み、部署別・期限別の件数だけを返します。取れなかったときは 0 件ではなく失敗を返します。
- Bot タブの連携口は、設定の JSON の `assistant_enabled`・`assistant_store_path`・`assistant_files_dir`・`screening_store_path` で有効にします（パスはどれも絶対パス）。無効なら `/api/integration/v1/assistant/*` は 404 です。

API の取り決めは [`app/docs/task-service/integration-api.md`](../app/docs/task-service/integration-api.md) にあります。

## 登録（`registration/`）

Discord の `/register` を受けて、統合アプリにログイン用の 1 回限りのコードの発行を頼み、DM で届けます。統合アプリからの「この人は委員か」の問い合わせにも答えます（[docs/architecture.md](../docs/architecture.md) §5）。
配置ごとの値は `site.json`（形は `site.example.json`）から読みます。
