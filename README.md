# 医薬祭 基盤システム

学園祭「医学薬学祭」の実行委員会が、準備と当日の運営に使っているシステム一式です。
タスク管理・委員会メールの共有・物品貸出・連絡先・Discord Bot を 1 つにまとめています。

The operations platform of a university festival committee in Japan: a web app for tasks, a shared committee mailbox, equipment lending with NFC/QR cards and contacts, plus a Discord bot and data collectors. Documentation is in Japanese.

## 何が入っているか

| ディレクトリ | 中身 | 言語 |
|---|---|---|
| [`app/`](app/) | 統合アプリ（委員会アプリ）。ホーム・タスク・物品貸出・メール・連絡先・Bot・設定の画面とサーバー。物品カードの発行・読取ソフト（Windows）も `app/clients/` にある | TypeScript（Node.js 22）、Python |
| [`bot/`](bot/) | IyakusaiBot（Discord Bot）。資料への質問・文書の起草・リマインド・タスク（`/todo`）・タスク候補の抽出。タスクの正本の API（`bot/gateway/`）と、ログイン用の登録（`bot/registration/`）もここにある | Python |
| [`gas/`](gas/) | 委員会の Gmail を JSONL にして保存する Google Apps Script | Apps Script |
| [`collectors/`](collectors/) | Discord の記録の収集と、LINE 公式アカウントの受信・Discord への転送 | Python |
| [`docs/`](docs/) | 全体の構成、合成データでの試し方、配置、部品の間の取り決め | — |

統合アプリから Google ドライブへの物品の記録の複製と、メールの取り込みに使う GAS は `app/deploy/unified/gas/` にあります。

## 試す

認証情報は要りません。統合アプリは合成データだけで動かせます。

```sh
cd app
npm ci
npm run build
npm start
```

<http://127.0.0.1:5178/> を開き、デモ用のペルソナを選びます。タスクと物品貸出も合成データで試す方法、Bot と収集の試験の回し方は [docs/getting-started.md](docs/getting-started.md) にあります。

## 文書

- [全体の構成](docs/architecture.md)：部品のつながり、データの正本、署名付きの連携、認証
- [試し方と試験](docs/getting-started.md)
- [配置](docs/deployment.md)：コンテナ、設定ファイルと鍵、リバースプロキシ、バックアップ、GAS
- [委員会メールの扱い](docs/mail.md)
- [画面設計の方針](docs/ui-guidelines.md)
- 部品の間の取り決め：[Bot タブ](docs/contracts/bot-front.md)、[Bot のデータソース](docs/contracts/bot-datasource.md)
- 部品ごとの文書：[`app/README.md`](app/README.md)、[`bot/README.md`](bot/README.md)、[`collectors/README.md`](collectors/README.md)

## このリポジトリについて

- 委員会が実際に動かしている版（2026-10-28 時点）から作ったスナップショットです。委員の名前・ID・アドレス・内部のホスト名などは公開前に取り除き、配置ごとの値は設定ファイルから読む形にしました。そのため、コメントと設定の読み方は運用中の版と少し違います。詳しくは [PROVENANCE.md](PROVENANCE.md)。
- 一つの委員会のために作ったもので、そのまま他の団体で使える製品ではありません。Discord・Google Workspace・LINE 公式アカウントを使う前提の部分があります。
- 運用の手順・名簿・本番の設定は、このリポジトリに入れていません。
- 統合アプリの試験には既知の失敗があります（[docs/getting-started.md](docs/getting-started.md) の「既知の問題」）。

封筒の宛名印刷のツールは、別のリポジトリ `iyakusai-envelope` で公開しています。

## ライセンスと連絡

- [MIT License](LICENSE)
- 脆弱性を見つけたときは、Issue に書かずに [SECURITY.md](SECURITY.md) の方法で知らせてください。
