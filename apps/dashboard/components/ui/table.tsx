import {
  forwardRef,
  type HTMLAttributes,
  type TdHTMLAttributes,
  type ThHTMLAttributes,
} from "react";

import { cn } from "../../lib/cn";

export const Table = forwardRef<
  HTMLTableElement,
  HTMLAttributes<HTMLTableElement>
>(function Table({ className, ...rest }, ref) {
  return (
    <div className="w-full overflow-x-auto rounded-lg border border-border bg-surface shadow-1">
      <table
        ref={ref}
        className={cn("w-full caption-bottom text-sm", className)}
        {...rest}
      />
    </div>
  );
});

export function TableHeader({
  className,
  ...rest
}: HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <thead
      className={cn(
        "bg-surface-2 text-[11px] uppercase tracking-[0.14em] text-fg-subtle",
        className,
      )}
      {...rest}
    />
  );
}

export function TableBody({
  className,
  ...rest
}: HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <tbody
      className={cn(
        "divide-y divide-border/70 [&_tr:last-child]:border-b-0",
        className,
      )}
      {...rest}
    />
  );
}

export function TableRow({
  className,
  ...rest
}: HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr
      className={cn(
        "border-b border-border/70 transition-colors hover:bg-surface-2/60",
        className,
      )}
      {...rest}
    />
  );
}

export function TableHead({
  className,
  ...rest
}: ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      className={cn(
        "px-4 py-2.5 text-left font-semibold text-fg-subtle",
        className,
      )}
      {...rest}
    />
  );
}

export function TableCell({
  className,
  ...rest
}: TdHTMLAttributes<HTMLTableCellElement>) {
  return (
    <td
      className={cn("px-4 py-2.5 align-middle text-sm text-fg-muted", className)}
      {...rest}
    />
  );
}
