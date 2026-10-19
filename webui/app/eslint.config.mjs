import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

/**
 * M2 — the migration's denominator, warn-only (wave 5).
 *
 * Two rules, both scoped to product code outside `components/ui/`:
 *   - react/forbid-elements: a raw control primitive is a component that was
 *     never promoted. The ui/ folder is the destination, so it is exempt.
 *   - no-restricted-syntax: the class-string literals #27, #16 and M1 exist to
 *     replace (arbitrary type sizes, off-ladder durations, bracketed
 *     dimensions) plus the two spellings that cancel the one focus ring.
 *
 * Test files are exempt: they assert *about* these tokens (focus-ring.test.ts
 * contains the banned strings on purpose, and a snapshot test carries emitted
 * markup). Warning on the assertion would make the denominator un-flippable.
 * A test is not a control a user clicks.
 *
 * Flip criterion (wave 6): make both entries "error" once `npm run lint`
 * reports 0 warnings for both rules on the full src tree.
 */
const primitive = (element, replacement) => ({
  element,
  message: `use ${replacement} (M2 — no raw <${element}> outside components/ui/).`,
});

const selector = (pattern, message) => ({
  selector: `Literal[value=/${pattern}/]`,
  message,
});
const templateSelector = (pattern, message) => ({
  selector: `TemplateElement[value.raw=/${pattern}/]`,
  message,
});

const bannedClassString = (pattern, message) => [
  selector(pattern, message),
  templateSelector(pattern, message),
];

const TEXT_PX = String.raw`text-\[[0-9.]+px\]`;
const DURATION = String.raw`duration-(\[[^\]]+\]|[0-9]+)`;
// A bracketed length/percent. `text-[11px]` is reported by the text rule
// instead, so the two do not double-count the same token.
const DIMENSION = String.raw`(?<!text-)\[[0-9.]+(px|rem|em|ch|vh|vw|dvh|svh|lvh|%)\]`;
const OUTLINE_NONE = String.raw`outline-none`;

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    // Every Next build output, whatever it is called. `.next-verify` is
    // scripts/verify_ui.py's throwaway build, kept out of `.next` so it cannot
    // clobber the deployed one — but GOVEE_WEBUI_DIST_DIR takes any name, and
    // naming one anything else made `npm run lint` report hundreds of errors in
    // generated bundles. Matching the whole family means the next person to
    // build into a scratch dir does not have to discover that.
    ignores: ["node_modules/**", ".next*/**", "out/**", "next-env.d.ts", "public/sw.js"],
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/components/ui/**", "src/**/*.test.ts", "src/**/*.test.tsx"],
    rules: {
      "react/forbid-elements": [
        "warn",
        {
          forbid: [
            primitive("button", "Button or IconButton from components/ui/"),
            primitive(
              "input",
              "a components/ui/ field; no Input component exists yet, so this warning is its promotion entry",
            ),
            primitive(
              "select",
              "a components/ui/ Select; none exists yet, so this warning is its promotion entry",
            ),
            primitive(
              "textarea",
              "a components/ui/ Textarea; none exists yet, so this warning is its promotion entry",
            ),
            primitive("a", "Link, or BackUp from components/ui/ for navigation"),
          ],
        },
      ],
      "no-restricted-syntax": [
        "warn",
        ...bannedClassString(
          TEXT_PX,
          "Arbitrary type size: use a --text-* rung (#27) instead of text-[Npx].",
        ),
        ...bannedClassString(
          DURATION,
          "Off-ladder duration: use a --dur-* / --motion-* token instead of duration-*.",
        ),
        ...bannedClassString(
          DIMENSION,
          "Bracketed dimension: declare it on the type/space scale (#27) instead.",
        ),
        ...bannedClassString(
          OUTLINE_NONE,
          "outline-none cancels the one focus ring (#12). Paint the ring instead.",
        ),
      ],
    },
  },
];

export default eslintConfig;
