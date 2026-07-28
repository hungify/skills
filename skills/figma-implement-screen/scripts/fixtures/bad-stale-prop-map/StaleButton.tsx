// Pressure fixture: extracted code API must reject stale prop-map evidence.
export interface StaleButtonProps {
  size?: "sm" | "md";
}

export function StaleButton({ size = "md" }: StaleButtonProps) {
  return <button data-size={size}>Stale</button>;
}
