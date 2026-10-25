// Claude Code 2.1.310 の実セッションで観測した、型生成対象外のエンジン内返却ツール。
// 外部サービスへの送信には使わず、審査結果を受け取って定型文に置き換える。
declare module "claude-code" {
  interface BuiltinToolInputs {
    SubagentHandback: { message: string };
  }
}
