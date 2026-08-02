export const BUTTON_TESTIDS: Record<string, Record<string, string>> = {
  size: {
    sm: "button-size-sm",
    md: "button-size-md",
  },
  variant: {
    filled: "button-variant-filled",
    outline: "button-variant-outline",
  },
  color: {
    green: "button-color-green",
    blue: "button-color-blue",
  },
} as const;
