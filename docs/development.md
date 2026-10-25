# 開発と検証

## セットアップと Git

対応バージョンは [package.json](/package.json) と [README](/README.md#インストール) を参照する。
`npm ci`、`npm run setup:checks`、`sh scripts/setup-hooks.sh` で検査ツールと hook を導入する。
型定義の更新は [型定義の手順](/types/README.md) に従う。

変更は作業ブランチから PR 経由で `main` に取り込む。
`pre-commit` は `main` 上のコミットを拒否するが、リモートでの強制にはブランチ保護が必要。
hook は worktree 共通の Git ディレクトリに置き、異なる既存 hook は上書きせず停止する。
`core.hooksPath` は変更しない。
設定済みなら、その hook から共通 Git ディレクトリへ処理を引き継ぐ必要がある。

## 常用環境へのインストール

`make install` は未コミット変更を含む作業ツリーの審査・描画用プラグインを常用の Claude Code へ入れる。
共有の marketplace と設定では、他のプラグインの項目を残す。

`claude plugin update` は同じ `version` を入れ替えないため、アンインストール後に再インストールする。
消える `/config` の設定値は事前に読み取り、元の型で復元する。
`claude plugin configure --values-stdin` は複数行を拒否するため設定ファイルへ戻し、インストールが書いた他の設定も保持する。
反映には Claude Code の再起動が必要。

## 自動検査

`npm run check` がローカル・CI 共通の検査コマンド。
規約は [コード品質](/docs/code-quality.md) に従う。
個別の検査コマンドは [package.json](/package.json) を参照する。
CI の共通検査には認証・モデル呼び出しを要求しない。

## 実地検証

Mods の動作に関わる変更後は静的検査・スタブテストだけで完了とせず、認証済み Claude Code と tmux で実地検証する。
ドキュメントの変更など、Mods の動作に関わらない変更だけの場合は実地検証を省略する。
検証用の起動モデルは利用量を抑えるため `haiku` を明示する。
本体レビュアーのモデル設定とは別に扱う。

```sh
npm run test:live
```

[live-probe.mjs](/scripts/live-probe.mjs) は使い捨ての作業フォルダとプラグイン複製を用意し、`--plugin-dir` で対話セッションを起動する。
作成したフォルダの信頼確認だけを通し、自身の tmux セッションを終了する。
常用設定・プラグインは変更しない。
テスト用 Mod で異常応答や待機状態を作り、製品コードには試験用の合格判定を入れない。

特定ケースは `npm run test:live -- pass` のように指定する。
ケースの検査内容を変えるときは、スクリプトと [live-materials.mjs](/scripts/live-materials.mjs) を確認する。
変更した公開条件・権限境界も実地で確認する。
既定の送信キーは Ctrl+Enter。
Enter で送信する環境では `CERBERUS_SUBMIT=enter npm run test:live` を使う。

CLI の実行成功は全 MCP 接続の検証を意味しない。
根拠・原稿を用意する再構成試験は、過去の会話の再生や新旧プロンプトの検出率比較ではない。
対応バージョンを上げる際は型定義・CI の固定値・実地検証を合わせて更新する。

詳細ログの検証では `/cgate log` の絶対パスを開き、開始・完了・失敗の操作 ID・入力・生応答を照合する。
[live-debug.mjs](/scripts/live-debug.mjs) が索引から各インスタンス・審査資料を列挙し、順序・相関 ID・権限・資料内容を照合する。
通常画面と `/cgate history` には依頼・原稿・生応答・例外詳細が出ないことを検査する。
