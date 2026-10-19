/**
 * The M2 class-string bans, defined ONCE.
 *
 * Both halves of the gate read this list:
 *
 *   - `no-restricted-syntax` (core) selects a single string node — a plain
 *     string literal, or one quasi of a template literal — and matches the
 *     pattern against it. That catches every class string written as a whole
 *     literal, and every template literal whose banned token sits inside ONE
 *     quasi.
 *   - `no-restricted-class-strings` (this file's rule) catches the case core
 *     cannot see: a template literal whose banned token is SPLIT across an
 *     interpolation, so no single quasi contains it. `text-[${n}px]` has the
 *     type size in two pieces — "text-[" and "px]" — and neither piece
 *     matches on its own.
 *
 * Keeping the patterns in one module is the point: a rule that can see a
 * whole class string and a rule that can see a piece of one must agree on
 * what is banned, or the gate reports the same class string twice, or misses
 * it.
 */

/** Probes substituted for an interpolation when rendering a template. */
export const PROBES = ["11", "11px", "150"];

export const CLASS_STRING_PATTERNS = [
  {
    id: "text-size",
    source: String.raw`text-\[[0-9.]+px\]`,
    message: "Arbitrary type size: use a --text-* rung (#27) instead of text-[Npx].",
  },
  {
    id: "duration",
    source: String.raw`duration-(\[[^\]]+\]|[0-9]+)`,
    message: "Off-ladder duration: use a --dur-* / --motion-* token instead of duration-*.",
  },
  {
    id: "dimension",
    source: String.raw`(?<!text-)\[[0-9.]+(px|rem|em|ch|vh|vw|dvh|svh|lvh|%)\]`,
    message: "Bracketed dimension: declare it on the type/space scale (#27) instead.",
  },
  {
    id: "outline",
    source: String.raw`outline-none`,
    message: "outline-none cancels the one focus ring (#12). Paint the ring instead.",
  },
];

/** The same list, as live RegExps (no /g, so `test` is stateless). */
export const CLASS_STRING_REGEXPS = CLASS_STRING_PATTERNS.map((p) => ({
  ...p,
  re: new RegExp(p.source),
}));

/** The esquery selector core `no-restricted-syntax` needs for one pattern. */
export const literalSelector = (pattern) => `Literal[value=/${pattern.source}/]`;
export const templateSelector = (pattern) => `TemplateElement[value.raw=/${pattern.source}/]`;

/**
 * The class-name joiners this codebase uses. `cn` is the only one in the app
 * today; the others are the usual suspects.
 *
 * A joiner needs no rule of its own: it joins with a SPACE, and no Tailwind
 * class contains a space, so a banned token can never span two of its
 * arguments. Its arguments are ordinary string nodes, and both halves of the
 * gate already visit them wherever they sit — core's `Literal` selector sees
 * a plain string argument, and the `TemplateLiteral` visitor below sees an
 * interpolated one. `cn(`text-[${n}px]`)` is therefore reported.
 */
export const CLASS_JOINERS = new Set(["cn", "clsx", "classNames", "cx", "twMerge"]);

const rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Bans M2 class strings that a template literal's interpolation " +
        "splits in two, which no single-node selector can see.",
    },
    schema: [],
    messages: Object.fromEntries(
      CLASS_STRING_PATTERNS.map((p) => [p.id, p.message]),
    ),
  },
  create(context) {
    function matches(text) {
      return CLASS_STRING_REGEXPS.filter((p) => p.re.test(text));
    }

    /** Render a template's quasis and expressions into one string. */
    function render(node, probe) {
      let text = "";
      for (let i = 0; i < node.quasis.length; i++) {
        text += node.quasis[i].value.raw;
        if (i < node.expressions.length) text += probe;
      }
      return text;
    }

    return {
      TemplateLiteral(node) {
        // A template with no interpolation is one string; core's
        // TemplateElement selector already sees it. Skip so the same class
        // string is not reported twice.
        if (node.expressions.length === 0) return;

        // If one quasi already contains a whole banned token, core has
        // reported it on that quasi. Skip so the same class string is not
        // reported twice.
        for (const quasi of node.quasis) {
          if (matches(quasi.value.raw).length > 0) return;
        }

        // Render the template with each interpolation replaced by a probe,
        // and see whether the result is a banned class string. The probes
        // stand for the values an interpolation could carry at the positions
        // the patterns care about: a bare number ("duration-150"), a number
        // with its unit ("text-[11px]") and a bracketed value.
        for (const probe of PROBES) {
          const hit = matches(render(node, probe))[0];
          if (hit) {
            context.report({ node, messageId: hit.id });
            return;
          }
        }
      },
    };
  },
};

const plugin = {
  rules: {
    "no-restricted-class-strings": rule,
  },
};

export default plugin;
