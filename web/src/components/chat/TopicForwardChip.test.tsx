/// <reference lib="dom" />

// The TopicForwardChip is the deep-link pill rendered under a forwarded Topic
// answer in the main Chat. It must show the Topic's `#title`, link to the
// Topic's own conversation via `?session=<id>`, and fall back to a generic
// "#topic" label when the forwarded title is missing or blank.

import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { TopicForwardChip } from "./TopicForwardChip";

describe("TopicForwardChip", () => {
  test("renders the topic title and a deep link to the topic session", () => {
    render(<TopicForwardChip topicId="topic-123" topicTitle="World Cup trip" />);
    expect(screen.getByText("#World Cup trip")).not.toBeNull();
    const link = screen.getByText("View topic →").closest("a");
    expect(link?.getAttribute("href")).toBe("/chat?session=topic-123");
  });

  test("falls back to a generic label when the title is missing or blank", () => {
    render(<TopicForwardChip topicId="topic-456" topicTitle="   " />);
    expect(screen.getByText("#topic")).not.toBeNull();
    const link = screen.getByText("View topic →").closest("a");
    expect(link?.getAttribute("href")).toBe("/chat?session=topic-456");
  });
});
