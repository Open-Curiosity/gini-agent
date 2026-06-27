/// <reference lib="dom" />
import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { MarkdownContent } from "./MarkdownContent";

describe("repro net", () => {
  test("linked foreign image with target.example href, no click", () => {
    const { container } = render(
      <MarkdownContent text="[![a cat](https://evil.example/p.gif)](https://target.example)" dropForeignImages />
    );
    expect(container.querySelectorAll("a").length).toBe(1);
  });
});
