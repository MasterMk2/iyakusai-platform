# 試し方と試験

どの部品も、本物のアカウントや鍵なしで、合成データと試験で確かめられます。

## 1. 統合アプリを合成データで動かす

Node.js 22.12 以上と npm 10 が要ります。

```sh
cd app
npm ci
npm run build
npm start
```

<http://127.0.0.1:5178/> を開き、デモ用のペルソナ（編集担当A・閲覧担当B など）を選びます。パスワードは要りません。
この起動のしかた（`demo` モード）では、ホーム・メール（合成の受信箱 3 つと LINE の模擬）・設定が使えます。

タスクと物品貸出も合成データで試すときは、保存先を指定して起動します。

```sh
# macOS・Linux
SMM_TASK_DATA_FILE=.tmp/tasks.json SMM_RENTAL_DATA_DIR=.tmp/rental npm start
```

```powershell
# Windows（PowerShell）
$env:SMM_TASK_DATA_FILE = '.tmp/tasks.json'; $env:SMM_RENTAL_DATA_DIR = '.tmp/rental'; npm start
```

- タスク：合成の委員会 2 つとタスクが入った状態で始まります。ホームに期限超過と残数が出ます。運用では、タスクはこのプロセスではなく Bot ホストのタスク API に保存します（[architecture.md](architecture.md) §3）。
- 物品貸出：<http://127.0.0.1:5178/rental/> で物品画面が開きます。台帳は空から始まります。
- 連絡先と Bot タブは、`demo` モードでは「使えません」と表示します（運用の構成でだけ動きます）。

合成データは `npm run reset-data` で初めの状態に戻せます。デモの変更は `app/data/` と `app/.tmp/` に保存します（どちらも Git の管理外）。

`demo` モードはループバック（`127.0.0.1`）でしか待ち受けません。ほかのアドレスを指定すると起動を断ります。ほかの認証モードは [`app/README.md`](../app/README.md) にあります。

## 2. 統合アプリの試験

```sh
cd app
npm run check        # lint・型検査・単体・API・ビルド・ブラウザの試験を順に。最初の失敗で止まる
```

個別に流すとき：

```sh
npm run lint
npm run typecheck
npm run test:unit
npm run test:api
npm run test:e2e     # 先に npm run build と npx playwright install chromium
```

ブラウザの試験は、ループバックの専用ポートで試験用のサーバーを起動し、データは `.tmp/` に置きます。外部へは通信しません。

## 3. IyakusaiBot の試験

Python 3.12 以上を使います。

```sh
cd bot
python -m venv .venv
. .venv/bin/activate            # Windows: .venv\Scripts\activate
pip install -r src/requirements.txt

python -m unittest discover -s tests -p "test_*.py"
PYTHONPATH=src python -m unittest discover -s reference-tests -p "test_*.py"
python src/smoke_test.py         # Discord に接続しない、通しの確認
```

Windows では、参照試験のうち `fcntl` を使う 1 件が失敗します（Linux 専用の機能のため）。

Bot を Discord につないで動かす手順は [`bot/README.md`](../bot/README.md) にあります。

## 4. タスク API と LINE の転送の試験（Linux）

どちらも Linux 専用です（`fcntl` とファイルの権限を使う）。Windows では WSL で流せます。
配置ごとの値は `site.json` から読むので、試験の前に例を写します。試験は作業用の写しで流すと、元のフォルダを汚しません。

```sh
cp -r bot/gateway /tmp/gateway && cd /tmp/gateway
python3 -B -m unittest discover -p "test_*.py"

cp -r collectors/line-oa-relay /tmp/relay && cd /tmp/relay
cp site.example.json site.json && chmod 600 site.json
python3 -B -m unittest discover -p "test_*.py"
```

## 5. 物品の発行・読取ソフトの試験（Windows）

`app/clients/issuer/` は Windows で動くソフトです。試験は読取機がなくても流せます。

```powershell
cd app/clients/issuer
python -m pip install -r card/requirements.txt openpyxl reportlab pypdf
$env:PYTHONPATH = "$PWD\desktop;$PWD\card;$PWD\labels;$PWD"
cd desktop; python -m unittest discover -s . -p "test_*.py"
cd ..\card; python -m unittest discover -s . -p "test_*.py"
```

一時フォルダのパスが短い形式（8.3 形式。`~1` などを含むもの）だと、いくつかの試験が失敗します。`$env:TEMP` を長い形式のパスにしてから流してください。

## 6. 公開デモ（GitHub Pages）

統合アプリを、インストールなしにブラウザで触れる静的なページです（`app/scripts/pages-demo/`）。サーバーを置けないので、1 の合成データのサーバーから画面が読んだ応答を録っておき、ページの中で同じ応答を返します。

- ペルソナの切り替え、タブの移動、一覧・詳細の表示、一覧の絞り込みと検索ができます。
- 録ってあるのは、絞り込みの選択肢を 1 つずつ選んだときの応答です。
  - 絞り込みの組み合わせは、条件ごとの結果の共通部分で近似します。
  - 検索は、一覧の項目に検索語が含まれるかで近似します。
  - どちらも本物と結果が違うことがあります。たとえばメールは、本物は 1 通ごとに条件を見ますが、近似はスレッド単位です。
- 保存・送信はできません。押すと「公開デモでは保存・送信はできません」と出て、データは変わりません。
- ファイルのダウンロードと、物品貸出の画面（`/rental`）も使えません。
- 表示は組み立てた日の合成データです。

手元で組み立てて確かめるとき：

```sh
cd app
npm ci
npx playwright install chromium
npm run build          # 録画に使うサーバーを作る
npm run build:pages    # dist/pages に書き出す（数分かかる）
node scripts/pages-demo/serve.mjs   # http://127.0.0.1:5207/iyakusai-platform/ で開く
```

- `build:pages` は、一時フォルダに合成データを作ってサーバーを起動し、ペルソナごとに画面を巡回して応答を録ります（`record.mjs`）。巡回は画面を開いて絞り込みを選ぶだけで、ボタンは押しません。
- 録ったものに合成データ以外が混じっていないかを最後に調べます（`screen.mjs`）。予約ドメイン（`.example` など）以外のメールアドレスや URL、プライベートの IP アドレス、個人のフォルダのパスがあれば失敗で終わります。
- 画面を足したときは、`record.mjs` の巡回の起点（`SEED_ROUTES`）と、応答の ID から開く画面（`ID_ROUTES`）を足します。公開デモで「この表示のデータが入っていません」と出た要求は、ブラウザのコンソールで `window.__iyakusaiPagesDemo.misses` に残ります。

公開は `.github/workflows/pages-demo.yml` が行います。PR では組み立てと確認だけで、成果物は Actions のアーティファクトに置きます。main への push・毎日 3 時・手動で動かしたときに、次の 2 つがそろっていれば GitHub Pages に出します。

1. リポジトリの Settings › Pages の Source が「GitHub Actions」
2. リポジトリ変数 `PAGES_DEMO_ENABLED` が `true`

公開をやめるときは、変数を消すか Pages を無効にします。

## 7. 既知の問題

- 統合アプリの `vitest` には、2026-11-03 の時点で既知の失敗が 36 件あります。運用中の版でも同じで、新しい失敗を増やさないことを基準にしています。一覧は `app/tests/known-failures.json` にあり、CI は一覧に無い失敗が出たときに止まります（手元では `npx vitest run --reporter=json --outputFile=report.json` のあと `node scripts/check-test-baseline.mjs report.json`）。直した試験は一覧から消してください。
  - 大半は、合成データ版のメールの権限（受信箱ごとに閲覧を許す）を前提にした試験です。委員全員がメールを読める方針（[mail.md](mail.md)）に変えたあとの動きと合っていません。
  - ほかに、Host と Origin の検査、API の応答のキャッシュの指定、Bot のデータソースの応答の形の試験が数件あります。原因はまだ調べていません。
- 統合アプリの `vitest` を全部まとめて流すと、負荷で時間切れになる試験がまれにあります。単独で流すと合格します。
- `npm run demo:integrated` と `npm run test:cross` は、以前に別リポジトリだったタスクサービスのチェックアウト（`SMM_TASK_SERVICE_DIR`）を前提にしていて、このリポジトリだけでは動きません。
