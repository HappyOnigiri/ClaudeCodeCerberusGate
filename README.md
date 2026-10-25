# Claude Code Cerberus Gate

Claude Code の最終回答を、表示する前に審査するプラグインです。
審査用モデルが会話や実ファイルと照合し、修正が必要ならメインエージェントへ差し戻します。

## 特徴

- **根拠を確認** — セッションのツールを使い、依頼・会話・実ファイルと回答を照合します。
- **修正して再審査** — 指摘と根拠をメインエージェントへ返し、修正後の回答を再び審査します。
- **合格した回答をそのまま表示** — 合格後はモデルに書き直させず、保留していた本文を公開します。
- **審査を調整** — モデル・effort・審査の観点を設定できます。

検証を完了できなかった回答は、未検証である旨の注記を付けて表示します。
審査用モデルには副作用のある操作を禁止し、通常の権限確認を維持します。
副作用の禁止はプロンプトによる指示であり、機械的な保証ではありません。

## インストール

**Claude Code 2.1.310**、**Node.js 24 以降**、**Git**、**make** が必要です。
対象は Claude Code の対話セッションで、非対話の `claude -p` は対象外です。

```sh
git clone https://github.com/HappyOnigiri/ClaudeCodeCerberusGate.git
cd ClaudeCodeCerberusGate
make install
```

審査用と描画用の2つのプラグインをユーザースコープにインストールします。
Claude Code を再起動すると有効になります。
再インストールにも `make install` を使い、保存済みの設定を引き継ぎます。

## 使い方

インストール後は、普段どおり Claude Code に依頼してください。
既定で審査が有効になり、最終回答の表示前に審査が始まります。

```text
最終回答案 → 審査 → 合格した本文を表示
               └→ 修正依頼 → 修正した回答を再審査
```

修正依頼の指摘と根拠は、Ctrl+O の詳細表示で確認できます。
もう一度 Ctrl+O を押すと折りたたみます。

| コマンド                   | 操作                                       |
| -------------------------- | ------------------------------------------ |
| `/cgate`                   | 有効状態と処理状況を確認                   |
| `/cgate log`               | このセッションの審査経過・指摘・根拠を表示 |
| `/cgate model`             | 審査用モデルと effort を選択               |
| `/cgate on` / `/cgate off` | 審査を有効化・無効化し、適用範囲を選択     |
| `/cgate reset`             | セッションの一時設定を解除                 |
| `/cgate cancel`            | 保留中の処理を取消                         |

審査用モデルと effort の既定値は `inherit` で、回答を生成したステップの設定を引き継ぎます。
審査の観点や修正回数・審査時間の上限は `/config` で変更できます。
公開条件・権限境界や設定変更の注意点は [回答検証の仕組み](/docs/answer-gate.md) を参照してください。

## 開発

リポジトリから一時的に起動する場合は、インストールの代わりに次のコマンドを使ってください。

```sh
claude --plugin-dir "$PWD/plugins/cerberus-gate" --plugin-dir "$PWD/plugins/cerberus-gate-display"
```

`npm ci` と `sh scripts/setup-hooks.sh` で開発環境を準備します。
`npm run setup:checks` で検査ツールを導入し、`npm run check` で自動検査を実行します。
`npm run test:live` では haiku を使った対話セッションの実地検証を行います。

手順は [開発と検証](/docs/development.md)、仕様は [回答検証の仕組み](/docs/answer-gate.md) を参照してください。

## コントリビュート

不具合の報告や提案は [Issues](https://github.com/HappyOnigiri/ClaudeCodeCerberusGate/issues) へお寄せください。
修正やドキュメントの改善は [Pull requests](https://github.com/HappyOnigiri/ClaudeCodeCerberusGate/pulls) で受け付けています。
