# 開発と検証

## Git の運用と hooks

変更は作業ブランチでコミットし、必ず PR を作成して `main` に取り込む。
clone 後、リポジトリ内で `sh scripts/setup-hooks.sh` を実行して hook を導入する。
`main` 上のコミットは `pre-commit` hook が拒否する。

hook は共通 Git ディレクトリに配置し、worktree でも共有する。
既存の異なる hook は上書きせず停止する。
`core.hooksPath` は変更せず、設定済みならその hook が共通 Git ディレクトリへ処理を引き継ぐ必要がある。
ローカル hook は回避できるため、リモート側で PR 経由に制限するには GitHub のブランチ保護も必要となる。

## 開発環境

Node.js 24 以降と Claude Code 2.1.310 を使う。
`npm ci` で固定バージョンの npm 検査ツールを導入する。
続けて `npm run setup:checks` で actionlint と ShellCheck の固定版を準備する。
公式配布物の SHA-256 検証後、`node_modules/.cache/cerberus-checks/` に配置する。
グローバル環境は変更しない。
macOS／Linux の arm64・x64 に対応し、未対応環境やダウンロード失敗では停止する。
本体の TypeScript は Claude Code が直接読み込むため、配布用のビルド工程はない。
型定義の更新は [型定義の手順](/types/README.md) に従う。

## ローカルへのインストール

`make install` で、作業ツリーの `plugins/cerberus-gate` を未コミットの変更も含めて常用の Claude Code にインストールする。
ローカル marketplace `~/.claude/local-marketplaces/happyonigiri`（`happyonigiri-plugins`）へ実行時に読むファイルだけを複製し、`cerberus-gate@happyonigiri-plugins` としてユーザースコープに入れる。
テスト、`tsconfig.json`、生成された型定義は複製しない。
`CLAUDE_CONFIG_DIR` を設定していれば、その配下を使う。

marketplace.json は watchdog など他のプラグインと共有するため、`cerberus-gate` の項目だけを差し替え、他の項目は残す。
`claude plugin update` は `version` が同じ版を入れ替えないため、アンインストールしてから入れ直す。
アンインストールで消える `/config` の設定値は、事前に読み取ってインストール後に戻す。

反映には Claude Code の再起動が必要。
リリース済みの状態に戻すときは `main` で `make install` を実行する。

## 検査

`npm run check` をローカルと CI の共通の入口とする。
検査の範囲と規約は [コード品質](/docs/code-quality.md) に従う。
個別には `check:architecture`、`check:suppressions`、`docs:check`、`lint:workflows`、`lint:shell`、`lint:unused`、`test:coverage` を実行できる。
`test:coverage` は Node テストを一度だけ実行し、要約と `tmp/coverage/lcov.info` を生成する。
割合の閾値は設けない。
`test:scripts` はカバレッジを付けずに Node テストだけを実行したい場合に使う。
テストは判定・状態遷移に加え、審査から公開・修正・取消までの Hook の連携を検証する。
CI は固定版の Claude Code とネイティブ検査ツールを導入し、認証やモデル呼び出しを必要としない共通検査を実行する。
LCOV は `node-coverage` artifact に保存する。

## 実地検証

実装後は必ず Claude Code を用いた実地検証を行い、検証用の起動では `haiku` モデルを明示指定する。
これは検証の利用量を抑える指定であり、本体レビュアーは設定で選択する。
静的検査・スタブテストだけで実装完了とせず、実際の利用経路で確認する。

```sh
npm run test:live
```

認証済みの Claude Code と tmux が必要。実モデルを使うため利用量が発生する。
スクリプトは使い捨ての作業フォルダとプラグインの複製を作り、`haiku` 指定の対話セッションを起動する。
作成したテストフォルダの信頼確認だけを通し、実行後は自分が作った tmux セッションを終了する。
常用プラグインは入れ替えず、`--plugin-dir` で検証用の複製だけを読み込む。

`model` では `/cgate model` の選択 UI で haiku、続いて low effort を選び、両方のユーザースコープ設定への保存と、次の審査への適用を確認する。
設定結果の一時通知が表示され、3秒経過後に消えることも確認する。
通常回答ではモデルと effort の継承も確認する。
通常回答、レビュアーによる `Grep`・`Glob` の実行、誤った下書きからの修正・再審査、不正な審査応答による注記付きの表示、保留中の取消、10秒を超える審査、審査タイムアウト、作業中と審査中の Mod 再ロードを確認する。
長い審査では、3秒を超えても検証中のステータス表示が残ることを確認する。
追加プロンプトが修正依頼のときだけ送信され、合格・検証不能時には送信されないことも記録から検査する。
`reload-work` は使い捨ての設定ディレクトリで設定を変更して Mod を再ロードし、`reload-review` は検証用コピーのモジュールを更新して再ロードする。
常用設定やインストール済みプラグインは変更しない。
各ケースで `/cgate log` の経過表示を確認し、通常回答のケースでは `/clear` によるログ消去も確認する。
試験用の下書き識別文字列と不正な審査応答が通常画面に現れないこと、根拠ファイルが変更されないことも検査する。
検証で作った状態は試験用 Mod が用意し、製品コードに試験用の合格判定を入れない。
結果・画面・エンジンログは `tmp/live-probe/` に保存する。

この環境では Enter を改行、Ctrl+Enter を送信に設定しているため、既定では Ctrl+Enter を送る。
Enter で送信する環境では `CERBERUS_SUBMIT=enter npm run test:live` を使う。
特定のケースだけなら `npm run test:live -- pass` のように選ぶ。

[回答検証の仕組み](/docs/answer-gate.md) の公開条件と権限境界に影響する変更では、その動作も実地で確認する。
最新版への定期的な互換性検査は未導入。対象バージョンを上げる際は、型定義・CI の固定値・実地検証を合わせて更新する。
