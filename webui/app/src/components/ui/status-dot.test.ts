import assert from "node:assert/strict";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
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
