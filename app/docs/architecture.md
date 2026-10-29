# 設計（テスト版）

テスト版の構成と、今回採用する委員会共有メールの読取境界を示す。
実メール接続には [要件](requirements.md) の実対象・配送証跡・保存・安全性の保留事項が残る。
本人の最小認証公開には、本変更による追加の前提を設けない。

## 構成

```text
合成フィード（fixtures.ts）→ MockInboundConnector（読み取り専用）→ 正規化・冪等取り込み（sync.ts）
                                                                         ↓
ブラウザ（React, 日本語 UI）→ Fastify API（127.0.0.1）→ 受信箱 ACL（access.ts）→ 参照・更新（queries.ts / triage.ts）
                                                                         ↓
                                                   ローカル JSON（data/demo-state.json, Git 管理外）
```

| 層 | 主なファイル | 責務 |
| --- | --- | --- |
| 共有型 | `src/shared/api.ts` | API の入出力型、状態名、入力上限。配送メタデータは型に含めない。 |
| コネクター | `src/server/connector/` | `InboundConnector` 境界（取得のみ）と `MockInboundConnector`、合成フィクスチャ。 |
| ドメイン | `src/server/domain/` | 型、ACL、宛先表示方針、HTML 無害化、同期、参照、対応情報の更新、権限管理、保存。 |
| 設定 | `src/server/config.ts`、`src/server/auth.ts` | 環境変数の検証、認証モード、公開オリジン・プロキシ許可リスト・利用者対応表の検証。 |
| HTTP | `src/server/http/app.ts` | モック認証 Cookie または信頼済みプロキシの識別、入力検証（zod）、エラー変換、CSP 等のヘッダー、デモの障害注入。 |
| UI | `src/client/` | ペルソナ選択（デモ）または認証済み利用者の表示（プロキシ）、統合／受信箱別一覧、スレッド詳細、対応情報、メモ、管理画面。 |

技術：Node 22、TypeScript 6.0、Fastify 5、zod 4、sanitize-html 2（htmlparser2）、React 19、Vite 8、
Vitest 5、Playwright 1.64、ESLint 10。すべて無償の OSS で、ローカルだけで動く。

## データモデル

| 概念 | 内容 |
| --- | --- |
| Mailbox | アプリ内の受信箱。委員会共有の読取は明示スコープ `committee-shared` と、承認済みの `mailboxId`・`address`・`sourceKey`・`connectorId` の組で許可する。取得元識別子は API では返さない。 |
| Message | 正規化した件名・差出人・To/Cc・本文・添付。Bcc は取り込み時に捨てる。複数 Receipt で共有しうる。 |
| Receipt | 受信箱への 1 回の到着。`delivery`（コネクター ID、接続元受信箱、接続元メール ID、Delivered-To、生ヘッダー）は内部専用。`triage`（版番号・状態・担当・ラベル）、`notes`、`history` を持つ。 |
| Thread | `threadId = hash(受信箱 ID, スレッドキー)`。受信箱ごとに閉じる。 |
| Grant | 利用者 × 受信箱の従来の権限。委員会共有の読取は検証済み会員根拠と対象・配送先の検査で判断し、既存 Grant で個人・未承認受信を救済しない。対応情報の編集は現在の `edit` に従う。 |
| Audit | 権限変更・同期・モック配信・初期化の記録。 |

## 認可

- 委員会共有の読取は [閲覧方針](../../docs/mail.md) に従う。`LoginService.authenticate` の新しい資格確認後にだけ、
  サーバー内で要求専用の会員根拠を発行する。JSON の会員フラグや、プロキシ・デモの本人識別だけでは作れない。
- 利用者が現在も有効な現役委員かを読取ごとに検査する。スコープと承認済み対象の組を照合し、
  Receipt の取得元・コネクター・`deliveredTo` の完全一致も検査する。共有と個人の配送が混在する受信は拒否する。
- すべての参照は `permittedReceipts()` または `readableReceipt()` から始まる。フィルター、スレッド化、
  抜粋、件数、ラベル候補、ページ分割はこの結果だけを使うため、未許可の受信は計算に入らない。
- 受信箱の指定や ID が未許可の場合は、存在しない場合と同じ 404 を返す。
- 更新は `editableReceipt()` で現在の `edit` 権限を再確認する。権限は毎回現在の状態から評価するため、
  取消・降格は次の要求から有効になる。
- 担当候補は従来の受信箱 Grant に基づく条件を維持する。共有の全員閲覧だけで候補や編集権限を広げず、割り当ても Grant を作らない。
  担当候補の条件を失っても割り当ては残るため、その扱いは編集者向けの表示で説明する。
- 既定デモの A〜D は明示された現役委員 fixture で、共有3受信箱すべてを閲覧する。
  編集は A がサポート・営業、C が請求だけ。B・D は編集不可。担当候補の従来の Grant 条件は維持する。
- デモ管理者の fixture は非会員で、メール読取は 403。管理・同期の既存権限は変更しない。

検証済み会員根拠は保存データへ書かず、要求をまたいで使わない。退任・停止・無効化後は次の読取で拒否する。
部署で本文・添付を絞らず、編集の Grant や送信・返信・削除の権限は増やさない。
グループ・アカウント認証の根拠を使う。デモの例外はループバックで明示した合成 fixture だけとする。

## 同期（モック）

1. 取得：委員会共有の経路では承認済み対象と取得元の組を検査し、未承認の取得元は `fetchSince()` を呼ばずに除外する。
   許可された受信箱ごとにカーソル以降を取得する。失敗した受信箱は記録してほかを続ける。
2. 反映：トランザクション内で対象・取得元・配送先を再検査し、各項目を zod で検証（不正は件数だけ数えて捨てる）。Receipt キーが既存なら
   重複として何も変更しない。新規なら Message を再利用または作成し、空の対応情報で Receipt を作る。
3. 成功した受信箱だけカーソルを進める。失敗した受信箱は次回の再試行で同じ項目を取得する。

「全件再取得」はカーソルを無視して再取得し、既存 Receipt の対応情報・メモ・履歴は変更しない。

### 実接続での取得単位（設計方針・未実装）

方針の全体は [要件](requirements.md) MB-01〜MB-08 と [委員会メールの扱い](../../docs/mail.md)。検証には合成の受信箱とモックコネクターを使い、
実際の取得経路・プロバイダーの認証情報・永続的なアクセス範囲は設定していない（承認が必要）。

- `Mailbox` の取得元（`sourceKey`）は、運用者が承認した正規の委員会共有受信箱に対応させる。
  個人・未分類・未承認の取得元は扱わない。To/Cc/Bcc、ドメイン、差出人、所有者の取得能力から対象を作らない。
- エイリアスは `Mailbox` を作らず、正規受信箱への対応表（Git の外）で表す。正規受信箱は 1 回だけ取得し、エイリアスでの絞り込み・表示は
  検証済みの `Receipt.delivery` で承認された共有アドレスへの配送と一致した場合だけ行う。Receipt の冪等キーと Message の共有条件は変えない。
- グループのアーカイブと配信先は別の取得元として分類する。共有受信箱・アドレス・取得元・コネクターの組と配送証跡を検証できないものは追加しない。
- ヘッダー由来の候補は共有分類が未完了で、Delivered-To / Original-To の証跡もない。件数がそろっても承認の根拠にはしない。
  GAS の実行アカウントの本人性は運用の側で確かめる。確かめるまでは、実アドレスの対象リストと実メール接続を有効にしない。

## 更新と整合性

- `StateStore.transact()` は状態の複製に対して処理し、成功して保存できた後にだけ置き換える。
  検証エラー・競合・例外では元の状態が残る。
- 対応情報は `expectedVersion` が現在の版と一致した場合だけ更新し、不一致は 409 と最新値を返す。
  UI は最新値を表示し、保存できなかった変更内容を文章で示す（黙って上書きしない）。
- デモの障害注入はハンドラーより前に 503 を返すため、部分的な更新は起きない。
- モック同期はコネクターの応答を待ってから取り込むため、同期中のサンプルリセットは 409 で拒否する
  （古い同期結果がリセット後の状態を上書きしないように）。リセット中の同期も 409。同期どうしも 409 で排他する。
  拒否された操作は状態を変えないため、完了後にそのまま再実行できる。

## 本文表示の多層防御

1. サーバー：sanitize-html（htmlparser2）で許可リスト方式に無害化。スクリプト、イベント属性、style、
   フォーム、iframe/object/embed/svg、meta/base/link を除去。`<a>` は `href` を持たない
   `span.mail-link`（URL は `data-href`）、`<img>` は `span.blocked-image` に置換。外部リソースを指す要素数を数える。
2. ブラウザ：`sandbox=""` の iframe（スクリプト・フォーム・ポップアップ・上位遷移・同一オリジンを全て不許可）に
   `srcdoc` で表示。
3. iframe 内 CSP：`default-src 'none'; img-src 'none'; form-action 'none'; base-uri 'none'` 等。
4. アプリ全体の CSP（`srcdoc` に継承）、`Referrer-Policy: no-referrer`、`X-Content-Type-Options: nosniff`。
5. テキスト表示：React のテキストとして描画（HTML として解釈しない）。

添付は `Content-Disposition: attachment`、`application/octet-stream`、`CSP: sandbox` で返す。
これらは合成の悪性サンプルで検証したもので、実メールに対する網羅的な保護は主張しない。

## API

| メソッド | パス | 権限 |
| --- | --- | --- |
| GET/POST/DELETE | `/api/session` | 公開（モック認証）。trusted-proxy モードは GET だけ（認証済み利用者） |
| GET | `/api/personas` | 公開（デモ用ペルソナ一覧）。trusted-proxy モードには存在しない |
| GET | `/api/mailboxes` | 閲覧できる受信箱だけ |
| GET | `/api/threads?mailboxId&q&status&label&assignee&page&pageSize` | 閲覧 |
| GET | `/api/threads/:threadId`、`/api/receipts/:receiptId` | 閲覧 |
| GET | `/api/receipts/:receiptId/attachments/:attachmentId` | 閲覧 |
| GET | `/api/receipts/:receiptId/assignees` | 編集 |
| PATCH | `/api/receipts/:receiptId/triage` | 編集（版番号必須） |
| POST | `/api/receipts/:receiptId/notes` | 編集 |
| GET | `/api/labels?mailboxId` | 閲覧 |
| GET/PUT | `/api/admin/access`、GET `/api/admin/audit` | デモ管理者 |
| POST | `/api/admin/mock/release`、`/api/admin/sync` | デモ管理者 |
| GET/PUT | `/api/demo/faults`、POST `/api/demo/reset` | デモ管理者（デモ専用。全ペルソナに影響するため）。trusted-proxy モードには存在しない |

入力は zod の厳格スキーマで検証し、形式エラーは 400、業務上の検証エラーは 422、未ログインは 401、
閲覧のみの更新は 403、未許可・不明は 404、競合は 409 を返す。
すべての要求（API・静的ファイル）は `Host` がループバック名（`127.0.0.1` / `localhost` / `[::1]`）と
待ち受けポートの組でなければ 421 で拒否する。DNS リバインディングでは `Host` が攻撃者のドメイン名になるため、
`Origin` と `Host` が一致していても通らない。変更要求はさらに `Host` と異なる `Origin` と、
`same-origin` / `none` 以外の `Sec-Fetch-Site` を 403 で拒否する。開発用 Vite プロキシは `Host` を API 側に合わせ、
ループバックの開発オリジン（`:5173`）から来た `Origin` だけを API のオリジンに置き換える。
Cookie は `HttpOnly; SameSite=Strict`。サーバーはループバック以外へのバインドを拒否する。
リクエストログは本文やメモを含みうるため出力しない。

上記はデモモードの規則。trusted-proxy モードの規則は次節。

## 認証モード

| | デモ（既定） | trusted-proxy |
| --- | --- | --- |
| 利用者の決定 | Cookie のペルソナ ID | 許可リストにあるソケットアドレスから届いた単一の `X-Mail-User` を利用者対応表で変換 |
| バインド | ループバックだけ | IP リテラル（コンテナ内の `0.0.0.0` を含む） |
| `Host` | ループバック名＋待ち受けポート | 公開オリジンのホストと完全一致 |
| 変更要求 | `Origin` があれば `Host` と一致 | 公開オリジンと完全一致する `Origin` が必須。`Sec-Fetch-Site` は `same-origin` のみ |
| ペルソナ・リセット・障害注入 | デモ管理者だけ | ルート自体を登録しない（404） |
| `/api/session` | `{ demoAuthentication: true, user }` | `{ demoAuthentication: false, authMode: 'trusted-proxy', user }` |

trusted-proxy モードの判定順（`checkProxyRequest`）：

1. ソケットアドレス（IPv4 射影 IPv6 は正規化）が許可リストにない → 403 `untrusted_proxy`。
   例外は `GET/HEAD /api/health` で、ループバックからのコンテナ内死活確認にも固定本文 `{"ok":true}` を返す。
2. `Host` が 1 つで公開ホストと一致しない → 421。
3. 変更要求の `Origin` / `Sec-Fetch-Site` が不正、または API 読み取りに別オリジン・別サイトの指定 → 403。
4. 静的ファイルの GET/HEAD はここで通す（データを含まず、画面が識別エラーを説明できるように）。
5. `X-Mail-User` が欠落・空 → 401、複数・形式不正 → 403 `invalid_identity`、未登録・無効化 → 403 `unknown_identity`。

利用者対応表は起動時と `buildApp` で、存在する有効な利用者だけを指すことを検証する。
起動時のデータは `StateStore.inspect` で「無い／読めない・不正／正しい」を区別し、trusted-proxy モードでは
読めない・不正な既存ファイルで起動を拒否する（変更・再初期化しない）。合成データの保存はファイルが無い場合だけ。
`Cache-Control: no-store` はゲートと同じ API 判定（照合したルートを含む）とエラー応答に付ける。
画面は `/api/session` がデモを明示したときだけモック認証の表示を出し、モードを確認できなければ中立の表示にする。
要求ごとにも現在の利用者が有効かを確認する。前段のプロキシ構成は提案であり、[配置](../../docs/deployment.md)を参照。

## ログインコアと会員根拠

`src/server/login/` は、グループ所属で資格を確かめ、Bot の DM で 1 回限りのコードを届ける認証コア。
アプリのアカウント認証との関係は [統合設計](unified-integration.md) を参照。実在の本人・所属・Bot の提供元は未接続。

| 部品 | 責務 |
| --- | --- |
| `LoginService` | 同じ形の受付応答、上限付きの非同期配送キュー、資格確認（連携 → 内部利用者 → 所属）、コードの同期的な消費と再確認、セッション発行、要求ごとの再確認、取消イベント。 |
| 注入する境界 | `GroupMembershipReader`（読み取り専用。完全に解決された実効メンバーシップ `effective_membership/v1` を返す。直接・入れ子・設定した組織のいずれの由来でも資格は同じ）、`IdentityLinkDirectory`（運用者管理の連携）、`PrincipalDirectory`（既存の内部利用者）、`BotDelivery`（配送と確認応答）、監査。 |
| `MemoryLoginStore` | 単一プロセスのテスト用参照。挑戦・セッション・計数に上限があり、満杯時は拒否（制限中の計数は消さない）。再起動で全消失。 |
| `buildLoginHarness` | 独立した Fastify。`__Host-` Cookie、Host・Origin・CSRF、`no-store`、CSP を示す。テストの `app.inject` だけで使う。 |

役割と編集権限は既存の内部利用者と Grant に従う。委員会共有メールの読取は、`LoginService.authenticate` の
新しい資格確認後に発行した要求専用の会員根拠と、現在の有効状態、対象・配送先の一致で判断する。
認証レスポンスや保存 JSON に会員フラグを追加しても、そのフラグから根拠を復元できない設計とする。
本番には承認済みのトランザクション対応ストア、秘密情報の供給、相互認証された Bot との経路が必要（[設計](group-discord-auth.md) L01〜L09）。

## LINE 連携（模擬）

[LINE 連携](line-integration.md) と [LINE 返信契約](line-reply-contract.md) を参照。要点：

- LINE は `src/server/line/` の別モジュールと別ファイル（`kind=smm-line-state`, `schemaVersion=1`）。メールの状態は変更しない。
  `buildApp` に `line`（ストア・模擬コネクター・初期化関数）を渡したときだけ LINE のルートを登録する。
- 統合一覧 `GET /api/inbox` は、メールは受信箱 ACL、LINE はアカウント ACL を適用してから絞り込み・件数・ページ分割する。`/api/threads` はそのまま残す。
- 返信は「送信意図を保存 → コネクター呼び出し → 結果を保存」の順。保存に失敗すると送らない。結果を保存できなければ結果不明として残し、同じ再送キーで回復する。
- デモ専用の取り込み・模擬結果の指定はデモモードの管理者だけ。trusted-proxy モードには存在しない。

## テスト

下表は従来版のテスト構成と確認記録。個別 read Grant でメールの閲覧範囲を狭める期待値は旧方針の記録で、
現在の既定デモの要件ではない。そのテストの更新は別途扱い、LINE の既存契約は変更しない。
今回の委員会共有読取の最終検証結果は確認後に追記する。下表を根拠に全検査・ビルド・UI が通ったとは扱わない。

| 種類 | 場所 | 主な確認内容 |
| --- | --- | --- |
| 設定 | `tests/unit/auth-config.test.ts`、`tests/api/startup.test.ts` | 認証モード・公開オリジン・プロキシアドレス・利用者対応表の検証、起動拒否時にデータを作成・上書きしないこと、読めない・不正な既存データでの起動拒否（バイト不変・待ち受けなし）、初回だけの合成データ保存、診断に識別子やパスが出ないこと。 |
| プロキシ認証 | `tests/api/proxy-auth.test.ts` | 偽装ヘッダーの直接接続、転送系ヘッダー、欠落・重複・結合・未登録・無効な識別子、Cookie による成り済まし、Host、別オリジン・Origin なしの書き込み、デモ操作の 404、ACL、帰属、死活確認、エンコードされたパスとエラー応答の `no-store`、実ソケットでの重複ヘッダー。 |
| ログイン準備 | `tests/unit/login-core.test.ts`、`tests/api/login-http.test.ts`、`tests/api/login-effective-membership.test.ts` | 合成の提供元を注入して、構築拒否、連携の未検証・不一致・別名、実効メンバーシップ（合成のグループ構成で直接・1〜2 段の入れ子・組織・外部を許可し、グループ／組織の項目・別グループ・別組織・非メンバー・不明・未解決・循環・上限・権限なし・停止・削除・鮮度・提供元障害を拒否、経路喪失でのセッション削除と経路変更での継続）、資格を得ても既存の受信箱・LINE の ACL が狭いままであること、宛先の安全性、公開応答の同一性、期限・回数・アカウント単位・対象・接続元・全体の上限、再送、別ブラウザ・再利用・同時提出、固定化、取消イベントと要求ごとの再確認、配送失敗と遅延応答、ハッシュだけの保存と監査、上限と再起動、Cookie・Host・Origin・CSRF・`no-store`、アプリ本体に未接続であること。Bot は記録用の合成関数で、Discord 連携ではない。 |
| ドメイン | `tests/unit/` | 合成アドレスのみ、Message/Receipt 分離、宛先方針、同期の冪等性・失敗と再試行、ACL、取消、検索・件数・ページ、ラベル、履歴、競合、検証、無害化。 |
| API | `tests/api/` | 全利用者 × 受信 × エンドポイントの ACL 表、404 の同一性、内部メタデータ非公開、入力検証、障害注入、永続化、ヘッダー、添付、Host 検証（DNS リバインディング）、デモ操作の管理者限定、同期中リセットの 409（遅延コネクター）。 |
| LINE | `tests/unit/line-domain.test.ts`、`tests/api/line.test.ts`、`tests/api/line-startup.test.ts`、`tests/e2e/line.spec.ts` | 正規化・重複・競合・順序・送信取消、旧履歴、送信先の条件、ACL・件数・検索の分離、確認の結び付けと期限、編集後の再確認、同時実行の 1 件成功、権限の取消・無効化、保存失敗、結果不明からの同じキーでの回復、24 時間の境界、429、再起動後の再実行、Host・Origin、trusted-proxy での無効・既定拒否、起動拒否、外部通信なし。画面は模擬の表示・確認内容・送信記録・閲覧者の拒否。 |
| ブラウザ | `tests/e2e/` | 主要操作、閲覧のみ、直接 URL、検索・ラベルの分離、悪性 HTML、失敗・再試行・取消、競合、入力エラー、権限取消、同期。全テストで外部通信とダイアログが 0 件であることを確認。`proxy.spec.ts` はテスト専用の合成プロキシ経由で、認証済み利用者の表示、書き込み、デモ操作の非表示・404、識別できない利用者の拒否、セッション取得失敗時の中立表示を確認。 |
| 統合（共通入口・タスク・アカウント認証） | `tests/api/tasks-gateway.test.ts`、`tests/api/account-http.test.ts`、`tests/api/account-startup.test.ts`、`tests/unit/login-password.test.ts`、`tests/e2e/account.spec.ts`、`tests/cross/integration.spec.ts` | Task ゲートウェイの署名・本人対応・元案件 ACL・重複防止と回復・Task サービス停止、DM コードからのパスワード設定・通常ログイン・復旧・失効・CSRF・本人偽装・会員喪失・永続ストアの改ざん検出・production 構成の起動拒否と模擬入口の不存在。`tests/cross/` は実 Task サービスと組み合わせたループバック統合（模擬 Discord 送信を含む）。設計は [統合設計](unified-integration.md)。 |
