# AGENTS.md

Claude Code Cerberus Gate は、最終回答を表示前に検証する TypeScript 製 Claude Code Mods である。

## 常に守る事項

- `main` への直接コミットは禁止する。作業ブランチでコミットし、必ず PR を作成する。
- 実装後は必ず Claude Code を使って実地検証し、検証用の起動では `haiku` モデルを明示指定する。
- Mutation 関連は導入しない。品質ルールは [コード品質](/docs/code-quality.md) に従う。
- `core.hooksPath` は変更しない。リポジトリの hook は共通 Git ディレクトリの `hooks/` に導入する。

## docs インデックス

方針・ルールの正本は `docs/` に置く。決定事項と提案・未検証の設計を区別し、方針を変更したら該当文書を更新する。
`tmp/` は Git 管理外の調査メモ・検証ログ用とし、方針の正本にしない。
Git 管理する文書は別リポジトリの直接参照を前提にせず、必要な方針・ルールをこのリポジトリ内に記載する。
常時参照する重要事項と、文書を追加・移動したときのインデックス更新は、このファイルに反映する。

- プロダクトの目的・対象範囲・回答の公開条件を検討するとき: [プロダクト方針](/docs/product-direction.md)
- Git 操作・hook 導入・Claude Code による実地検証・ローカル動作確認・CI を扱うとき: [開発と検証](/docs/development.md)
- Lint・行数・テストなどの検査を実装・変更するとき: [コード品質](/docs/code-quality.md)
