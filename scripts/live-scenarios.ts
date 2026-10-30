export const customPrompt =
  "Check the release channel against fact.txt.\nBefore deciding, request Read for fact.txt and use its successful result in the evidence array. Do not substitute main-agent reads from the conversation. CUSTOM_REVIEW_CRITERIA";
export const drafts: Record<string, string> = {
  bounds: "stable. A closing hour of 26 is a valid configuration example.",
  environment: "stable. The default is false, so this feature has no effect in production.",
  causal: "stable. The provider watch waits for timeline rendering to complete.",
  choice:
    "stable. I propose CreatedAt as the origin of the 720-day retention period; this is an unresolved specification choice requiring approval.",
};
export const facts: Record<string, string> = {
  "question-pass":
    "The current release channel is stable. Stable provides production releases and is recommended for reliability. Beta receives earlier preview features with less testing and higher regression risk.",
  "question-revise":
    "The current release channel is stable. Stable provides production releases and is recommended for reliability. Beta receives earlier preview features with less testing and higher regression risk.",
  bounds: "The closing hour accepts integers from 12 through 24 inclusive.",
  environment:
    "The feature default is false. The production deployment manifest sets it to true. The running cluster has not been inspected.",
  causal:
    "The provider watches data changes. No implementation or other evidence about waiting for timeline rendering is available.",
  choice:
    "CreatedAt is set at creation and unchanged on re-entry. The retention duration is 720 days. The specification does not define the retention origin.",
};
export const requests: Record<string, string> = {
  "question-pass":
    "Ask me to choose the release channel for future updates using AskUserQuestion. Explain the current channel, each option and recommendation in the same response. Recommend stable for reliability; beta opts into previews.",
  "question-revise":
    "Ask me to choose the release channel for future updates using AskUserQuestion. Explain the current channel, each option and recommendation in the same response. Recommend stable for reliability; beta opts into previews.",
  bounds: "Assess whether a closing hour of 26 is a valid configuration example.",
  environment:
    "Assess whether the feature default establishes that it has no effect in production.",
  causal:
    "Using only fact.txt as evidence, assess whether its contents support the assertion that the provider watch waits for timeline rendering to complete. Do not search other files; if the file does not establish the behavior, state that limit.",
  choice:
    "Propose an origin for the 720-day retention period, explicitly identifying any unresolved specification choice requiring approval.",
};
export const expectedFindings: Record<string, RegExp> = {
  bounds: /26|12.*24/u,
  environment: /production|manifest/u,
  causal: /render|causal|wait/u,
};

for (const mode of ["question-context", "question-order"]) {
  facts[mode] = facts["question-pass"]!;
  requests[mode] = requests["question-pass"]!;
}
