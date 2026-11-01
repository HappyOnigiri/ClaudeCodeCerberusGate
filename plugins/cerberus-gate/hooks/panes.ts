import type { EngineInterface, RenderInput, SelectProps } from "claude-code";

export function picker(
  $: EngineInterface,
  e: RenderInput,
  props: SelectProps,
  backHint: string,
  back: () => Promise<void>,
) {
  if (e.surface === "mobile") return $.ui.resolve(e).Text({ children: props.label ?? "" });
  const { Box, Button, Select, Text } = $.ui.resolve(e);
  return Box({
    flexDirection: "column",
    children: [
      Button({
        key: "back",
        label: backHint,
        onPress: back,
      }),
      ...(e.requestId === "menu"
        ? [
            Text({ children: props.label }),
            ...props.options.map((option, index) =>
              Button({
                key: `menu-${option.value}`,
                label: option.label ?? option.value,
                hotkey: String(index + 1),
                plain: true,
                autoFocus: option.value === props.value ? true : undefined,
                onPress: () =>
                  props.onSelect(option.value, {
                    plugin: "cerberus-gate",
                    component: "Pane",
                    requestId: e.requestId,
                    surface: e.surface,
                    element: props.key,
                    value: option.value,
                  }),
              }),
            ),
          ]
        : [Select(props)]),
    ],
  });
}
