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
    <div className="w-full overflow-x-auto rounded-lg border border-slate-200">
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
    <thead className={cn("bg-slate-50 text-slate-600", className)} {...rest} />
  );
}

export function TableBody({
  className,
  ...rest
}: HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <tbody
      className={cn(
        "divide-y divide-slate-100 [&_tr:last-child]:border-b-0",
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
        "border-b border-slate-100 transition-colors hover:bg-slate-50",
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
        "px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500",
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
      className={cn("px-3 py-2 align-middle text-sm text-slate-700", className)}
      {...rest}
    />
  );
}
