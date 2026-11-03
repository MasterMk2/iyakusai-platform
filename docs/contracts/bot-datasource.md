# IyakusaiBot のデータソース（Bot → 統合アプリ・読み取りだけ）

Bot の `/ask` が、統合アプリの**物品貸出の台帳**と**メールの対応状況**、**決定事項の台帳**（2026-11-03 に追加）を根拠に答えられるようにするための取り決めです。
タスクは Bot ホストのタスク DB が正本なので、この口では扱いません（Bot が自分のホストで直接読む）。

`/ask` の答えは Discord で委員全員に見える前提です。そのうえで、物品は**メモ欄を含めて**、メールは**対応状況（状態・担当・ラベル・メモ・タスクとのつながり）を含めて**渡します。メールの本文とアドレスは渡しません（§3）。

## 1. 経路と認証

```text
Bot ホスト（数分ごと）
  ─ POST /v1/bot/datasource（svc-auth/v1・client "iyakusai-bot-datasource"）→ 統合アプリ
  ← JSON（下記）
Bot はそれを Markdown に整え、資料の写し（ミラー）の kiban/ に置く → /ask の検索がそれを読む
```

- 署名：`svc-auth/v1`（`app/src/server/tasks/signing.ts`）。client は `iyakusai-bot-datasource`、actor は空。
  正規文字列は `svc-auth/v1\n<client>\nPOST\n/v1/bot/datasource\n<timestamp>\n<nonce>\n\n<sha256(body)>`。
- 鍵：**この口だけの**鍵 `SMM_BOT_DATASOURCE_KEY_FILE`（32 バイト以上の乱数・所有者だけが読める権限）。
  ログインの登録コードを発行できる鍵とは分ける。漏れても読むことしかできないようにするため。
  ほかの経路（ペッパー・本人 bridge・タスク連携・メールの取り込み・物品の複製）の鍵と同じ値なら、起動を止める。
- 設定していなければ口を作らない（404）。`SMM_AUTH_MODE=discord` のときだけ使える。
- 時刻のずれは 30 秒まで。nonce は 1 回限り（プロセスの中で覚える。読むだけの口なので、再起動で忘れてよい）。
- `Origin` ヘッダー付き・`x-svc-*` の重複・知らない `x-svc-*`・client の違い・actor 付き・署名の不一致は、すべて同じ 401。
- 本文の上限は 1 KB。

## 2. 要求

```json
{ "sources": ["rental", "mailbox", "decisions"] }
```

- キーは `sources` だけ。値は `"rental"`・`"mailbox"`・`"decisions"` の 1〜3 個（重複なし）。それ以外は 401 と同じに扱う（400 にしない＝中身を探らせない）。
- `"decisions"` を求めたときだけ、応答に `decisions` の項目が入る。求めなければ応答の形は従来のまま（`version`・`generatedAt`・`rental`・`mailbox` の 4 項目）。

## 3. 応答（200）

```jsonc
{
  "version": 1,
  "generatedAt": "2026-10-14T06:00:00.000Z",        // UTC
  "rental": null | {                                  // 要求に無い・物品が未設定なら null
    "summary": { /* RentalStore.summary() そのまま */ },
    "items":   [ /* RentalStore.overview().items そのまま（OverviewItem） */ ]
  },
  "mailbox": null | {                                 // 要求に無い・受信箱が未設定なら null
    "mailboxes": [ { "id": "contact", "name": "問い合わせ", "threads": 120, "unhandled": 80 } ],
    "messages": [                                     // 受信の新しい順・最大 5,000 通
      {
        "id": "rc_0123456789abcdef",
        "threadId": "th_0123456789abcdef",
        "mailboxIds": ["contact"],
        "subject": "…",
        "fromName": "…" | null,                       // 差出人の表示名だけ（アドレスは渡さない）
        "sentAt": "…", "receivedAt": "…",             // UTC
        "status": "unhandled" | "in_progress" | "on_hold" | "done",
        "assignee": "名前" | null,                    // 運用者の名簿の名前だけ（ID・学籍番号・ログイン ID は渡さない）。名簿に無ければ "（不明）"
        "labels": ["…"],
        "attachments": 2,                             // 件数だけ
        "notes": [ { "author": "名前", "at": "…", "body": "…" } ],   // author も assignee と同じ規則
        "taskIds": ["task-12"]                        // このメールから作ったタスク（タスク DB の通し番号）
      }
    ]
  },
  "decisions": null | {                               // 要求された場合だけ入る。台帳が未設定なら null
    "items": [                                        // 最後に変わった順（登録・直し・変更・取り消し・戻しを含む）。最大 100 件
      {
        "id": "dc_0123456789abcdef",
        "title": "…",                                 // 決定の内容（1 行）
        "body": "…",                                  // 詳しい内容（最大 2,000 字）。空のことがある
        "departments": ["planning"],                  // 部局のキー（タスクの部局と同じキー）
        "decidedAt": "2026-10-18",                    // 決めた日（日本時間の日付）
        "venue": "役員会",                             // 決めた場の名前（「その他」のときは書かれた場）
        "status": "active" | "changed" | "revoked",   // 有効・変更された・取り消し
        "supersededBy": "dc_…" | null,                // 変更された決定の、新しい決定の ID
        "changeNote": "…",                            // 何を変えたかの一言（変更で置き換えた新しい決定だけ。ほかは空）
        "changedAt": "2026-10-18T06:00:00.000Z",      // 最後に変わった日時（UTC）
        "url": "https://…/#/decisions?d=dc_…" | null  // アプリ内の決定の場所。公開の URL が分からないときは null
      }
    ]
  }
}
```

### 渡さないもの（試験で「無いこと」を確かめる）

差出人・宛先のメールアドレス、To・Cc、メールの本文（text・html）、添付の中身とファイル名、アカウント ID・Discord ID・学籍番号・ログイン ID（`assignee_id`・`author_id`・`actor_id` などの生の ID）、権限（grants）、監査・ログインの記録、対応の履歴（history）、セッション、物品のスタッフ・発行（issuance）の URL、写真。

決定事項では、登録した人・直した人・取り消した人の名前も ID も渡さない（決定の中の人の情報はない）。出典（メールの件名・参照 ID・リンク）、関係するタスクの ID、履歴、取り消しの理由も渡さない。試験は「`decisions` の応答に委員の ID が無いこと」を確かめる。

## 4. 失敗の扱い（Bot の側）

- 401・時間切れ・形の違反のときは、前回の `kiban/` のファイルを残し、`kiban/_status.md` に失敗と最後に成功した時刻を書く。
- Bot は `version` が 1 でなければ使わない。`decisions` は、求めた項目が返ったときだけ使う（求めていない応答に `decisions` は無い）。

## 5. 有効にする手順

1. 鍵を作る（例：`openssl rand -hex 32` を所有者だけが読めるファイルへ。中身を表示・転記しない）。Bot ホストへは安全な経路で 1 回だけ写す。
2. 統合アプリ：`SMM_BOT_DATASOURCE_KEY_FILE` を設定して入れ替える（[deployment.md](../deployment.md)）。決定事項の台帳は、受信箱（`SMM_MAIL_DIR`）と同じ場所の `decisions.sqlite3` に置かれる（追加の設定は要らない）。
3. Bot：`config.toml` の `[kiban]` に `app_url`・`key_file` を書いて `enabled = true` にし、`sources` に `"decisions"` を足して再起動する。Bot は `kiban/decisions.md` を作る（`kiban.py` の `render_decisions`）。週1回のタスク一覧は、`sources` に関係なく `decisions` だけを別の要求で取る（`weekly_cog.py`）。統合アプリ側だけを先に出しても、Bot の動きは変わらない。この節の形は、統合アプリ（`app/src/server/decisions/bot.ts`）と Bot（`bot/src/iyakusai_bot/decisions_logic.py`）で 2026-11-04 に照合した。
4. 切り戻し：統合アプリを decisions に対応する前の版へ戻すときは、先に Bot の `sources` から `"decisions"` を外す。旧版は知らない `sources` を 401 で断るので、外さないと物品・受信箱の写しも止まる。

実装：`app/src/server/datasource/bot-datasource.ts`（統合アプリ）、`app/src/server/decisions/bot.ts`（決定事項の応答）、`bot/src/iyakusai_bot/kiban.py`（Bot）。
