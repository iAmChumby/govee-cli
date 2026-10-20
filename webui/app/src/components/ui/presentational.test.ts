import assert from "node:assert/strict";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "vitest";

import { Input } from "./input";
import { Pressable } from "./pressable";
import { Select } from "./select";

/**
 * The presentational trio — `Pressable`, `Input`, `Select` — is the
 * destination M2's `react/forbid-elements` gate points at, and the
 * half-way house between M2 (no raw primitives outside `components/ui/`)
 * and M3 (#30, the styled promotion of the six-panel chain and the page
 * shell).
 *
 * Their whole promise is that promoting a raw element onto one of them
 * changes NOTHING a user can see or do: the same element, the same
 * attributes, the same classes, the same handlers, the same ref. This
 * test is that promise, asserted:
 *
 *   - the element is the one it replaces (a button, an input, a select);
 *   - every prop reaches the DOM — `type`, `name`, `value`, `disabled`,
 *     every `aria-*`, every `data-*`, every handler;
 *   - the ref is forwarded to the DOM node (a control that cannot be
 *     focused programmatically is a control a keyboard test cannot reach);
 *   - and, the load-bearing one: **the part adds no class of its own**.
 *     The rendered `class` attribute is exactly the `className` that was
 *     passed in. A part that painted anything of its own would restyle
 *     62 call sites the moment it landed — `cn()` is a plain string join
 *     with no `tailwind-merge` (CLAUDE.md), so an added base class could
 *     lose to the call site's own `h-*`/padding by emitted-rule order
 *     alone. Adding nothing is what makes the promotion value-neutral.
 *
 * The #12 focus ring and the 44px coarse hit area therefore SURVIVE the
 * promotion by construction: the ring is painted by the base layer's
 * `:focus-visible` rule, and the coarse floor lives in the call site's own
 * `pointer-coarse:` classes — both of which are part of the `className`
 * this test proves is forwarded byte for byte.
 */

const el = (
  component: React.ElementType,
  props: Record<string, unknown> = {},
  children?: React.ReactNode,
) => React.createElement(component, props, children);

const html = (element: React.ReactElement) => renderToStaticMarkup(element);

describe("the presentational control parts", () => {
  it("renders the element it replaces", () => {
    assert.match(html(el(Pressable, {}, "x")), /^<button/);
    assert.match(html(el(Input)), /^<input/);
    assert.match(
      html(el(Select, {}, el("option", { value: "a" }, "a"))),
      /^<select/,
    );
  });

  it("adds no class of its own", () => {
    // The class string a call site passes is the class string the DOM gets.
    for (const cls of [
      "h-9 w-full rounded-btn border border-hairline bg-raised px-3 text-body text-hi",
      // the coarse floor the 44px rule depends on
      "h-7 w-7 rounded-chip pointer-coarse:min-h-11 pointer-coarse:min-w-11",
      // the one focus ring's cancel is banned outside components/ui/, so a
      // promoted control keeps the base layer's ring
      "focus-visible:border-hairline-strong",
    ]) {
      assert.match(html(el(Pressable, { className: cls })), new RegExp(`class="${cls}"`));
      assert.match(html(el(Input, { className: cls })), new RegExp(`class="${cls}"`));
      assert.match(html(el(Select, { className: cls })), new RegExp(`class="${cls}"`));
    }
  });

  it("forwards every prop to the DOM", () => {
    const markup = html(
      el(Input, {
        id: "effect-name",
        name: "effect",
        type: "text",
        defaultValue: "shelf-drum-spiral",
        placeholder: "shelf-drum-spiral",
        spellCheck: false,
        autoComplete: "off",
        maxLength: 7,
        "aria-label": "Effect name",
        "aria-invalid": true,
        "data-testid": "effect-field",
      }),
    );
    assert.match(markup, /id="effect-name"/);
    assert.match(markup, /name="effect"/);
    assert.match(markup, /type="text"/);
    assert.match(markup, /value="shelf-drum-spiral"/);
    assert.match(markup, /placeholder="shelf-drum-spiral"/);
    assert.match(markup, /spellcheck="false"/i);
    assert.match(markup, /autocomplete="off"/i);
    assert.match(markup, /maxlength="7"/i);
    assert.match(markup, /aria-label="Effect name"/);
    assert.match(markup, /aria-invalid="true"/);
    assert.match(markup, /data-testid="effect-field"/);
  });

  it("keeps the button's own attributes, including the disabled state", () => {
    const markup = html(
      el(
        Pressable,
        {
          type: "button",
          "aria-pressed": true,
          "aria-label": "Set color #FF8800",
          title: "#FF8800",
          "data-volatile": "true",
          disabled: true,
        },
        "x",
      ),
    );
    assert.match(markup, /type="button"/);
    assert.match(markup, /aria-pressed="true"/);
    assert.match(markup, /aria-label="Set color #FF8800"/);
    assert.match(markup, /title="#FF8800"/);
    assert.match(markup, /data-volatile="true"/);
    assert.match(markup, /disabled=""/);
  });

  it("defaults a button to type=button, so it cannot submit a form", () => {
    assert.match(html(el(Pressable, {}, "x")), /type="button"/);
    // an explicit type still wins
    assert.match(html(el(Pressable, { type: "submit" }, "x")), /type="submit"/);
  });

  it("keeps the select's children", () => {
    const markup = html(
      el(
        Select,
        { "aria-label": "default device" },
        [
          el("option", { key: "a", value: "a" }, "a"),
          el("option", { key: "b", value: "b" }, "b"),
        ],
      ),
    );
    assert.match(markup, /aria-label="default device"/);
    assert.match(markup, /<option value="a">a<\/option>/);
    assert.match(markup, /<option value="b">b<\/option>/);
  });

  it("forwards the ref to the DOM element", () => {
    // A control that cannot be focused programmatically is a control a
    // keyboard test cannot reach, so the ref has to arrive at the DOM node.
    // `renderToStaticMarkup` does not attach refs (server rendering has no
    // node to attach them to), so the render function is called directly:
    // React hands the ref to the second argument of a forwardRef render
    // function, and the part's job is to put it on the element.
    const ref = React.createRef<HTMLButtonElement>();
    const rendered = (
      Pressable as unknown as {
        render: (props: object, ref: React.Ref<unknown>) => React.ReactElement;
      }
    ).render({ children: "x" }, ref);
    assert.equal(rendered.type, "button");
    assert.equal((rendered.props as { ref?: unknown }).ref, ref);

    const inputRef = React.createRef<HTMLInputElement>();
    const inputRendered = (
      Input as unknown as {
        render: (props: object, ref: React.Ref<unknown>) => React.ReactElement;
      }
    ).render({}, inputRef);
    assert.equal(inputRendered.type, "input");
    assert.equal((inputRendered.props as { ref?: unknown }).ref, inputRef);

    const selectRef = React.createRef<HTMLSelectElement>();
    const selectRendered = (
      Select as unknown as {
        render: (props: object, ref: React.Ref<unknown>) => React.ReactElement;
      }
    ).render({}, selectRef);
    assert.equal(selectRendered.type, "select");
    assert.equal((selectRendered.props as { ref?: unknown }).ref, selectRef);
  });
});
