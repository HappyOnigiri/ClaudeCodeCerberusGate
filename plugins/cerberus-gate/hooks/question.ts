// Serialize all inputs, including option previews. Publication replays the original stream.
export function questionDraft(
  explanation: string,
  tools: readonly { name: string; input: unknown }[],
): string | undefined {
  if (!tools.some((tool) => tool.name === "AskUserQuestion")) return undefined;
  return JSON.stringify({ kind: "AskUserQuestion", explanation, toolUses: tools });
}

export function skipReason(
  enabled: boolean,
  tools: boolean,
  text: string,
  question: string | undefined,
): string | undefined {
  if (!enabled) return "disabled";
  if (question !== undefined) return undefined;
  if (tools) return "tool_step";
  return text.trim() ? undefined : "empty";
}

export const QUESTION_REVIEW = `When the draft kind is AskUserQuestion, review its explanation together with every question and the complete tool inputs, including option labels, descriptions and previews, BEFORE the dialog is displayed.
The explanation output simultaneously with AskUserQuestion MUST be self-contained: explain what the question concerns, its premises and the relevant decision information already known in this context. A question that is answerable only if the user remembers all earlier turns is unacceptable; use REVISE even if the missing information exists in session history.
For every option, the simultaneous explanation must describe how behavior differs when it is selected. The FIRST option must be the overall recommended choice, with a recommendation justified by the available evidence and user constraints. This rule concerns the first option in each questions[].options array, not the first sentence of the explanation. Check ordering as well as labels; do not invent a recommendation's factual basis.
Check that the user has enough accurate information to decide: the decision to make, relevant background, differences between options, consequences and material trade-offs. Identify missing information that could change the choice.
Verify factual premises and recommendations against conversation evidence and real sources. Flag errors, misleading omissions, ambiguous wording, overlapping or inconsistent choices, and descriptions or previews that contradict their labels or the explanation. State the affected question or option and a concrete correction.
Distinguish facts the agent can investigate from choices that require the user's preference; do not ask the user to resolve a fact already established by evidence. Do not invent preferences or require all factual uncertainty to be resolved before a legitimate preference question.
Use REVISE for actionable defects affecting the user's decision, not stylistic preferences. Do not answer the questions or choose for the user.\n`;

export const QUESTION_REVIEW_JA = `原稿の kind が AskUserQuestion の場合は、質問画面の表示前に、説明文と各質問、選択肢のラベル・説明・プレビューを含むツール入力全体を一緒に審査してください。
AskUserQuestion と同時に出力する説明文だけで判断できることを要求してください。何に対する質問かという前提と、このコンテキストで把握済みの判断材料を説明文に含めてください。過去ターンをすべて把握していれば回答できるという状態は不可です。不足する情報が会話履歴にあっても、今回の説明文になければ REVISE にしてください。
同時に出力する説明文で、各選択肢を選んだときの挙動の違いを説明しているか確認してください。1つ目の選択肢が総合的な推奨案であり、推奨理由が利用可能な証拠とユーザーの制約に沿っているか確認してください。この条件は各 questions[].options 配列の先頭を指し、説明文の冒頭を推奨文にする要求ではありません。ラベルだけでなく並び順も確認し、推奨理由の事実を作らないでください。
ユーザーが判断できるだけの正確な情報があるか確認してください。決める対象、必要な背景、選択肢の違い、選択による結果、重要な利点と欠点を確認し、選択を変えうる情報の不足を指摘してください。
質問の前提と推奨理由を会話内の証拠と実際の情報源で照合してください。誤り、判断を誤らせる省略、曖昧な表現、選択肢の重複や不整合、ラベル・説明文と矛盾する説明やプレビューを指摘し、対象の質問や選択肢と具体的な修正を示してください。
エージェントが調べられる事実とユーザーの意向で決まる選択を区別し、証拠で確定済みの事実をユーザーへ問い直さないでください。意向を作らず、正当な意向の質問に対して事実の不確実性をすべて解消するよう要求しないでください。
ユーザーの判断に影響する具体的な不備には REVISE を使い、文体の好みだけで修正を求めないでください。質問への回答やユーザーに代わる選択はしないでください。\n`;
