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

## TypeScript の実行と型検査

開発スクリプトと Node テストは `.ts`、同梱の Node ヘルパーは `.mts` で記述する。
ヘルパーはプラグイン単体で配布されるため、親の `package.json` に依存せず ES Modules として動く拡張子を使う。
Node.js 24 以上の型除去で直接実行し、ビルドは挟まない。
`enum` など変換が必要な構文は `erasableSyntaxOnly` で禁止する。

`npm run typecheck` は全コードを検査した後、ホスト内のコードを Node の型定義なしでも検査する。
全体の設定は [tsconfig.json](/tsconfig.json)、ホスト用は [tsconfig.plugins.json](/tsconfig.plugins.json) を参照する。

## 開発版のインストール

`make install` は未コミット変更を含む作業ツリーの審査・描画用プラグインを常用の Claude Code へ入れる。
共有の marketplace と設定では、他のプラグインの項目を残す。

`claude plugin update` は同じ `version` を入れ替えないため、アンインストール後に再インストールする。
消える `/config` の設定値は事前に読み取り、元の型で復元する。
`claude plugin configure --values-stdin` は複数行を拒否するため設定ファイルへ戻し、インストールが書いた他の設定も保持する。
反映には Claude Code の再起動が必要。

公開版が有効な環境では `make install` は変更前に停止する。
開発時は README の `--plugin-dir` で両方を読み込む。

## 公開版への移行

通常の導入と更新は [README](/README.md#インストール) に従う。
ルートの marketplace は `cerberus-gate`、従来の開発用は `happyonigiri-plugins` として共存する。
公開版は審査用の `dependencies` により同じ marketplace の描画用を自動導入する。
バージョンの正本は各プラグインの manifest とし、marketplace に重複定義しない。

旧 `make install` 利用者は、すべての対話セッションを終了してから、更新したリポジトリで次を実行する。

```sh
npm run migrate
```

`CLAUDE_CONFIG_DIR` が設定されていれば、その環境だけを対象にする。
旧版のユーザースコープの状態と設定を確認し、公開版と依存先を導入して設定を検証した後、旧版2つを無効化する。
旧審査用が無効なら公開版も無効にする。
審査設定の型と複数行を保持し、廃止済みの `readOnlyMcpTools`、保留原稿、セッションの復元状態は移さない。
旧版の設定・データ、共有 marketplace、他のプラグインは残す。

不正な設定 JSON、公開 marketplace の取得元の不一致、別スコープの対象プラグインを検出したら変更前に停止する。
設定が衝突する場合はキーだけを表示するため、新旧の設定を確認してから再実行する。
設定値や審査プロンプトはログに出さない。
失敗時は今回変更した設定キーと有効状態を戻し、追加された公開版は無効で残す。
復元に失敗した場合は表示された操作に従って公開版を無効化し、設定を確認してから再実行する。
常用環境を変更するため、完了後は Claude Code を再起動する。

隔離試験では `npm run migrate -- --marketplace-source <source>` でローカル Git リポジトリも指定できる。
公開 GitHub からの導入は変更が公開先へ反映された後に、別の `CLAUDE_CONFIG_DIR` で README の2操作を確認する。

## 自動検査

`npm run check` がローカル・CI 共通の検査コマンド。
規約は [コード品質](/docs/code-quality.md) に従う。
個別の検査コマンドは [package.json](/package.json) を参照する。
CI の共通検査には認証・モデル呼び出しを要求しない。

## バージョンとリリース

審査用・描画用の `plugins/*/.claude-plugin/plugin.json` の `version` を同じ番号で管理する。
番号は `X.Y.Z` 形式とし、リリース PR で両方を更新する。
ルートの package.json と marketplace にはバージョンを重複定義しない。

[Release ワークフロー](/.github/workflows/release.yml) は毎日 03:17 JST の定期実行と手動実行に対応する。
定期実行と手動の `automatic: true` は同じ自動運用を使い、前回 GitHub Release の公開日時以降に main へマージされた PR から採番する。
main への直接 push はこの判定の対象に含めない。

| 対象 PR                                                                 | 採番・終了条件                                           |
| ----------------------------------------------------------------------- | -------------------------------------------------------- |
| `feat:` を含む                                                          | minor を上げる                                           |
| `fix / perf / refactor / chore / ci / docs / build / style / test` のみ | patch を上げる                                           |
| `!` 付きタイトル、または本文に `BREAKING CHANGE:`                       | 停止し、手動で major または version を指定する           |
| リリース PR を除いた対象がない                                          | 自動運用は正常終了でスキップ、通常の手動の auto はエラー |
| prefix を判定できない、API エラー、manifest の不備・バージョン不一致    | エラーで停止する                                         |

公開済みの通常 Release がない場合、auto は main への全マージ済み PR を同じ規則で判定する。
リリース PR を除外し、`feat:` があれば manifest の現在の番号から minor を上げる。
現在の `0.1.1` を起点とし、`feat:` を含む初回は `0.2.0` になる。
手動の version 指定時は、manifest の現在の番号より大きい値を使う。

自動運用はリリース PR を作成し、CI の成功を確認した後に自身で merge commit によるマージを実行する。
採番後は `post-bump-command` で manifest を整形し、整形済みの1つのコミットでリリース PR を作成する。
その最終コミットに対する `ci.yml` の push・pull_request 両方の実行と、各実行の `checks` ジョブの成功を待つ。
チェック未登録・実行中・GitHub のマージ可否の計算中は最大10分待機し、時間切れでは失敗する。
CI の失敗・キャンセル・スキップ、ジョブの欠落、API エラー、競合、待機中の PR 更新・クローズではマージしない。
マージ時にも `--match-head-commit` で検証済みの最終コミットを指定する。
未マージの `release/vX.Y.Z` PR がある場合、自動運用は新しいリリースの準備をスキップする。
通常の手動運用で作ったリリース PR を、自動運用が自動マージの対象にすることもない。
手動実行の `automatic` は既定で `false` とし、通常は人が PR をマージする。
`automatic: true` を選ぶと、日次実行を待たずに自動マージ・公開までの経路を起動できる。
version の直接指定と auto / major / minor / patch の指定は、どちらの手動運用でも使える。
通常の手動運用では、CI によるマージ処理は動かさない。
準備処理は共通の concurrency グループで直列化する。

```sh
gh workflow run release.yml --ref main -f automatic=true -f bump=auto
```

[Publish Release ワークフロー](/.github/workflows/publish-release.yml) は、同一リポジトリのリリース PR が main へマージされた後に動く。
マージコミットにタグ `vX.Y.Z` を付け、PR 本文をノートにした GitHub Release を公開する。
成功したリリースのブランチは削除する。
共通 Action は自分で管理する ReleaseActions の main を参照し、最新の変更に追従する。
初回採番・CI 待機の実装とテストは ReleaseActions 側で管理し、このリポジトリには運用設定を置く。

| 設定・Action         | 担当                                                                            |
| -------------------- | ------------------------------------------------------------------------------- |
| Release ワークフロー | 実行時刻、手動・自動運用の選択、対象 manifest、整形コマンド、待機する CI の指定 |
| `prepare-release`    | 初回を含む採番、既存 PR・変更なしのスキップ、整形後のコミットと PR 作成         |
| `merge-release`      | 指定した CI の待機と成功判定、検証済みコミットのマージ                          |
| `publish-release`    | マージコミットへのタグ付けと GitHub Release の公開                              |

### GitHub 側の事前設定

- repository secret の `GH_TOKEN` に、ブランチの push・PR 作成とマージ・ラベル作成・CI 参照・Release 公開が可能な PAT を登録する。
  `GITHUB_TOKEN` に置き換えると後続の PR / マージイベントの CI が起動しないため、PAT を使う。
- リポジトリの merge commit を有効にする。
  squash merge と rebase merge は無効のため、リリース PR も merge commit でマージする。

GitHub の自動マージ予約は使わず、CI 成功の判定をリリース CI 内で行う。
リポジトリの自動マージの有効化と、main の必須チェックの設定は、この運用の必須条件ではない。
既存のブランチ保護ルールがある場合は、通常のマージと同様に従う。

## 実地検証

Mods の動作に関わる変更後は静的検査・スタブテストだけで完了とせず、認証済み Claude Code と tmux で実地検証する。
ドキュメントの変更など、Mods の動作に関わらない変更だけの場合は実地検証を省略する。
検証用の起動モデルは利用量を抑えるため `haiku` を明示する。
本体レビュアーのモデル設定とは別に扱う。

```sh
npm run test:live
```

[live-probe.ts](/scripts/live-probe.ts) は使い捨ての作業フォルダとプラグイン複製を用意し、`--plugin-dir` で対話セッションを起動する。
作成したフォルダの信頼確認だけを通し、自身の tmux セッションを終了する。
常用設定・プラグインは変更しない。
テスト用 Mod で異常応答や待機状態を作り、製品コードには試験用の合格判定を入れない。

特定ケースは `npm run test:live -- pass` のように指定する。
ケースの検査内容を変えるときは、スクリプトと [live-materials.ts](/scripts/live-materials.ts) を確認する。
`npm run test:live -- cli` は審査ツール一覧から `Grep` を外し、CLI による履歴検索と審査完了を確認する。
`npm run test:live -- recover` は存在しないファイルをレビュアーに読ませ、実行エラーが調査結果として返り、再試行後に公開されることを確認する。
変更した公開条件・権限境界も実地で確認する。
既定の送信キーは Ctrl+Enter。
Enter で送信する環境では `CERBERUS_SUBMIT=enter npm run test:live` を使う。

CLI の実行成功は全 MCP 接続の検証を意味しない。
根拠・原稿を用意する再構成試験は、過去の会話の再生や新旧プロンプトの検出率比較ではない。
Mod は Claude Code 2.1.310 以降で動作し、型定義と CI は 2.1.310 に固定する。
新しい版で動作が変わったときや最低版を上げるときは、型定義・CI の固定値・実地検証を合わせて更新する。

詳細ログの検証では `/cgate log` の絶対パスを開き、開始・完了・失敗の操作 ID・入力・生応答を照合する。
[live-debug.ts](/scripts/live-debug.ts) が索引から各インスタンス・審査資料を列挙し、順序・相関 ID・権限・資料内容を照合する。
通常画面と `/cgate history` には依頼・原稿・生応答・例外詳細が出ないことを検査する。

## 配布経路の実地検証

```sh
npm run test:distribution
```

一時 Git リポジトリをローカル marketplace として登録し、隔離した `CLAUDE_CONFIG_DIR` で依存先の自動導入、移行、再実行、更新後の設定保持を検証する。
この試験はローカルディレクトリ経由であり、GitHub からの取得・更新は公開先反映後に別途確認する。
使い捨ての設定ディレクトリは `tmp/distribution-report.json` の `config` に記録する。
このパスを `CERBERUS_INSTALLED_CONFIG` に指定して `npm run test:live -- pass revise` を実行すると、インストール済みの2つを読み込み、合格・差し戻し・Ctrl+O を確認する。
この指定では常用環境のパスを使わない。
認証・導入案内に必要なアカウント情報だけを隔離設定へ複製し、認証ストレージは既存のものを参照する。
