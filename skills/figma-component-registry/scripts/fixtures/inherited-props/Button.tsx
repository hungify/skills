import type { ButtonHTMLAttributes } from 'react';

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'filled' | 'outline';
  onDelete?: () => void;
  'aria-description'?: string;
};

function Button(_props: ButtonProps) {
  return null;
}

export { Button };
