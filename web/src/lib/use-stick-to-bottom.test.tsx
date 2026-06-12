/// <reference lib="dom" />

// useStickToBottom: the first snap for a view must be instant ("auto") so a
// transcript opens already at the bottom; growth within the same view scrolls
// "smooth". A key change (panel reused for a different conversation) and an
// enabled false→true cycle (tab hidden then shown again) both re-arm the
// instant snap. scrollIntoView isn't implemented in happy-dom, so it's spied.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { render } from "@testing-library/react";
import { useStickToBottom } from "./use-stick-to-bottom";

let behaviors: (ScrollBehavior | undefined)[] = [];
const original = Element.prototype.scrollIntoView;

beforeEach(() => {
  behaviors = [];
  Element.prototype.scrollIntoView = mock((arg?: boolean | ScrollIntoViewOptions) => {
    behaviors.push(typeof arg === "object" ? arg.behavior : undefined);
  });
});

afterEach(() => {
  Element.prototype.scrollIntoView = original;
});

function Harness({ count, k, enabled }: { count: number; k?: unknown; enabled?: boolean }) {
  const ref = useStickToBottom(count, { key: k, enabled });
  return <div ref={ref} data-testid="end" />;
}

describe("useStickToBottom", () => {
  test("first snap is instant, later growth is smooth", () => {
    const { rerender } = render(<Harness count={1} k="s1" />);
    expect(behaviors).toEqual(["auto"]);

    rerender(<Harness count={2} k="s1" />);
    expect(behaviors).toEqual(["auto", "smooth"]);

    rerender(<Harness count={3} k="s1" />);
    expect(behaviors).toEqual(["auto", "smooth", "smooth"]);
  });

  test("changing the key re-arms the instant snap", () => {
    const { rerender } = render(<Harness count={1} k="s1" />);
    rerender(<Harness count={2} k="s1" />);
    expect(behaviors).toEqual(["auto", "smooth"]);

    // Same instance, different conversation → snap instantly again.
    rerender(<Harness count={5} k="s2" />);
    expect(behaviors).toEqual(["auto", "smooth", "auto"]);
  });

  test("disabling skips the scroll and re-arms on re-enable", () => {
    const { rerender } = render(<Harness count={1} k="s1" enabled />);
    expect(behaviors).toEqual(["auto"]);

    // Hidden view: background growth must not scroll or consume the latch.
    rerender(<Harness count={2} k="s1" enabled={false} />);
    expect(behaviors).toEqual(["auto"]);

    // Returning to the view snaps instantly, not smoothly.
    rerender(<Harness count={2} k="s1" enabled />);
    expect(behaviors).toEqual(["auto", "auto"]);
  });

  test("defaults to enabled with an undefined key", () => {
    const { rerender } = render(<Harness count={1} />);
    expect(behaviors).toEqual(["auto"]);
    rerender(<Harness count={2} />);
    expect(behaviors).toEqual(["auto", "smooth"]);
  });
});
