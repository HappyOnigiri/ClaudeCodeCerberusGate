import type { Register } from "claude-code";

// A plugin's own prompt skips its render hooks, so the display lives separately.
// The host keeps the sender heading outside UserMessage; Ctrl+O restores its body.
const control = /(?:^|\n)Cerberus Gate: 検証処理を継続します。 \[\d+-\d+\](?:\n|$)/u;

export const register: Register = (on) => {
  on("ui.render", { component: "UserMessage" }, (_$, e, next) => {
    if (
      e.component === "UserMessage" &&
      e.surface === "terminal" &&
      !e.props.isExpanded &&
      e.props.origin.kind === "plugin" &&
      e.props.origin.name === "cerberus-gate" &&
      control.test(e.props.text)
    )
      return { type: "Box", props: {}, children: [] };
    return next(e);
  });
};
