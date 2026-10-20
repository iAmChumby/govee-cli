import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

import classStrings, {
  CLASS_STRING_PATTERNS,
  literalSelector,
  templateSelector,
} from "./eslint-rules/no-restricted-class-strings.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

/**
 * M2 — the migration's gate, now at ERROR.
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
 * THE FLIP (wave 6). These were warnings from wave 5. The consensus's flip
 * criterion is concrete: error once `npm run lint` reports 0 warnings for
 * both rules on the full src tree. It does:
 *
 *   react/forbid-elements    62 -> 0   (34 <button>, 24 <input>, 4 <select>)
 *   no-restricted-syntax     91 -> 0   (wave 6a)
 *   no-restricted-class-strings 0 -> 0
 *
 * The 62 control primitives went onto the presentational parts in
 * components/ui/ (Pressable, Input, Select) — the same element, the same
 * attributes, the same classes, the same handlers. The class-string rule
 * grew a branch in wave 6b that sees a bracketed var() reference, so the
 * denominator is honest about the shape the tree used to hide behind.
 *
 * The class-string bans are defined once, in
 * `eslint-rules/no-restricted-class-strings.mjs`, and read by BOTH halves of
 * the gate:
 *
 *   - core `no-restricted-syntax` matches a single string node — a plain
 *     string literal, or one quasi of a template literal. It sees every
 *     class string written as a whole literal.
 *   - the local `no-restricted-class-strings` rule sees the case core
 *     cannot: a template literal whose banned token is SPLIT by an
 *     interpolation, so no single quasi holds it. `text-[${n}px]` has the
 *     type size in two pieces — "text-[" and "px]" — and neither piece
 *     matches alone. Without this rule the gate would let a class string
 *     built at runtime through while the same string written literally is
 *     reported, which is exactly the gap a denominator must not have.
 */
const primitive = (element, replacement) => ({
  element,
  message: `use ${replacement} (M2 — no raw <${element}> outside components/ui/).`,
});

// Every pattern, as a core no-restricted-syntax entry: the plain literal
// and the template quasi.
const bannedClassString = (pattern) => [
  { selector: literalSelector(pattern), message: pattern.message },
  { selector: templateSelector(pattern), message: pattern.message },
];

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
    plugins: {
      "no-restricted-class-strings": classStrings,
    },
    rules: {
      "react/forbid-elements": [
        "error",
        {
          forbid: [
            primitive("button", "Button or IconButton from components/ui/"),
            primitive(
              "input",
              "a components/ui/ field; use the Input part from components/ui/",
            ),
            primitive(
              "select",
              "a components/ui/ Select; use the Select part from components/ui/",
            ),
            primitive(
              "textarea",
              "a components/ui/ Textarea; none exists yet, so this is its promotion entry",
            ),
            primitive("a", "Link, or BackUp from components/ui/ for navigation"),
          ],
        },
      ],
      "no-restricted-syntax": [
        "error",
        ...CLASS_STRING_PATTERNS.flatMap((pattern) => bannedClassString(pattern)),
      ],
      // The half of the class-string ban core cannot see: a template
      // literal whose banned token an interpolation split in two.
      "no-restricted-class-strings/no-restricted-class-strings": "error",
    },
  },
];

export default eslintConfig;
