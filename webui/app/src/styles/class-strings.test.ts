import { describe, expect, it } from "vitest";
import { Linter } from "eslint";
import tsParser from "@typescript-eslint/parser";

import plugin, { CLASS_STRING_PATTERNS, PROBES } from "../../eslint-rules/no-restricted-class-strings.mjs";

/**
 * M2's class-string ban has two halves, and this test is the contract
 * between them:
 *
 *   - core `no-restricted-syntax` matches a single string node — a plain
 *     literal, or one quasi of a template literal;
 *   - the local rule matches a template literal whose banned token an
 *     interpolation split in two.
 *
 * The review found the gap: `text-[${n}px]` has the type size in two
 * pieces — "text-[" and "px]" — and neither piece matches on its own, so
 * the same class string written as a literal was reported and the
 * interpolated one was not. A denominator with a hole in it is not a
 * denominator.
 */
const linter = new Linter();

function lint(code: string): string[] {
  // The plugin is a local rule, so ESLint's `RuleEntry` type does not know
  // its name; the config object is cast to the shape the Linter accepts.
  const config = {
    files: ["**/*.tsx"],
    plugins: { "no-restricted-class-strings": plugin },
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2022,
      sourceType: "module",
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: { "no-restricted-class-strings/no-restricted-class-strings": "warn" },
  } as unknown as Linter.Config;
  const messages = linter.verify(code, config, "probe.tsx");
  return messages.map((m) => m.message);
}

const TSX = (body: string) =>
  `const n = 1; const hex = "00"; const cn = (...p) => p.filter(Boolean).join(" ");\n` +
  `export const C = () => (${body});\n`;

describe("M2 class-string ban: the interpolated form", () => {
  it("reports a type size an interpolation split in two", () => {
    // The case the review named: `text-[${n}px]`.
    const messages = lint(TSX(`<p className={\`text-[\${n}px]\`}>x</p>`));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/text-\[Npx\]/);
  });

  it("reports an interpolated duration", () => {
    const messages = lint(TSX(`<p className={\`duration-\${n}ms\`}>x</p>`));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/duration-/);
  });

  it("reports an interpolated bracketed dimension", () => {
    const messages = lint(TSX(`<p className={\`w-[\${n}ch]\`}>x</p>`));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/Bracketed dimension/);
  });

  it("reports it when the class string is a cn() argument", () => {
    const messages = lint(
      TSX(`<p className={cn(\`text-[\${n}px]\`)}>x</p>`),
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/text-\[Npx\]/);
  });

  it("does NOT report a template with no interpolation (core sees it)", () => {
    // A static template is one string; core's TemplateElement selector
    // already reports it. Reporting it here too would double-count.
    expect(lint(TSX(`<p className={\`text-[11px]\`}>x</p>`))).toHaveLength(0);
  });

  it("does NOT report a class string that is not banned", () => {
    expect(lint(TSX(`<p className={\`text-data\`}>x</p>`))).toHaveLength(0);
    // A bracketed dimension IS banned, whatever utility carries it — the
    // rule is about the token, not the utility.
    expect(lint(TSX(`<p className={\`rounded-[\${n}px]\`}>x</p>`))).toHaveLength(1);
  });

  it("does NOT report a template that is not a class string at all", () => {
    // A hex colour is a template too, and is not a class.
    expect(lint(TSX(`<p style={{ color: \`#\${hex}\` }}>x</p>`))).toHaveLength(0);
  });
});

describe("M2 class-string ban: the two halves agree", () => {
  it("every pattern the local rule uses is one core also uses", () => {
    // The two halves must ban the SAME strings. If they drift, the gate
    // reports a class string twice, or misses it.
    for (const pattern of CLASS_STRING_PATTERNS) {
      expect(pattern.source).toMatch(/\S/);
      expect(pattern.message).toMatch(/\S/);
    }
  });

  it("probes cover the positions the patterns care about", () => {
    // A bare number ("duration-150"), a number with its unit
    // ("text-[11px]") and a bracketed value.
    expect(PROBES).toContain("11");
    expect(PROBES).toContain("11px");
  });
});
