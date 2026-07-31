import type { ReactNode } from "react";

type InputProps = {
  forceState?: "hover" | "focus";
};

type TextFieldProps = InputProps & {
  label: ReactNode;
  required?: boolean;
};

function Input(_props: InputProps) {
  return null;
}

function TextField(_props: TextFieldProps) {
  return null;
}

export { Input, TextField };
