/// <reference lib="dom" />

// The sidebar's per-connector guide picker: one entry per connector, each
// opening ONLY that connector's guide inline (no aggregate guide exists).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConnectorGuides } from "./ConnectorGuides";

const realFetch = globalThis.fetch;
let fetchCalls: string[] = [];

beforeEach(() => {
  fetchCalls = [];
  globalThis.fetch = ((input: RequestInfo | URL) => {
    fetchCalls.push(String(input));
    return Promise.resolve(
      new Response(
        JSON.stringify({ path: "remote-access/tailscale", title: "Tailscale", markdown: "Tailnet-private access." }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("ConnectorGuides", () => {
  test("renders one guide entry per connector", () => {
    render(<ConnectorGuides />);
    for (const name of ["Gini Relay", "Tailscale", "ngrok", "Cloudflare"]) {
      expect(screen.queryByRole("button", { name: `${name} remote access guide` })).not.toBeNull();
    }
    expect(screen.queryByText("Remote access")).not.toBeNull();
  });

  test("an entry opens that connector's guide (connector-scoped fetch)", async () => {
    const user = userEvent.setup();
    render(<ConnectorGuides />);
    await user.click(screen.getByRole("button", { name: "Tailscale remote access guide" }));
    await waitFor(() => expect(screen.queryByText("Tailnet-private access.")).not.toBeNull());
    expect(fetchCalls).toEqual(["/api/runtime/docs/remote-access/tailscale"]);
  });
});
