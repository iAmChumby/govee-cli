#!/usr/bin/env node
/**
 * Generate `src/styles/tokens.css` and `src/lib/motion.ts` from
 * `src/styles/tokens.tokens.json`.
 *
 * That JSON file is the only declared source for design and motion values.
 * This script owns CSS *structure* (selectors, comments, @property shape,
 * keyframe syntax); every value it writes comes from the JSON. It has no
 * dependencies beyond Node itself, so it can run in CI with `npm ci` alone.
 *
 *   npm run tokens                     # write both files
 *   node scripts/gen-tokens.mjs --check  # exit 1 if either file is stale
 *
 * `src/styles/tokens-sync.test.ts` runs the --check mode, so a hand edit to
 * either generated file fails `npm test`.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = join(ROOT, "src", "styles", "tokens.tokens.json");
const CSS_OUT = join(ROOT, "src", "styles", "tokens.css");
const JS_OUT = join(ROOT, "src", "lib", "motion.ts");

const tokens = JSON.parse(readFileSync(SOURCE, "utf8"));

const bezier = (v) => `cubic-bezier(${v.join(", ")})`;

function valueOf(token) {
  if (token.$type === "cubicBezier") return bezier(token.$value);
  return token.$value;
}

/**
 * The z-layers' @property `initial-value` is DERIVED from the layer's
 * declared value, never stated a second time.
 *
 * A z-layer is written in two places in the CSS: the `@property`
 * registration (whose `initial-value` is what a DESCENDANT element
 * resolves, because the registration is `inherits: false`) and the
 * `:root` declaration (what `:root` itself resolves). Stating the number
 * twice let the two copies drift while every gate stayed green — the
 * copy nothing reads is the one that governs a nested consumer.
 *
 * So the JSON keeps ONE number per layer (`z.values.<name>.$value`) and
 * the generator writes it to both places. A registration whose `initial`
 * disagrees with its layer's value is a JSON error, not a silent
 * divergence: `checkZRegistrations` throws.
 */
function checkZRegistrations(t) {
  const problems = [];
  const seen = new Set();
  for (const reg of t.z.registrations) {
    // "--z-canvas" names the layer "canvas".
    const name = reg.name.replace(/^--z-/, "");
    const value = t.z.values[name];
    if (!value) {
      problems.push(`@property ${reg.name} has no z.values.${name}`);
      continue;
    }
    seen.add(name);
    // `initial` is optional: the layer's value is the single source. If the
    // registration does carry one, it must agree — otherwise the JSON is
    // asking for two different numbers for the same layer.
    if (reg.initial !== undefined && String(reg.initial) !== String(value.$value)) {
      problems.push(
        `@property ${reg.name} initial-value ${reg.initial} != z.values.${name}.$value ${value.$value}`,
      );
    }
  }
  for (const name of Object.keys(t.z.values)) {
    if (!seen.has(name)) {
      problems.push(`z.values.${name} has no @property registration`);
    }
  }
  if (problems.length) {
    throw new Error(`tokens: z registrations disagree with z values:\n  ${problems.join("\n  ")}`);
  }
}

function renderRegistration(reg, initialValue) {
  const lines = [];
  if (reg.$comment) lines.push(reg.$comment);
  const initial =
    initialValue === undefined
      ? reg.initial
      : String(initialValue);
  const rendered = reg.inlineComment
    ? `  initial-value: ${initial}; /* ${reg.inlineComment} */`
    : `  initial-value: ${initial};`;
  lines.push(
    `@property ${reg.name} {`,
    `  syntax: "${reg.syntax}";`,
    `  inherits: ${reg.inherits};`,
    rendered,
    `}`,
  );
  return lines.join("\n");
}

function renderCss(t) {
  const out = [];
  out.push(t.$cssHeader);

  const regs = t.registrations;
  out.push("", "/* ---- Registered custom properties --------------------------");
  out.push("   Registered via @property so gradients/filters driven by them");
  out.push("   interpolate *continuously* — never a class flip.");
  out.push("   ------------------------------------------------------------- */");
  for (const reg of regs) {
    if (reg.blankBefore) out.push("");
    out.push(renderRegistration(reg));
  }

  out.push("");
  out.push("/* ---- Stacking order (M1) ----------------------------------");
  out.push("   Registered as <integer> so a mistyped VALUE falls back to");
  out.push("   this layer's own initial instead of becoming invalid — the");
  out.push("   fallback is silent, not loud. Values are today's measured");
  out.push("   layers: canvas 10 (lib/lamp3d/renderer.ts), stage overlay 20,");
  out.push("   Radix dialog/popover 50, toast 100. No consumer reads them");
  out.push("   yet — this slice declares the scale; the migration is #27's.");
  out.push("   The @property initial-value is derived from z.values, so the");
  out.push("   registration and the :root declaration cannot disagree.");
  out.push("   ------------------------------------------------------------- */");
  for (const reg of t.z.registrations) {
    const name = reg.name.replace(/^--z-/, "");
    out.push(renderRegistration(reg, t.z.values[name]?.$value));
  }

  out.push("");
  out.push("/* ---- Primitives (theme-invariant) -------------------------- */");
  out.push(":root {");
  out.push("  /* radius scale (raw) — generous, smooth */");
  for (const [name, token] of Object.entries(t.primitive.radius)) {
    const desc = token.$description.padEnd(22);
    out.push(`  --radius-raw-${name}: ${valueOf(token)}; /* ${desc} */`);
  }
  out.push("");
  out.push("  /* motion */");
  for (const [name, token] of Object.entries(t.primitive.duration)) {
    out.push(`  --dur-${name}: ${valueOf(token)};`);
  }
  for (const [name, token] of Object.entries(t.primitive.ease)) {
    out.push(`  --ease-${name}: ${valueOf(token)};`);
  }
  out.push("");
  out.push("  /* space scale (#27) — the off-rhythm rungs the tree actually typed. The");
  out.push("     suffix is the measured pixel value, not a 4px multiplier: #27 renames");
  out.push("     values, it does not repaint them. Tailwind's 4px rhythm (p-3 = 12px,");
  out.push("     gap-2.5 = 10px) still comes from the one --spacing base.");
  out.push("     Bridged into Tailwind's spacing namespace below as p-space-3 etc. */");
  for (const [name, token] of Object.entries(t.primitive.space)) {
    out.push(`  --space-${name}: ${valueOf(token)};`);
  }
  out.push("");
  out.push("  /* one focus ring (#12). --accent is the app's own ring colour; it clears");
  out.push("     3:1 against every surface the ring is drawn on in both themes (#111214");
  out.push("     on #f7f7f8 = 17.9:1; #ffffff on #0b0c0e = 19.4:1). The two sites that");
  out.push("     cannot use an outline (a rounded Link and the orbit surface) consume the");
  out.push("     same token, so there is one ring, not two vocabularies. */");
  for (const [name, token] of Object.entries(t.primitive.focus)) {
    out.push(`  --focus-${name}: ${valueOf(token)};`);
  }
  out.push("");
  out.push("  /* safe-area insets (WebKit env() on notched / home-indicator devices;");
  out.push("     0px fallback on browsers that don't expose them) */");
  for (const [name, token] of Object.entries(t.primitive.safe)) {
    out.push(`  --safe-${name}: ${valueOf(token)};`);
  }
  out.push("");
  out.push("  /* #10 Landscape console: stage height formula for coarse-pointer short viewports.");
  out.push("     min(380px, 52dvh) keeps the dial above the fold on landscape phones. */");
  out.push(`  --stage-height-landscape: ${valueOf(t.primitive.landscape)};`);
  out.push("");
  out.push("  /* motion vocabulary (M1) — CSS half. lib/motion.ts is generated");
  out.push("     from the same JSON, so a spring cannot drift between the two");
  out.push("     vocabularies the way the `duration-150` utilities drifted from");
  out.push("     a duration scale that held 140/240/420. */");
  const fade = t.motion.fadeFast.$value;
  out.push(`  --motion-ease-out: ${bezier(t.motion.easeOut)};`);
  out.push(
    `  --motion-fade-fast: ${Math.round(fade.duration * 1000)}ms var(--motion-ease-out);`,
  );
  for (const [name, spring] of Object.entries(t.motion.springs)) {
    out.push(`  --motion-spring-${name}-stiffness: ${spring.$value.stiffness};`);
    out.push(`  --motion-spring-${name}-damping: ${spring.$value.damping};`);
  }
  out.push("");
  out.push("  /* stacking order (M1) — values documented above the @property set */");
  for (const [name, token] of Object.entries(t.z.values)) {
    out.push(`  --z-${name}: ${token.$value};`);
  }
  out.push("}");

  for (const theme of Object.values(t.themes)) {
    out.push("");
    out.push(theme.$comment);
    out.push(`${theme.selector} {`);
    out.push(`  color-scheme: ${theme.colorScheme};`);
    theme.groups.forEach((group) => {
      out.push("");
      if (group.$comment) out.push(`  ${group.$comment}`);
      for (const name of group.tokens) {
        out.push(`  --${name}: ${valueOf(theme.tokens[name])};`);
      }
    });
    out.push("}");
  }

  out.push("");
  out.push("/* ---- Tailwind theme bridge ----------------------------------");
  out.push("   `inline` so utilities reference the live custom properties and");
  out.push("   follow the active theme without re-emitting values.");
  out.push("   -------------------------------------------------------------- */");
  out.push("@theme inline {");
  const bridge = t.bridge;
  bridge.sections.forEach((section, i) => {
    if (i > 0) out.push("");
    if (section.$comment) out.push(`  ${section.$comment}`);
    for (const [name, token] of Object.entries(section.tokens)) {
      out.push(`  ${name}: ${valueOf(token)};`);
    }
  });
  out.push("");
  Object.entries(bridge.keyframes).forEach(([name, steps], i) => {
    if (i > 0) out.push("");
    out.push(`  @keyframes ${name} {`);
    for (const step of steps) {
      out.push(`    ${step.selectors} {`);
      for (const [prop, value] of Object.entries(step.declarations)) {
        out.push(`      ${prop}: ${value};`);
      }
      out.push("    }");
    }
    out.push("  }");
  });
  out.push("}");

  return out.join("\n") + "\n";
}

function renderJs(t) {
  const m = t.motion;
  const out = [];
  out.push('import type { Transition, Variants } from "motion/react";');
  out.push("");
  out.push("/**");
  out.push(" * App-wide motion vocabulary. Nothing snaps, ever.");
  out.push(" *");
  out.push(" * GENERATED FILE — do not edit by hand.");
  out.push(" * Source of truth: src/styles/tokens.tokens.json (the same file that");
  out.push(" * generates tokens.css). Regenerate with `npm run tokens`.");
  out.push(" *");
  for (const [name, spring] of Object.entries(m.springs)) {
    const exportName = `spring${name[0].toUpperCase() + name.slice(1)}`;
    out.push(
      ` * ${exportName.padEnd(16)}— ${spring.$description} (${spring.$value.stiffness}/${spring.$value.damping})`,
    );
  }
  out.push(` * ${"fadeFast".padEnd(16)}— ${m.fadeFast.$description}`);
  out.push(" */");
  for (const [name, spring] of Object.entries(m.springs)) {
    const exportName = `spring${name[0].toUpperCase() + name.slice(1)}`;
    if (spring.$comment) {
      out.push("");
      const lines = spring.$comment;
      lines.forEach((line, i) => {
        if (i === 0) out.push(`/** ${line}`);
        else out.push(`    ${line}${i === lines.length - 1 ? " */" : ""}`);
      });
    }
    out.push(`export const ${exportName}: Transition = {`);
    out.push('  type: "spring",');
    out.push(`  stiffness: ${spring.$value.stiffness},`);
    out.push(`  damping: ${spring.$value.damping},`);
    out.push("};");
  }
  out.push("");
  out.push(
    `export const fadeFast: Transition = { duration: ${m.fadeFast.$value.duration}, ease: "${m.fadeFast.$value.ease}" };`,
  );
  for (const [name, variant] of Object.entries(m.variants)) {
    out.push("");
    out.push("/** " + variant.$description + " */");
    out.push(`export const ${name}: Variants = {`);
    for (const [state, body] of Object.entries(variant.states)) {
      const entries = Object.entries(body);
      if (entries.length === 0) {
        out.push(`  ${state}: {},`);
        continue;
      }
      const inline = entries
        .map(([key, value]) => {
          if (key === "transition" && typeof value === "object") {
            const inner = Object.entries(value)
              .map(([k, v]) => `${k}: ${v}`)
              .join(", ");
            return `transition: { ${inner} }`;
          }
          return `${key}: ${value}`;
        })
        .join(", ");
      out.push(`  ${state}: { ${inline} },`);
    }
    out.push("};");
  }
  return out.join("\n") + "\n";
}

function main() {
  const check = process.argv.includes("--check");
  // A z-layer's number lives in ONE place in the JSON. If the @property
  // registrations disagree with it, the JSON is wrong — fail before writing
  // or checking anything, so a divergence can never reach the CSS.
  checkZRegistrations(tokens);
  const rendered = [
    { path: CSS_OUT, label: "src/styles/tokens.css", text: renderCss(tokens) },
    { path: JS_OUT, label: "src/lib/motion.ts", text: renderJs(tokens) },
  ];

  if (check) {
    // Git's autocrlf can hand a Windows checkout CRLF text for a file the
    // generator writes with LF. That is a checkout artifact, not token drift,
    // so line endings are normalised for the comparison only; the written
    // bytes are always LF.
    const normalise = (text) => text.replace(/\r\n/g, "\n");
    const stale = [];
    for (const file of rendered) {
      const actual = normalise(readFileSync(file.path, "utf8"));
      if (actual !== normalise(file.text)) stale.push(file.label);
    }
    if (stale.length) {
      console.error(
        `tokens: OUT OF SYNC — ${stale.join(", ")} differ from tokens.tokens.json.\n` +
          "Run `npm run tokens` in webui/app and commit the result.",
      );
      process.exit(1);
    }
    console.log("tokens: in sync — tokens.css and lib/motion.ts match tokens.tokens.json");
    return;
  }

  for (const file of rendered) {
    writeFileSync(file.path, file.text, "utf8");
    console.log(`wrote ${file.label}`);
  }
}

main();
