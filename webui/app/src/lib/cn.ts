/**
 * Join class names, skipping falsy values.
 * Deliberately dependency-free — this codebase has exactly one need.
 */
export function cn(
  ...parts: Array<string | false | null | undefined>
): string {
  return parts.filter(Boolean).join(" ");
}
