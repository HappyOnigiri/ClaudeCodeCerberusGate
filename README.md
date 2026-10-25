# Claude Code Cerberus Gate

Claude Code の最終回答を表示前に検証する TypeScript 製 Mods。
読み取り専用の Side Agent が根拠を確認し、修正が必要なら本文を保留してメインエージェントへ戻す。
合格した本文をそのまま公開する。

## 起動

Claude Code 2.1.310 の対話セッションで、リポジトリから起動する。

```sh
claude --plugin-dir "$PWD/plugins/cerberus-gate"
```

`/cerberus` で状態確認、`/cerberus cancel` で保留中の処理を取り消せる。
非対話の `claude -p` は対象外で、未検証本文を出さずに通知する。

レビュアーのモデル、修正回数・審査時間の上限、読み取り専用 MCP ツールの一覧はプラグインの設定項目で変更する。
MCP の初期状態は不許可。検索ツールの完全一致の名前を明示し、エンジンが読み取り専用と判定する呼び出しだけを許可する。

## 開発

`npm ci` と `sh scripts/setup-hooks.sh` でセットアップする。
`npm run check` で自動検査、`npm run test:live` で haiku を使った TUI 実地検証を行う。

[開発と検証](/docs/development.md) と [回答検証の仕組み](/docs/answer-gate.md) に手順・対応範囲を記載している。
方針・ルールの一覧は [AGENTS.md](/AGENTS.md) のインデックスを参照する。
