# Bot が自分から投稿する先（[notify]）

Bot が、コマンドやボタンへの返事ではなく、自分から（時刻・監視・別の処理の結果として）投稿するものの送り先を、`config.toml` の `[notify]` で一か所に決められます。`[notify]` が無ければ、今までどおり各機能の送り先へ送ります（後方互換）。

## 解決の順

1. `[notify.kinds].<種類>` があれば、その先。
2. 無ければ `[notify].channel_id`（既定）。ただし既定を使うのは下の表で「既定で変わる」になっている種類だけ。
3. どちらも無ければ、今までの送り先（各機能の設定）。

実装は `src/iyakusai_bot/notify.py`（`NotifySettings.resolve`・`routed_channel_id`）。設定の読み込みは `config.py`。

```toml
[notify]
channel_id = 1000000000000000003        # 既定の送り先(合成ID)
[notify.kinds]
reminder = 1000000000000000004          # リマインドはここへ(合成ID)
```

- 未知の種類・ID の形が違う・未知の項目は、起動時に止める（エラーの文面に種類の一覧を出す）。
- 上書き先が見えないときは、今までの送り先に戻す（リマインドとアプリ発の投稿）。タスク候補は戻さない（上書き先が使えなければ、その候補の投稿は「書けない」で失敗として残る）。
- 種類ごとの上書きを使うときは、上書き先がタスク機能の許可（`tasks` の `guild_ids`・`channel_ids`）に入っていること。候補の操作（差し戻し・承認）は、投稿された場所（経路の先・上書き先のどちらか）でだけ受け付ける。
- `weekly_tasks`（一覧）と `weekly_follow_up`（追い投稿）は別の種類。追い投稿の送り先は一覧と同じサーバーにある必要がある（外れると追い投稿だけ止まり、一覧は続く）。
- **上書き先の公開範囲に注意。** 上書き先が、元の経路より広く見えるチャンネル（例: 課の非公開チャンネルから、サーバー全員に見えるチャンネル）だと、その中身も広く見える。リマインドの本文（`reminder`）や、会話から抽出したタスク候補の件名（`task_candidates`）は、そのまま上書き先に出る。推奨は、元と同じ公開範囲のチャンネルに限ること。
- `weekly_tasks` と `weekly_follow_up` は、送り先が `@everyone` から見えるチャンネルだと起動時に止まる（一覧の中身は委員の情報のため。詳しくは [weekly-tasks.md](weekly-tasks.md)）。
- 統合アプリの Bot タブに出す共有先の id は、実際に投稿する先の id（上書き時は `app_share` の先）。

## 洗い出した一覧

Bot の投稿の箇所は、`grep` で `.send(`・`send_message`・`channel.send`・`get_channel`・`fetch_channel` を探して確かめた（2026-11-03 時点）。

| 種類（kind） | 投稿の中身 | 従来の送り先 | 既定（`channel_id`）で変わるか | 主なコード |
|---|---|---|---|---|
| `weekly_tasks` | 週1回のタスク一覧（引き受けボタン付き） | `[weekly].channel_id` | はい | `weekly_cog.py`・`weekly_service.py` |
| `weekly_follow_up` | 未割当タスクの追い投稿（引き受けボタン付き） | `[weekly].channel_id` | はい | `weekly_service.py` |
| `task_candidates` | タスク候補の投稿（承認待ち・自動起票のお知らせ） | `task_screening` の部局ごとの経路（`routes[].channel_id`） | いいえ（部局ごとの経路を保つ） | `screening_cog.py` の `_publish`・`_channel` |
| `reminder` | リマインドの通知（前日・期限・超過の催促） | `/remind` を登録したチャンネル | いいえ（登録した人のチャンネル） | `reminders.py` の `_notify` |
| `reminder`（アプリ発） | アプリで登録・完了・削除したリマインドの確認の投稿 | 依頼で選んだ通知先（`assistant.reminder_channel_ids`） | いいえ | `assistant_cog.py` の `_remind_create`・`_remind_change` |
| `haiku_digest` | 俳句の転記（`haiku.mode` が `digest` / `both`） | `haiku.channel_id` | はい | `haiku.py` の `_target_channel` |
| `collect_staleness` | 収集の遅れの知らせ（1 日 1 回） | `collect.staleness_channel_id` | はい | `collector.py` |
| `app_share` | 統合アプリ発の依頼（/ask・/doc・画像）の投稿と結果 | `assistant.share_channel_id`（#bottest） | はい | `assistant_cog.py` の `_share_channel`・`web_interaction.py` |

### 対象外（送り先を変えない）

| 投稿 | 理由 | 場所 |
|---|---|---|
| 俳句の返信（`haiku.mode` が `reply` / `both`） | 元の発言への返信で、送り先は元の場所そのもの | `haiku.py` の `on_message` |
| 俳句のリアクション（`react`） | 投稿ではなく、元の発言に 🎋 を付けるだけ | `haiku.py` |
| リマインドの停止のお知らせ（登録者への DM） | チャンネルではなく本人への DM | `reminders.py` の `_abandon` |
| コマンド・ボタンへの返事（ephemeral を含む） | 利用者への返事。送り先は応答先そのもの | 各 `*_cog.py`・`task_cog.py` |
| 編集・削除の記録（`edit_watch`） | 投稿しない（ファイルに書くだけ） | `edit_watch.py` |

## 試したこと

- `tests/test_notify.py`: 設定が無いときの従来の送り先、種類の上書き、既定の対象・対象外、不正な設定の拒否、`bot.cfg` が無い偽の bot、`load_config` の読み込み。
- 投稿先の上書きの実機（Discord）での確認は**未確認**。

## 残り

- 種類を増やすときは、`notify.py` の `NOTIFY_KINDS` と、この表の両方を直す。
- 統合アプリのリマインドの一覧に出る「通知先」は、登録したチャンネルの名前のまま。`reminder` を上書きしたときは、実際の送り先と一覧の表示が違う（通知そのものは上書き先へ届く）。表示も直すなら、アプリの Bot タブ側の表示を変える。
- `task_candidates` の上書きを使うときは、候補の承認・差し戻しのボタンが上書き先で動くかを実機で確かめる。
