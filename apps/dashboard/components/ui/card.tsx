import { forwardRef, type HTMLAttributes } from "react";

import { cn } from "../../lib/cn";

export const Card = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function Card({ className, ...rest }, ref) {
    return (
      <div
        ref={ref}
        className={cn(
          "rounded-lg border border-border bg-surface text-fg shadow-1 transition-colors",
          className,
        )}
        {...rest}
      />
    );
  },
);

export const CardHeader = forwardRef<
  HTMLDivElement,
  HTMLAttributes<HTMLDivElement>
>(function CardHeader({ className, ...rest }, ref) {
  return (
    <div
      ref={ref}
      className={cn(
        "flex flex-col gap-1 border-b border-border/60 px-5 pb-3 pt-4",
        className,
      )}
      {...rest}
    />
  );
});

export const CardTitle = forwardRef<
  HTMLHeadingElement,
  HTMLAttributes<HTMLHeadingElement>
>(function CardTitle({ className, ...rest }, ref) {
  return (
    <h3
      ref={ref}
      className={cn(
        "text-[11px] font-semibold uppercase leading-none tracking-[0.16em] text-fg-subtle",
        className,
      )}
      {...rest}
    />
  );
});

export const CardContent = forwardRef<
  HTMLDivElement,
  HTMLAttributes<HTMLDivElement>
>(function CardContent({ className, ...rest }, ref) {
  return (
    <div ref={ref} className={cn("px-5 pb-5 pt-4", className)} {...rest} />
  );
});
