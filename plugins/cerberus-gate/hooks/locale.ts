export type Language = "en" | "ja";

const messages = {
  languageLabel: ["Language", "言語"],
  languageSaved: ["Language saved: {0}", "言語を保存しました: {0}"],
  languageDenied: ["Could not save language: {0}", "言語を保存できませんでした: {0}"],
  languageFailure: ["Could not save language.", "言語を保存できませんでした。"],
  mobileLanguage: ["Change Language in /config.", "言語は /config で変更してください。"],
  backHint: ["Back", "戻る"],
  menuPane: ["Cerberus Gate menu", "Cerberus Gate メニュー"],
  menuStatus: ["Review status", "検証の状態"],
  menuLog: ["Debug log location and storage status", "デバッグログの保存場所・保存状態"],
  menuOn: ["Enable answer review…", "回答検証を有効にする…"],
  menuOff: ["Disable answer review…", "回答検証を無効にする…"],
  menuReset: ["Use saved enabled setting", "有効・無効を保存済み設定に戻す"],
  menuCancel: ["Cancel pending review", "保留中の検証を取り消す"],
  debugSaveFailure: [
    "Debug log could not be saved. Check storage status with /cgate log.",
    "デバッグログの保存に失敗しました。/cgate log で保存状態を確認してください。",
  ],
  debugSaveToast: [
    "Cerberus Gate: Debug log could not be saved.",
    "Cerberus Gate: デバッグログの保存に失敗しました。",
  ],
  enabledSaveFailure: [
    "Cerberus Gate: Could not save the enabled setting.",
    "Cerberus Gate: 有効・無効の設定を保存できませんでした。",
  ],
  pendingCancelled: [
    " The pending answer was cancelled. Submit a new request.",
    " 保留中の回答を取り消しました。新しい依頼を送信してください。",
  ],
  resumeFailure: [
    "Could not resume after reload. Submit a new request to continue.",
    "再ロード後の再開に失敗しました。続行するには新しい依頼を送信してください。",
  ],
  deliveryFailure: [
    "Could not display the answer because the correction request could not be sent.",
    "修正依頼の送信に失敗したため、本文を表示できませんでした。",
  ],
  deliveryToast: [
    "Cerberus Gate: Could not display the answer because the correction request could not be sent.",
    "Cerberus Gate: 修正依頼の送信に失敗したため、本文を表示できませんでした。",
  ],
  reviewResult: ["Review #{0}: {1}", "審査 #{0}: {1}"],
  correctionRequested: ["Requested correction #{0}.", "修正を依頼しました（{0} 回目）。"],
  published: ["Published the verified answer.", "検証済みの本文を公開しました。"],
  unverifiedPublished: [
    "Displayed the unverified answer with a notice.",
    "未検証の本文を注記付きで表示しました。",
  ],
  reviewStarted: ["Review #{0}: started", "審査 #{0}: 開始"],
  reviewTimeout: ["Review #{0}: timed out", "審査 #{0}: タイムアウト"],
  releaseFailure: ["Could not delete review materials.", "検証資料の削除に失敗しました。"],
  interimPublished: [
    "Displayed an interim report without review while background work is running.",
    "バックグラウンド作業の実行中の途中報告のため、検証せずに表示しました。",
  ],
  answerPending: [
    "This answer is hidden while a correction request is pending.",
    "修正依頼の配信待ちのため、この回答は表示しません。",
  ],
  outsideLimits: [
    "Displayed an unverified answer because its stop condition or size is outside review limits.",
    "回答の終了条件またはサイズが審査の対象外のため、未検証の本文を表示しました。",
  ],
  limitPublished: [
    "Displayed the answer without review because the correction limit was reached.",
    "修正回数の上限に達したため、審査せずに本文を表示しました。",
  ],
  answerError: [
    "Displayed the unverified answer after an answer processing error.",
    "回答処理でエラーが発生したため、未検証の本文を表示しました。",
  ],
  emptyError: [
    "An answer processing error occurred. No answer is available.",
    "回答処理でエラーが発生しました。表示できる本文はありません。",
  ],
  staleContinuation: [
    "Cerberus: Discarded a stale review continuation.",
    "Cerberus: 古い検証処理を破棄しました。",
  ],
  handledResult: ["Cerberus: Review result already handled.", "Cerberus: 検証結果を処理済みです。"],
  newRequest: [
    "Cancelled the pending review because a new request arrived.",
    "新しい依頼により、保留中の検証処理を取り消しました。",
  ],
  started: ["Cerberus Gate started.", "Cerberus Gate を起動しました。"],
  unsupported: [
    "Unsupported configuration or Claude Code version.",
    "設定または Claude Code のバージョンが対象外です。",
  ],
  noninteractive: ["Non-interactive sessions are outside scope.", "非対話セッションは対象外です。"],
  restored: [
    "Restored the request and correction count from before reload.",
    "再ロード前の依頼と修正回数を復元しました。",
  ],
  commandDescription: [
    "Show answer review status, history and debug logs",
    "回答検証の状態・履歴・デバッグログを表示",
  ],
  shortCommandDescription: [
    "Open Cerberus Gate menu and settings",
    "Cerberus Gate のメニュー・設定を開く",
  ],
  restarting: [
    "Requesting a fresh answer and review after reload interrupted the previous one.",
    "再ロードで中断した回答の再生成・再審査を依頼します。",
  ],
  enabledScope: ["Enabled setting scope", "有効・無効の適用範囲"],
  modelPane: ["Reviewer model and effort", "検査用モデル・effort"],
  historyPane: ["Cerberus Gate history", "Cerberus Gate の履歴"],
  usage: [
    "Usage: /cgate [on|off|reset|model|language|history|log|cancel]",
    "使い方: /cgate [on|off|reset|model|language|history|log|cancel]",
  ],
  cancelled: ["Cancelled the review by command.", "コマンドで検証処理を取り消しました。"],
  mobileScope: [
    "Run /cgate on or /cgate off in the terminal to select the scope.",
    "ターミナルで /cgate on または /cgate off を実行して適用範囲を選んでください。",
  ],
  scopeLabel: ["Scope for turning answer review {0}", "回答検証を{0}にする範囲"],
  enabledWord: ["on", "有効"],
  disabledWord: ["off", "無効"],
  sessionScope: ["This session only", "このセッションだけ"],
  savedScope: ["Save setting (also applies to future sessions)", "設定に保存（次回以降も適用）"],
  mobileModel: [
    "Change the reviewer model and effort in /config.",
    "検査用モデル・effort は /config で変更してください。",
  ],
  modelLabel: ["Reviewer model", "検査用モデル"],
  modelDenied: [
    "Cerberus Gate: Could not save the model. {0}",
    "Cerberus Gate: モデルを保存できませんでした。{0}",
  ],
  modelSaved: [
    "Cerberus Gate: Reviewer model set to {0}.",
    "Cerberus Gate: 検査用モデルを {0} に設定しました。",
  ],
  effortPane: ["Reviewer effort", "検査用 effort"],
  modelFailure: [
    "Cerberus Gate: Could not save the model.",
    "Cerberus Gate: モデルを保存できませんでした。",
  ],
  mobileEffort: [
    "Change reviewer effort in /config.",
    "検査用 effort は /config で変更してください。",
  ],
  effortLabel: ["Reviewer effort (model: {0})", "検査用 effort（モデル: {0}）"],
  effortDenied: [
    "Cerberus Gate: Could not save effort. {0}",
    "Cerberus Gate: effort を保存できませんでした。{0}",
  ],
  effortSaved: [
    "Cerberus Gate: Reviewer effort set to {0}.",
    "Cerberus Gate: 検査用 effort を {0} に設定しました。",
  ],
  effortFailure: [
    "Cerberus Gate: Could not save effort.",
    "Cerberus Gate: effort を保存できませんでした。",
  ],
  interrupted: ["Answer processing was interrupted.", "回答処理が中断されました。"],
  waiting: ["Verifying the answer.", "回答を検証中です。"],
  passed: [
    "Cerberus Gate: [PASS] Answer review passed. Displaying the answer.",
    "Cerberus Gate: [PASS] 回答の検証に合格したため、本文を表示します。",
  ],
  revising: [
    "Cerberus Gate: [REVISE] Review found issues. Requested correction #{0}.",
    "Cerberus Gate: [REVISE] 検証で指摘があったため、修正を依頼しました（{0} 回目）。",
  ],
  unverified: [
    "Cerberus Gate: [UNVERIFIED] Review could not be completed. Displaying the unverified answer unchanged.",
    "Cerberus Gate: [UNVERIFIED] 回答の検証を完了できなかったため、未検証の本文をそのまま表示します。",
  ],
  skipped: [
    "Cerberus Gate: [SKIP] Displaying this {2}-character interim report without review while background work is running ({0} agents, {1} shells).",
    "Cerberus Gate: [SKIP] バックグラウンド作業の実行中（エージェント {0} 件・シェル {1} 件）に届いた {2} 文字の途中報告のため、検証せずに表示します。",
  ],
  revisionLimit: [
    "Cerberus Gate: [SKIP] Correction limit reached. Displaying the answer unchanged without review.",
    "Cerberus Gate: [SKIP] 修正回数の上限に達したため、審査せずに本文をそのまま表示します。",
  ],
  failed: [
    "Cerberus Gate: [ERROR] Answer processing failed. Displaying the unverified answer unchanged.",
    "Cerberus Gate: [ERROR] 回答処理でエラーが発生したため、未検証の本文をそのまま表示します。",
  ],
  noDraft: [
    "Cerberus Gate: [ERROR] Answer processing failed. No answer is available.",
    "Cerberus Gate: [ERROR] 回答処理でエラーが発生し、表示できる本文がありませんでした。",
  ],
  control: [
    "Cerberus Gate: Continuing answer verification.",
    "Cerberus Gate: 検証処理を継続します。",
  ],
  findings: ["Findings and evidence:\n{0}", "指摘と根拠:\n{0}"],
  unknownTime: ["Unknown time", "時刻不明"],
  noLogs: [
    "Cerberus Gate: No logs for this session.",
    "Cerberus Gate: このセッションのログはありません。",
  ],
  logHeader: [
    "Cerberus Gate: Session logs (UTC){0}",
    "Cerberus Gate: このセッションのログ（時刻は UTC）{0}",
  ],
  omitted: [" / omitted {0} older entries", " / 古い {0} 件を省略"],
  debugHeader: ["Cerberus Gate: Debug logs", "Cerberus Gate: デバッグログ"],
  uninitialized: ["Not initialized", "未初期化"],
  storageStatus: ["Storage status: {0}", "保存状態: {0}"],
  saveFailed: ["Save failed", "保存失敗"],
  saved: ["Saved", "保存済み"],
  notSaved: ["Not saved", "未保存"],
  directory: ["Storage directory: {0}", "保存ディレクトリ: {0}"],
  index: ["Index: {0}", "索引: {0}"],
  currentLog: ["Current log: {0}", "現在のログ: {0}"],

  status: [
    "Cerberus Gate: {0} ({1}); {2}; corrections={3}",
    "Cerberus Gate: {0}（{1}）; {2}; 修正回数={3}",
  ],
  savedSource: ["saved", "保存設定"],
  sessionSource: ["session", "セッション設定"],
  phaseIdle: ["idle", "待機中"],
  phaseReviewing: ["reviewing", "審査中"],
  phaseCorrection: ["correction queued", "修正依頼待ち"],
  phasePublished: ["published", "公開済み"],
  phaseUnverified: ["unverified", "未検証"],
  phaseCancelled: ["cancelled", "中断済み"],
  reviewerCompleted: [
    "Cerberus Gate reviewer: completed.",
    "Cerberus Gate レビュアー: 完了しました。",
  ],
  staleReviewer: ["Cerberus: stale reviewer stopped.", "Cerberus: 古いレビュアーを停止しました。"],
  noActiveReviewer: [
    "Cerberus reviewer: no active review.",
    "Cerberus レビュアー: 実行中の審査がありません。",
  ],
  noActiveReview: ["Cerberus: no active review.", "Cerberus: 実行中の審査がありません。"],
  inlineReviews: ["Cerberus: reviews run inline.", "Cerberus: 審査は同じターン内で実行します。"],
  guardFailed: [
    "Cerberus: reviewer tool guard failed.",
    "Cerberus: レビュアーのツール検査に失敗しました。",
  ],
  permissionFailed: ["Cerberus: permission guard failed.", "Cerberus: 権限検査に失敗しました。"],
} as const;

export function translate(
  language: Language,
  key: keyof typeof messages,
  ...values: readonly (string | number)[]
): string {
  return messages[key][language === "ja" ? 1 : 0].replace(/\{(\d+)\}/gu, (_match, index: string) =>
    String(values[Number(index)] ?? ""),
  );
}
