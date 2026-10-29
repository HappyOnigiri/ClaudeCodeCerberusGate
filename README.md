# Claude Code Cerberus Gate

Claude Code の最終回答を、表示する前に審査するプラグインです。
審査用モデルが会話や実ファイルと照合し、修正が必要ならメインエージェントへ差し戻します。

## 特徴

- **根拠を確認** — セッションのツールを使い、依頼・会話・実ファイルと回答を照合します。
- **修正して再審査** — 指摘と根拠をメインエージェントへ返し、修正後の回答を再び審査します。
- **合格した回答をそのまま表示** — 合格後はモデルに書き直させず、保留していた本文を公開します。
- **審査を調整** — モデル・effort・審査の観点を設定できます。

審査の結果は `[PASS]`・`[REVISE]`・`[UNVERIFIED]`・`[ERROR]` で始まるログ行で表示します。検証を完了できなかった回答には、未検証である旨をこのログ行で添えます。ログ行は本文に含めず、モデルには渡しません。
メインエージェントが起動したサブエージェントやバックグラウンドのシェルが動いている間の短い途中報告は審査せず、`[SKIP]` のログ行を添えて表示します。
審査用モデルには副作用のある操作を禁止し、通常の権限確認を維持します。
副作用の禁止はプロンプトによる指示であり、機械的な保証ではありません。

## インストール

**Claude Code 2.1.310 以降**、**Node.js 24 以降** が必要です。
対象は Claude Code の対話セッションです。非対話の `claude -p`・Agent SDK・Claude Desktop のルーティンでは審査せず、回答をそのまま表示します。

Claude Code で次の2つを実行してください。

```text
/plugin marketplace add HappyOnigiri/ClaudeCodeCerberusGate
/plugin install cerberus-gate@cerberus-gate
```

審査用をインストールすると、依存する描画用も自動で導入されます。
Claude Code を再起動すると有効になります。
更新時は `/plugin marketplace update cerberus-gate` と `/plugin update cerberus-gate@cerberus-gate` を実行し、再起動してください。

リリース済みのバージョンと変更内容は [Releases](https://github.com/HappyOnigiri/ClaudeCodeCerberusGate/releases) で確認できます。
採番と日次・手動リリースの手順は [開発と検証](/docs/development.md#バージョンとリリース) を参照してください。

## 使い方

インストール後は、普段どおり Claude Code に依頼してください。
既定で審査が有効になり、最終回答の表示前に審査が始まります。

```text
最終回答案 → 審査 → 合格した本文を表示
               └→ 修正依頼 → 修正した回答を再審査
```

修正依頼の指摘と根拠は、Ctrl+O の詳細表示で確認できます。
もう一度 Ctrl+O を押すと折りたたみます。

| コマンド                   | 操作                                               |
| -------------------------- | -------------------------------------------------- |
| `/cgate`                   | 表示・設定変更用のメニューを開く                   |
| `/cgate history`           | このセッションの審査経過・指摘・根拠をパネルに表示 |
| `/cgate log`               | デバッグログの保存場所と保存状態を表示             |
| `/cgate model`             | 審査用モデルと effort を選択                       |
| `/cgate language`          | 表示・組み込みプロンプトの言語を選択               |
| `/cgate on` / `/cgate off` | 審査を有効化・無効化し、適用範囲を選択             |
| `/cgate reset`             | セッションの一時設定を解除                         |
| `/cgate cancel`            | 保留中の処理を取消                                 |

`/cgate` のメニューから、状態・履歴・ログ保存先の確認、有効・無効と適用範囲の変更、モデル・effort と言語の選択、保留処理の取消ができます。
メニューは全項目をボタンで表示し、数字キー（1〜9）または Tab / Shift+Tab と Enter で選べます。
設定の選択画面では上下キーと Enter を使い、Esc で閉じます。
「戻る」ボタンで前の画面に戻れます。
選択画面では `Shift+Tab` で「戻る」に移動し、Enter で実行できます。
effort の画面からはモデル選択へ、それ以外の画面からはメニューへ戻ります。
左キーで戻る操作は、標準の選択画面では利用できません。
画面幅に応じてサイドパネルまたはインラインで表示されます。
モバイルでは状態と個別コマンドの案内を表示します。

言語の既定値は英語（`en`）です。
メニューの `Language`、または `/cgate language` から `日本語` を選ぶと、保存してその場で切り替わります。
`/config` の Cerberus Gate の `Language` からも変更できます。
ログ・画面表示に加えて、組み込みの審査基準、調査手順、修正依頼、再ロード後の再開依頼も日本語になります。
独自の審査プロンプト（`reviewPrompt`）は、設定した文章をそのまま使います。

審査用モデルと effort の既定値は `inherit` で、回答を生成したステップの設定を引き継ぎます。
審査の観点や修正回数・審査時間の上限は `/config` で変更できます。
途中報告とみなす文字数の上限（`interimMaxChars`、既定 500）も `/config` で変更でき、0 にすると途中報告による審査の省略を無効にします。
修正回数が上限に達した後の回答は審査せずに表示し、`[SKIP]` のログ行で知らせます。
修正回数の上限（`maxRevisions`）を 0 にすると初稿から審査を省略します。
公開条件・権限境界や設定変更の注意点は [回答検証の仕組み](/docs/answer-gate.md) を参照してください。

## 開発

`make install` は開発用です。
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

## デバッグログ

詳細ログは常時有効で、依頼・未公開原稿・モデル入力と生応答・ツール引数と結果・例外詳細を含みます。
審査時点の標準ログの固定コピーと展開資料も保存します。
保存先は `CLAUDE_CONFIG_DIR`（未指定時は `~/.claude`）配下です。

```text
cerberus-gate/debug/<sessionId>/
  index.jsonl
  <instanceId>/
    events.jsonl
    reviews/<epoch>-<reviewToken>/
      source.jsonl
      users.txt
      history.txt
```

セッション ID が分かれば `cerberus-gate/debug/<sessionId>/index.jsonl` を開き、`path` をセッションディレクトリからの相対パスとして解決してください。
起動・再ロードごとのログと、保存に成功した審査資料が索引に追記されます。
索引の保存失敗時には `<instanceId>/reviews/` 内も探索してください。
デバッグ保存は `/clear`・終了後も保持し、自動削除・ローテーションは行いません。
メモリ内の履歴は従来どおり `/clear`・終了・再ロードで消えます。
強制終了・アンロードで末尾が未保存になる場合は、完全な JSONL 行までを解析してください。
保存失敗は3秒の通知と履歴に表示し、`/cgate log` から確認できます。
保存できなくても回答の検証は続けます。

## ライセンス

[MIT License](/LICENSE)
