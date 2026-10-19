import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { describe, it } from "vitest";

import { announce, subscribeAnnouncements } from "./announce";
import { Toaster, ToastProvider } from "@/components/ui/toaster";

describe("announce bus", () => {
  it("delivers announcements to subscribers", () => {
    const heard: string[] = [];
    const unsubscribe = subscribeAnnouncements((message) => heard.push(message));

    announce("Room scene \"Mornings\" saved");

    assert.deepEqual(heard, ["Room scene \"Mornings\" saved"]);
    unsubscribe();
  });

  it("stops delivering after unsubscribe", () => {
    const heard: string[] = [];
    const unsubscribe = subscribeAnnouncements((message) => heard.push(message));
    unsubscribe();

    announce("Room scene \"Mornings\" saved");

    assert.deepEqual(heard, []);
  });

  it("collapses consecutive identical messages into one announcement", () => {
    const heard: string[] = [];
    subscribeAnnouncements((message) => heard.push(message));

    announce("Schedule saved");
    announce("Schedule saved");
    announce("Schedule saved");

    assert.deepEqual(heard, ["Schedule saved"]);
  });

  it("re-announces an earlier message once a different one intervened", () => {
    const heard: string[] = [];
    subscribeAnnouncements((message) => heard.push(message));

    // `lastAnnounced` is module-level, so start from a message no other
    // test uses; what is under test is only the collapse behaviour.
    announce("Brightness 40% set");
    announce("Schedule updated");
    announce("Brightness 40% set");

    assert.deepEqual(heard, [
      "Brightness 40% set",
      "Schedule updated",
      "Brightness 40% set",
    ]);
  });
});

/* ------------------------------------------------------------------ *
 * One channel per state change (#13 / MEDIUM-2).
 *
 * The room-scene save used to call `announce("Room scene … saved")` *and*
 * `toast({ title: "Room scene … saved" })`. `Toaster` is itself an
 * `aria-live="polite"` region, so a screen reader heard the same sentence
 * twice. `lib/announce.ts` forbids exactly that ("nothing announced here
 * is also toasted … callers pick exactly one channel"), and these tests
 * hold the line: the toast is proven to be a live region (so it is a
 * channel in its own right), and no message in `src/` may be both
 * announced and toasted.
 * ------------------------------------------------------------------ */

/** Every feature .ts/.tsx file under the app's src/, sorted for stable output. */
function appSources(): string[] {
  const root = path.resolve(process.cwd(), "src");
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out.sort();
}

interface Channel {
  /** file the call was found in, relative to src/ */
  file: string;
  /** the message, with `${…}` flattened so two spellings of one message match */
  message: string;
  /** "announce" or "toast" */
  kind: "announce" | "toast";
}

/**
 * The message a string-ish expression spells out. A template expression is
 * flattened to `head${…}tail` so `Room scene "${result.name}" saved` and
 * the same sentence written with a different variable compare equal.
 */
function literalText(node: ts.Node | undefined): string | null {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  if (ts.isTemplateExpression(node)) {
    return (
      node.head.text +
      node.templateSpans
        .map((span) => "${…}" + span.literal.text)
        .join("")
    );
  }
  return null;
}

/**
 * Every `announce(...)` and `toast({ title: … })` call in one file, read
 * from the syntax tree rather than from the text — a comment that mentions
 * `announce(` is not a call.
 */
function channelsIn(file: string): Channel[] {
  const text = fs.readFileSync(file, "utf8");
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const rel = path.relative(path.resolve(process.cwd(), "src"), file);
  const out: Channel[] = [];

  const walk = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const callee = node.expression.text;
      if (callee === "announce") {
        const message = literalText(node.arguments[0]);
        if (message !== null) out.push({ file: rel, message, kind: "announce" });
      }
      if (callee === "toast") {
        const arg = node.arguments[0];
        if (arg && ts.isObjectLiteralExpression(arg)) {
          for (const prop of arg.properties) {
            if (
              ts.isPropertyAssignment(prop) &&
              ts.isIdentifier(prop.name) &&
              prop.name.text === "title"
            ) {
              const message = literalText(prop.initializer);
              if (message !== null) out.push({ file: rel, message, kind: "toast" });
            }
          }
        }
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(source);
  return out;
}

/** Every channel in the app's feature code. */
function allChannels(): Channel[] {
  return appSources().flatMap(channelsIn);
}

/** The channel calls inside one named function of one file. */
function channelsInFunction(file: string, fnName: string): Channel[] {
  const text = fs.readFileSync(file, "utf8");
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const rel = path.relative(path.resolve(process.cwd(), "src"), file);
  const out: Channel[] = [];

  const collect = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const callee = node.expression.text;
      if (callee === "announce" || callee === "toast") {
        let message: string | null = null;
        if (callee === "announce") {
          message = literalText(node.arguments[0]);
        } else {
          const arg = node.arguments[0];
          if (arg && ts.isObjectLiteralExpression(arg)) {
            for (const prop of arg.properties) {
              if (
                ts.isPropertyAssignment(prop) &&
                ts.isIdentifier(prop.name) &&
                prop.name.text === "title"
              ) {
                message = literalText(prop.initializer);
              }
            }
          }
        }
        if (message !== null) {
          out.push({ file: rel, message, kind: callee });
        }
      }
    }
    ts.forEachChild(node, collect);
  };

  const visit = (node: ts.Node) => {
    if (
      (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) &&
      node.name?.text === fnName
    ) {
      ts.forEachChild(node.body ?? node, collect);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

describe("one channel per state change", () => {
  it("the toast stack is itself a live region, so a toast is already spoken", () => {
    const markup = renderToStaticMarkup(
      React.createElement(
        ToastProvider,
        null,
        React.createElement(Toaster),
      ),
    );
    assert.match(
      markup,
      /aria-live="polite"/,
      "Toaster must stay an aria-live region — it is the screen-reader channel for toasts",
    );
  });

  it("no message is both announced and toasted", () => {
    const channels = allChannels();
    const toasted = channels.filter((c) => c.kind === "toast").map((c) => c.message);
    const both = channels
      .filter((c) => c.kind === "announce" && toasted.includes(c.message))
      .map((c) => `${c.file}: ${c.message}`);
    assert.deepEqual(
      both,
      [],
      `these messages are announced *and* toasted, so a screen reader hears them twice: ${both.join(" | ")}`,
    );
  });

  it("the room-scene save is still said exactly once, by the toast", () => {
    const roomSceneSaves = allChannels().filter((c) =>
      /^Room scene .* saved$/.test(c.message),
    );
    assert.equal(
      roomSceneSaves.length,
      1,
      `the room-scene save must speak once, not ${roomSceneSaves.length} times: ${roomSceneSaves
        .map((c) => `${c.kind}@${c.file}`)
        .join(", ")}`,
    );
    assert.equal(
      roomSceneSaves[0].kind,
      "toast",
      "the room-scene save must be spoken by the toast — the live region",
    );
  });

  it("useCaptureRoom speaks through exactly one channel", () => {
    const channels = channelsInFunction(
      path.resolve(process.cwd(), "src/lib/queries.ts"),
      "useCaptureRoom",
    );
    const kinds = channels.map((c) => c.kind);
    assert.ok(
      kinds.includes("toast"),
      "useCaptureRoom must still toast the room-scene save",
    );
    assert.ok(
      !kinds.includes("announce"),
      "useCaptureRoom must not announce the same sentence: the toast is the live-region channel",
    );
  });
});
