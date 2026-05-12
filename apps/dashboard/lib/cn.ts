import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Compose Tailwind class lists with conditional values + conflict-resolution.
 * Shared by every UI primitive so callers can extend variants without
 * worrying about duplicated `px-*`/`text-*` etc.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
