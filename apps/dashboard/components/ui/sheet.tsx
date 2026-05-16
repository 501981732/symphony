"use client";

import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { cn } from "../../lib/cn";

const SHEET_ANIMATION_MS = 200;

interface SheetProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  /** Accessible label for the sheet region; required for assistive tech. */
  label: string;
  /** Aria label for the close button (defaults to "Close"). */
  closeLabel?: string;
  /** Sheet width (Tailwind class). Defaults to a comfortable run inspector size. */
  widthClassName?: string;
  /** Optional className for the outer panel. */
  className?: string;
}

/**
 * Right-side, non-modal inspector sheet.
 *
 * The Command Center board view uses this to surface the Review Packet
 * for the currently-selected run while keeping the kanban itself fully
 * interactive — operators can click another card to swap content
 * without first dismissing the sheet, which is critical for triage
 * sessions where you scan many runs in a row.
 *
 * Design choices:
 *   - **No scrim, no body-scroll lock**: the sheet floats over a thin
 *     left border, the kanban remains visible and clickable. Closing
 *     happens via Esc, the ✕ button, or selecting nothing.
 *   - `role="complementary"` instead of `role="dialog"`: this is
 *     supplementary content, not a modal — screen readers shouldn't
 *     trap focus inside it.
 *   - `aria-hidden` toggles when closed so off-screen content isn't
 *     announced; we still keep the panel mounted for the slide-out
 *     duration so the close transition can play.
 *   - `prefers-reduced-motion` is honoured globally via globals.css.
 */
export function Sheet({
  open,
  onClose,
  children,
  label,
  closeLabel = "Close",
  widthClassName = "w-full sm:w-[420px]",
  className,
}: SheetProps) {
  // `mounted` keeps the panel in the DOM for the slide-out animation
  // even after `open` flips to false. After the transition we unmount
  // so testing-library / screen readers don't observe stale content.
  const [mounted, setMounted] = useState(open);

  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    if (!mounted) return;
    const timeout = setTimeout(() => setMounted(false), SHEET_ANIMATION_MS);
    return () => clearTimeout(timeout);
  }, [open, mounted]);

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (typeof document === "undefined") return null;
  if (!mounted) return null;

  return createPortal(
    <aside
      role="complementary"
      aria-label={label}
      aria-hidden={!open}
      className={cn(
        // `pointer-events-none` on the wrapper lets clicks fall through
        // to the kanban when the sheet is open elsewhere; the inner
        // panel re-enables `pointer-events-auto` for itself.
        "fixed bottom-0 right-0 top-14 z-40 flex pointer-events-none lg:top-16",
        widthClassName,
        className,
      )}
    >
      <div
        className={cn(
          "pointer-events-auto flex h-full w-full flex-col border-l border-border bg-surface shadow-2 outline-none transition-transform duration-200 ease-swiss-out",
          open ? "translate-x-0" : "translate-x-full",
        )}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label={closeLabel}
          className="absolute right-3 top-3 inline-flex h-8 w-8 items-center justify-center rounded-md text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <svg
            viewBox="0 0 24 24"
            width={16}
            height={16}
            aria-hidden="true"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.8}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m6 6 12 12M6 18 18 6" />
          </svg>
        </button>
        <div className="flex h-full flex-col overflow-y-auto">{children}</div>
      </div>
    </aside>,
    document.body,
  );
}
