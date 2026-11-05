# 議事録の処理役（α 2026-11-02）

統合アプリの「Bot › 議事録」で取り込んだ録音を、本番ホストの上で文字起こし（faster-whisper）し、要約（Claude Code CLI、ツール無効）して下書きにする常駐プログラム。設計は共有ドライブの `_目録/設計/議事録自動化_20261102/設計書.md`。

- アプリには**こちらから聞きに行く**（30 秒ごと）。アプリから処理役は呼ばない。
- やりとりは svc-auth/v1 の署名付き（クライアント `iyakusai-minutes-worker`）。鍵はアプリの `minutes.json` の `workerKeyFile` と同じ値。
- 音声はこのホストの中だけで扱う（外部の文字起こしサービスには送らない）。Claude に渡すのは文字起こしのテキストだけ。
- 同じ `minutes_worker.py` を 2 つの service で動かす（2026-11-02 の本番ホストの確認で決めた形）。
  - **文字起こし** `iyakusai-minutes-transcribe`：本番ホストには `python3-venv` も pip も無いので、ホストには何も入れず、`python:3.12-slim` の使い捨てコンテナで動かす（CPU 10 コア分・メモリ 6GB・優先度最低・1 件ずつ）。
  - **要約** `iyakusai-minutes-summarize`：Claude Code CLI がホストにあるので、ホストの `python3` で動かす（標準ライブラリだけで動く）。タスク候補のスクリーニングと同じ CLI・同じログイン（`CLAUDE_CONFIG_DIR`）を使う。

## 置き方（本番ホスト。委員長の承認を得てから）

1. アプリ側：鍵を作り、`mailbox.json` と同じフォルダに `minutes.json` を置いて、アプリを起動し直す。

   ```sh
   umask 077; head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > <compose のフォルダ>/config/minutes-worker.key
   cat > <compose のフォルダ>/config/minutes.json <<'EOF'
   { "version": 1, "workerKeyFile": "/config/minutes-worker.key", "audioRetentionDays": 14 }
   EOF
   ```

   アプリの中から見たパス（`/config/...`）で書く。`minutes.json` が無ければ議事録は無効のままで、今までと同じ。

2. 処理役：

   ```sh
   mkdir -p ~/iyakusai-minutes-worker/models && cd ~/iyakusai-minutes-worker
   cp <このフォルダ>/minutes_worker.py <このフォルダ>/test_minutes_worker.py <このフォルダ>/requirements.txt .
   install -m 600 <compose のフォルダ>/config/minutes-worker.key ./minutes-worker.key   # 同じ値
   cp <このフォルダ>/worker.env.example worker.env && chmod 600 worker.env && vi worker.env   # <利用者> を書き換える
   python3 -m unittest test_minutes_worker   # 単体試験（音声のモデルと Claude は使わない）
   # faster-whisper をコンテナの中で pylib/ に入れる（ホストの python には入れない）
   docker run --rm --user "$(id -u):$(id -g)" -e HOME=/w -v "$PWD":/w -w /w python:3.12-slim \
     pip install --quiet --no-cache-dir --target /w/pylib -r requirements.txt
   cp <このフォルダ>/iyakusai-minutes-transcribe.service <このフォルダ>/iyakusai-minutes-summarize.service ~/.config/systemd/user/
   systemctl --user daemon-reload
   systemctl --user enable --now iyakusai-minutes-summarize iyakusai-minutes-transcribe
   journalctl --user -u iyakusai-minutes-transcribe -u iyakusai-minutes-summarize -f   # 仕事が無ければ待つだけ
   ```

3. 初回の文字起こしでモデル（large-v3 は約 3GB、置き場の合計は約 4.8GB）を Hugging Face から取りに行く。`models/` に置かれ、以後はそこから読む。

## 止める・戻す

- 処理役だけ止める：`systemctl --user disable --now iyakusai-minutes-transcribe iyakusai-minutes-summarize`（取り込みはできるが、順番待ちのまま進まない）。
- 議事録ごと止める：`minutes.json` を退避してアプリを起動し直す（保存した議事録・音声は `minutes.sqlite3`・`minutes-audio/` に残る）。

## 本番ホストでの確認（2026-11-02）

記録の正本は共有ドライブの設計書 §2-3。ここには置き方に効くことだけを書く。

- 本番ホスト：Intel Core Ultra 7 265K（20 コア・AVX2/AVX-VNNI）、メモリ 30GB、GPU なし。
- 速さ（合成音声 11 分、CPU 8 スレッド・int8）：処理役の設定（`condition_on_previous_text=False`・用語のヒントつき）の large-v3 で 1 時間の会議を約 14 分。最大メモリ約 4.3GB。
- 要約：Claude Code CLI 2.1.227。処理役と同じ引数（`--strict-mcp-config`・ツール無効）で動き、11 分の会議で 36 秒。
- 依存：`faster-whisper==1.1.1` は `requests` が足りず、`1.2.1` も `av` 19 とは音声を開けなかった。`requirements.txt` で `av==15.1.0` に固定した。
- Caddy は `Permissions-Policy` を付けず、アプリの値がそのまま届く（今の本番は `microphone=()`）。α 版の反映で録音が許される。

## 長い会議（2026-11-05）

- faster-whisper 1.2.1 は、渡された音声（無音を除いたあと）の特徴量を一度に計算する。手元で測ると、その計算だけで**音声 1 時間あたり約 3.4GB**（10 分 0.57GB・30 分 1.72GB・60 分 3.44GB）。モデルと合わせると、コンテナの 6GB は 40 分前後の発言で足りなくなる見込みだった（11/3 の通しは短い録音）。
- そこで処理役は、音声を **10 分ずつ**（10 分の手前 60 秒の中で一番静かな 0.2 秒で区切って）読み、区切りごとに文字起こしして時刻をつなぐ（`audio_windows`・`transcribe`）。音声全体をメモリに置かないので、会議の長さでメモリが増えない。もともと前の文脈を使わない設定（`condition_on_previous_text=False`）なので、区切りで失うものは少ない。
- 確かめたこと（手元・large-v3・GPU）：合成音声 2 分の会議を 30 秒ずつに区切ると、区切りはすべて発言の間の無音に入り、議題 1〜12 がすべて残った（区切らない場合と同じ）。16 分の音声で numpy の確保の最大は、区切らない 0.85GB に対して 10 分ずつ 0.56GB。
- これに合わせて、録音ファイル 1 件の上限を 300MB から **2GB** に上げた（WAV で約 3 時間）。

## 進み具合（2026-11-05）

- 処理役は動いている段階の進み具合を、署名付きの `/v1/minutes/worker/progress` で約 20 秒に 1 回（区切りの終わりと要約の部分ごとには必ず）アプリに知らせる。文字起こしは録音の何秒まで済んだか、要約は何部分済んだか。画面はこれで進捗バー・割合・残りの目安を出す。
- 録音の長さは、文字起こしの前にデコードせずにパケットを最後までたどって測る（`audio_duration`。ADTS の AAC やブラウザの webm は入れ物に正しい長さが無いため。合成の 3.2 時間の ADTS（パケット約 54 万）を手元の PyAV 16 で 2.2 秒・誤差 0.1% 未満）。測れなければ割合を出さずに知らせる。
- 知らせは届かなくても処理を止めない。進み具合を受け取らない古いアプリ（Discord ログインの版は入口の検査で 403、それ以外は 404。2026-11-06 に本番の中継越しで 403 を確認）や借りが切れたとき（409）は、その仕事ではもう知らせない。だから、処理役とアプリはどちらを先に入れ替えてもよい。
- アプリは進み具合をメモリにだけ持つ（表は増えない）。アプリを起動し直すと、次の知らせ（20 秒以内）まで画面に出ない。
- **処理役の service を止めると、動いている文字起こしは途中で終わり、借りが切れる（8 時間）まで再開しない。** 入れ替えは、議事録に `transcribe_run`・`summarize_run` が無いときに。

## 聞き直しと差し戻し（2026-11-06）

- **文ごとの確からしさ**：文字起こしの各文に `confidence`（`avg_logprob`・`no_speech_prob`・`compression_ratio` と、確からしさ 0.5 未満の単語を低い順に 8 個まで）を付けて送る。画面の「聞き直す所」は、これと AI の「要確認」の時刻から聞き直す文を選び、その文だけを再生して直せる（基準は `src/shared/minutes.ts` の `DOUBT_THRESHOLDS`。アプリ側の値なので、文字起こしをやり直さずに変えられる）。
  - faster-whisper の `avg_logprob` などは 30 秒の窓ごとの値で、同じ窓の文はみな同じ数になる。文を分けるのは単語の確からしさなので、**単語の時刻（`word_timestamps`）を既定で取る**（`WHISPER_WORD_TIMESTAMPS=0` で止められる）。
  - 手元の測定（large-v3・CPU 8 スレッド・int8、合成の 270 秒の会議に 60 秒の雑音を重ねたもの）：文字起こしは 159 秒 → 190 秒（約 2 割増し）。処理役の `transcribe` をそのまま本物のモデルで通すと 63 文のうち 14 文が挙がり、雑音の区間の文すべて、「協賛」を「協産」と聞いた文、録音の最後の空耳（「ありがとうございました」）を拾った。雑音の無い所で挙がったのは 2 文。出力はアプリの検査（`transcriptSchema`）を通った。
- **差し戻し**：アプリが要約の仕事に `review`（コメント・前の下書き・人が直した今の本文・前に答えたコメント）を付けたら、処理役は下書きをコメントに沿って直し（`build_revise_prompt`）、結果に `reviewId` と AI の答え `reply` を付けて返す。人が聞き直して直した文は `checked: true` で届き、指示文では［確認済み］を付けて正として扱わせる。
- **反映の順**：アプリを先に、処理役をあとに。新しい処理役は文字起こしの結果に `confidence` を付けるので、古いアプリには断られる（文字起こしの失敗になる）。古い処理役は新しいアプリの `review` を読まずに新しい下書きを返すが、アプリはそれを使わず、そのコメントを「手直しできず」にする（下書きはそのまま）。

## 確かめていないこと

- 本物の会議の声（複数人・雑音・遠い声）での聞き取りの正しさ。測定は合成音声 1 人分。
- 2 つの service を本番の systemd で実際に動かすこと（書式は `systemd-analyze verify` で確かめた）。
