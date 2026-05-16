import { forwardRef, type ButtonHTMLAttributes } from "react";

import { cn } from "../../lib/cn";

export type ButtonVariant = "default" | "outline" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  default:
    "bg-primary text-primary-fg border border-primary hover:bg-fg disabled:bg-surface-3 disabled:text-fg-subtle disabled:border-border",
  outline:
    "border border-border bg-transparent text-fg hover:bg-surface-2 hover:border-border-strong disabled:text-fg-subtle",
  ghost:
    "bg-transparent text-fg-muted hover:bg-surface-2 hover:text-fg disabled:text-fg-subtle border border-transparent",
  danger:
    "bg-danger text-fg-inverted border border-danger hover:opacity-90 disabled:bg-danger/40 disabled:text-fg-inverted disabled:border-danger/40",
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-xs",
  md: "h-9 px-4 text-sm",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    { className, variant = "default", size = "md", type = "button", ...rest },
    ref,
  ) {
    return (
      <button
        ref={ref}
        type={type}
        className={cn(
          "inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors duration-150 ease-swiss-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg disabled:cursor-not-allowed disabled:opacity-80",
          VARIANT_CLASSES[variant],
          SIZE_CLASSES[size],
          className,
        )}
        {...rest}
      />
    );
  },
);
