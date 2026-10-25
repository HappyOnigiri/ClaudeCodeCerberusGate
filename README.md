# Claude Code Cerberus Gate

Claude Code の最終回答を表示前に検証する TypeScript 製 Mods。
審査用モデルと読み取り専用ツールが根拠を確認し、修正が必要なら本文を保留してメインエージェントへ戻す。
合格した本文は追加プロンプトを送らず、元のターンでそのまま公開する。

## 起動

Claude Code 2.1.310 の対話セッションで、リポジトリから起動する。

```sh
claude --plugin-dir "$PWD/plugins/cerberus-gate" --plugin-dir "$PWD/plugins/cerberus-gate-display"
```

常用の Claude Code に入れるときは `make install` を使う。
作業ツリーの状態を未コミットの変更も含めて `cerberus-gate@happyonigiri-plugins` と `cerberus-gate-display@happyonigiri-plugins` としてインストールし、Claude Code の再起動後に有効になる。

修正・再開用プロンプトは通常画面で `Prompt from the cerberus-gate plugin` の見出しだけを表示する。
Ctrl+O の詳細表示でプロンプト本文を展開でき、もう一度 Ctrl+O を押すと折りたたむ。
これは会話全体の詳細表示の切替であり、見出しのクリックによる個別の展開ではない。
描画用プラグインはターミナルの表示だけを変更し、モデルに渡す修正依頼や保存する会話は変更しない。
審査用プラグインだけで起動した場合は、従来どおりプロンプト本文も表示する。

`/cgate` で状態確認、`/cgate log` でこのセッションの動作ログを表示する。
審査開始・判定・修正依頼・公開・タイムアウト・取消を UTC の時刻付きで確認できる。
`/cgate cancel` で保留中の処理を取り消せる。
検証中のステータス表示は検証終了まで維持する。
設定結果やエラーなどは標準の一時通知として表示し、通常は3秒後に消える。
従来の `/cerberus` と `/cerberus cancel` も利用できる。

ログは直近 1,000 件をメモリ上に保持し、古い記録の省略件数を表示する。
未公開の回答案・レビュー指摘・依頼本文は含めない。
`/clear`、別セッションへの切替、終了、プラグインの再ロードで消去され、再開時には復元しない。
非対話の `claude -p` は対象外で、未検証本文を出さずに通知する。
検証を完了できなかった回答は、未検証である旨の注記を付けて本文をそのまま表示する。

`/cgate model` で検査用モデルの選択 UI を開き、`inherit`・`haiku`・`sonnet`・`opus`・`fable` から選べる。
現在の設定がモデル ID の場合は、その値も選択肢に表示する。
モデルを選ぶと保存され、続いて effort（`inherit`・`low`・`medium`・`high`・`xhigh`・`max`）を選べる。
現在のモデルを選び直せば effort だけ変更できる。
Esc は表示中の選択を保存せず閉じる。effort の画面で閉じても、保存済みのモデルは維持する。
選択した値は Claude Code の設定 API で保存し、次の審査から使う。

レビュアーのモデルと effort、修正回数・審査時間の上限、読み取り専用 MCP ツールの一覧はプラグインの設定項目で変更する。
`reviewerModel` と `reviewerEffort` の既定値は `inherit` で、最終回答を生成したステップのモデルと effort を引き継ぐ。
`/config` でモデル ID や effort（`inherit`・`low`・`medium`・`high`・`xhigh`・`max`）を設定できる。
モデルが対応しない effort はエンジン側の制約に従う。
元のステップの effort が数値の場合、審査 API は数値を受け付けないため、審査モデルの既定値を使う。
選択 UI からの保存先はユーザースコープの `~/.claude/settings.json` の `pluginConfigs[<plugin>].options`。
`CLAUDE_CONFIG_DIR` を指定した場合は、その配下の `settings.json` に保存する。
MCP の初期状態は不許可。検索ツールの完全一致の名前を明示し、エンジンが読み取り専用と判定する呼び出しだけを許可する。

## 開発

`npm ci` と `sh scripts/setup-hooks.sh` でセットアップする。
`npm run check` で自動検査、`npm run test:live` で haiku を使った TUI 実地検証を行う。

[開発と検証](/docs/development.md) と [回答検証の仕組み](/docs/answer-gate.md) に手順・対応範囲を記載している。
方針・ルールの一覧は [AGENTS.md](/AGENTS.md) のインデックスを参照する。

## 有効・無効の切り替え

| 操作                                           | 効果                                                                     |
| ---------------------------------------------- | ------------------------------------------------------------------------ |
| `/cgate on` / `/cgate off`                     | 有効・無効をユーザースコープに保存し、このセッションの一時設定を解除する |
| `/cgate on --session` / `/cgate off --session` | 保存済みの設定を変えず、このセッションだけ上書きする                     |
| `/cgate reset --session`                       | 一時設定を解除して保存済みの設定へ戻す                                   |
| `/cgate`                                       | 有効状態（on/off）、設定元（saved/session）、検証処理の状態を表示する    |

既定は有効。`enabled` は `/config` でも変更できる。
一時設定はプラグイン再ロードでは維持し、`/clear`・別セッションへの切替・終了で解除する。
無効の間は回答を審査せず、通常どおり表示する。
審査中・修正依頼の配信待ちに無効化した場合は、保留中の回答と修正依頼を取り消し、新しい依頼が必要な旨を表示する。
有効化は次の回答ステップから適用する。
