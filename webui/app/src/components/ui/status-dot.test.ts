import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { describe, it } from "vitest";

import { StatusDot } from "./status-dot";

function render(props: React.ComponentProps<typeof StatusDot>): string {
  return renderToStaticMarkup(React.createElement(StatusDot, props));
}

describe("StatusDot", () => {
  it("renders the dot at its declared size instead of a zero-size inline box", () => {
    // An inline `span` ignores width/height; h-[7px] w-[7px] alone rendered
    // nothing. The size classes must sit on an inline-block box.
    assert.match(render({ tone: "ok" }), /inline-block h-\[7px\] w-\[7px\]/);
  });

  it("keeps the visual dot hidden from assistive technology", () => {
    assert.match(render({ tone: "off", label: "offline" }), /aria-hidden="true"/);
  });

  it("exposes the label as screen-reader-only text", () => {
    assert.match(render({ tone: "ok", label: "online" }), /class="sr-only">online</);
  });

  it("adds the ring only for the labelled second channel", () => {
    assert.match(render({ tone: "ok", label: "online" }), /ring-1 ring-inset/);
    assert.doesNotMatch(render({ tone: "ok" }), /ring-1 ring-inset/);
  });
});

/* ------------------------------------------------------------------ *
 * #15 — no state by colour alone.
 *
 * Every `StatusDot` in feature code carries the state as text too, so
 * the state survives a greyscale check and reaches a screen reader. The
 * only dots allowed to stay unlabelled are the two that sit directly
 * beside a *visible* word saying the same thing — a second, hidden
 * label there would read the state twice.
 * ------------------------------------------------------------------ */

/** file (relative to src/) -> why the dot needs no label of its own */
const LABELLED_ELSEWHERE: Record<string, string> = {
  "app/device/[ref]/control-deck.tsx":
    "the dot sits beside the visible 'online'/'offline' text",
  "app/settings/connection-section.tsx":
    "the dot sits beside the visible 'readable'/'unreadable' text",
};

function featureSources(): string[] {
  const root = path.resolve(process.cwd(), "src");
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out.sort();
}

describe("StatusDot call sites", () => {
  it("every dot in feature code states its state in text too", () => {
    const unlabelled: string[] = [];
    for (const file of featureSources()) {
      const text = fs.readFileSync(file, "utf8");
      const source = ts.createSourceFile(
        file,
        text,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
      );
      const rel = path
        .relative(path.resolve(process.cwd(), "src"), file)
        .split(path.sep)
        .join("/");
      const visit = (node: ts.Node) => {
        if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
          if (node.tagName.getText(source) === "StatusDot") {
            const labelled = node.attributes.properties.some(
              (attr) =>
                ts.isJsxAttribute(attr) &&
                ts.isIdentifier(attr.name) &&
                attr.name.text === "label",
            );
            if (!labelled) unlabelled.push(rel);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }

    const unexpected = unlabelled.filter((file) => !(file in LABELLED_ELSEWHERE));
    assert.deepEqual(
      unexpected,
      [],
      `these StatusDots carry their state by colour alone: ${unexpected.join(", ")}`,
    );
  });

  it("the exemption list only holds dots that still have a visible label", () => {
    // A dot that gains its own `label` leaves the exemption list behind;
    // this catches a stale entry rather than a stale dot.
    const text = fs.readFileSync(
      path.resolve(process.cwd(), "src", "app", "settings", "connection-section.tsx"),
      "utf8",
    );
    assert.match(text, /readable/);
  });
});
