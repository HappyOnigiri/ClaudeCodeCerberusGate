# Claude Code Cerberus Gate

Claude Code の最終回答を表示前に検証する Mods。

## Git hooks の導入

clone 後、リポジトリ内で次を実行する。

```sh
sh scripts/setup-hooks.sh
```

`main` 上のコミットは `pre-commit` hook が拒否する。
変更は作業ブランチでコミットし、PR 経由で取り込む。
hook は共通 Git ディレクトリに配置するため、同じリポジトリの worktree でも共有する。
既存の異なる `pre-commit` hook がある場合は上書きせず、エラーで停止する。

`core.hooksPath` は変更しない。
この設定がある環境では、指定先の hook が共通 Git ディレクトリの hook へ処理を引き継ぐ必要がある。

ローカル hook は `--no-verify` などで回避できるため、強制的な PR 制限には GitHub 側のブランチ保護も必要となる。
