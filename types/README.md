# Claude Code の型定義

`claude-code/` と `claude-code-tools/` は Claude Code 2.1.310 が生成した型定義。
CI で認証済み対話セッションを必要とせずに型チェックできるよう、このバージョンの型を保存する。
MCP 接続固有の生成ファイルは含めない。

対象バージョンを更新するときは、対話セッションで次を実行し、生成された同名ディレクトリをこの場所へ反映する。

```sh
claude --model haiku --plugin-dir ./plugins/cerberus-gate
```

生成先は `plugins/cerberus-gate/.claude-plugin/types/`。
変更後は `npm run check` と `npm run test:live` で互換性を確認する。
