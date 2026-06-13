/// <reference lib="dom" />

// TunnelSelectionPanel is presentational: it renders provider rows from props
// and routes every interaction (select by click/keyboard, connect, cancel,
// close) straight back through its callbacks. These tests render it directly
// with crafted TunnelState objects so each render branch and handler is
// exercised — idle selection, the connecting fold, the disabled
// non-selected rows, the error message, and the header/footer controls.

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { fireEvent } from "@testing-library/react";
import type { TunnelProvider, TunnelState } from "./types";
import { TunnelSelectionPanel } from "./TunnelSelectionPanel";

const PROVIDERS: TunnelProvider[] = [
  { id: "gini-relay", name: "Gini Relay", enabled: true },
  { id: "tailscale", name: "Tailscale", enabled: false, requires: "Tailscale network" },
  { id: "ngrok", name: "ngrok", enabled: false, requires: "ngrok account" },
  { id: "cloudflare", name: "Cloudflare", enabled: false, requires: "cloudflared CLI" }
];

function makeState(over: Partial<TunnelState> = {}): TunnelState {
  return { providers: PROVIDERS, selectedProvider: "gini-relay", status: "idle", ...over };
}

const handlers = {
  onSelect: mock((_: TunnelProvider["id"]) => {}),
  onConnect: mock((_?: TunnelProvider["id"]) => {}),
  onCancel: mock(() => {}),
  onDisconnect: mock(() => {}),
  onClose: mock(() => {})
};

function renderPanel(over: Partial<TunnelState> = {}) {
  return render(
    <TunnelSelectionPanel
      state={makeState(over)}
      onSelect={handlers.onSelect}
      onConnect={handlers.onConnect}
      onCancel={handlers.onCancel}
      onDisconnect={handlers.onDisconnect}
      onClose={handlers.onClose}
    />
  );
}

// Find a provider row by its accessible name (the row is role="radio").
function row(name: string): HTMLElement {
  return screen.getByRole("radio", { name: new RegExp(name) });
}

beforeEach(() => {
  for (const fn of Object.values(handlers)) fn.mockClear();
});

describe("TunnelSelectionPanel", () => {
  test("renders the header and an enabled, selectable provider row", () => {
    renderPanel();
    expect(screen.queryByText("Tunnel provider")).not.toBeNull();
    expect(screen.queryByText("Choose how Gini is exposed")).not.toBeNull();
    const enabled = row("Gini Relay");
    expect(enabled.getAttribute("aria-disabled")).toBeNull();
    expect(enabled.getAttribute("tabindex")).toBe("0");
    expect(enabled.getAttribute("aria-checked")).toBe("true");
  });

  test("the selected row is marked with a 'Selected' text label", () => {
    renderPanel();
    expect(within(row("Gini Relay")).queryByText("Selected")).not.toBeNull();
  });

  test("unavailable rows show their requirement and an aria-disabled, untabbable radio", () => {
    renderPanel();
    expect(screen.queryByText(/Requires Tailscale network/)).not.toBeNull();
    expect(screen.queryByText(/Requires ngrok account/)).not.toBeNull();
    expect(screen.queryByText(/Requires cloudflared CLI/)).not.toBeNull();
    const disabled = row("Tailscale");
    expect(disabled.getAttribute("aria-disabled")).toBe("true");
    expect(disabled.getAttribute("tabindex")).toBe("-1");
  });

  test("EVERY row's Connect is live — an unavailable provider's Connect routes onConnect (the gateway re-checks and the owner opens the guide)", async () => {
    const user = userEvent.setup();
    renderPanel();
    const tailscaleConnect = screen.getByRole("button", { name: "Connect Tailscale" });
    expect((tailscaleConnect as HTMLButtonElement).disabled).toBe(false);
    await user.click(tailscaleConnect);
    expect(handlers.onConnect).toHaveBeenCalledWith("tailscale");
    // Connect must not also select the (unselectable) row.
    expect(handlers.onSelect).not.toHaveBeenCalled();
  });

  test("a non-selected ENABLED row's Connect routes onConnect directly (connect implies select)", async () => {
    const user = userEvent.setup();
    renderPanel({ selectedProvider: null });
    await user.click(screen.getByRole("button", { name: "Connect Gini Relay" }));
    expect(handlers.onConnect).toHaveBeenCalledWith("gini-relay");
  });

  test("clicking an enabled, non-selected row selects it", async () => {
    const user = userEvent.setup();
    // Select cloudflare-as-selected so gini-relay is enabled but NOT selected.
    render(
      <TunnelSelectionPanel
        state={makeState({ selectedProvider: null })}
        onSelect={handlers.onSelect}
        onConnect={handlers.onConnect}
        onCancel={handlers.onCancel}
        onDisconnect={handlers.onDisconnect}
        onClose={handlers.onClose}
      />
    );
    await user.click(row("Gini Relay"));
    expect(handlers.onSelect).toHaveBeenCalledWith("gini-relay");
  });

  test("clicking a disabled row does not select it", async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(row("Tailscale"));
    expect(handlers.onSelect).not.toHaveBeenCalled();
  });

  test("pressing Enter on a focused enabled row selects it", async () => {
    const user = userEvent.setup();
    renderPanel({ selectedProvider: null });
    row("Gini Relay").focus();
    await user.keyboard("{Enter}");
    expect(handlers.onSelect).toHaveBeenCalledWith("gini-relay");
  });

  test("pressing Space on a focused enabled row selects it", async () => {
    const user = userEvent.setup();
    renderPanel({ selectedProvider: null });
    row("Gini Relay").focus();
    await user.keyboard(" ");
    expect(handlers.onSelect).toHaveBeenCalledWith("gini-relay");
  });

  test("a non-Enter/Space key on an enabled row does not select", () => {
    renderPanel({ selectedProvider: null });
    fireEvent.keyDown(row("Gini Relay"), { key: "ArrowDown" });
    expect(handlers.onSelect).not.toHaveBeenCalled();
  });

  test("keydown on a disabled row returns early without selecting", () => {
    renderPanel();
    fireEvent.keyDown(row("Tailscale"), { key: "Enter" });
    expect(handlers.onSelect).not.toHaveBeenCalled();
  });

  test("idle + selected: clicking the row's Connect routes onConnect with the id", async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole("button", { name: "Connect Gini Relay" }));
    expect(handlers.onConnect).toHaveBeenCalledWith("gini-relay");
    // The action cluster sits beside the radio, not inside it — clicking
    // Connect must not also select.
    expect(handlers.onSelect).not.toHaveBeenCalled();
  });

  test("connecting: the selected row shows Connecting and a Cancel button", async () => {
    const user = userEvent.setup();
    renderPanel({ status: "connecting" });
    expect(screen.queryByText("Connecting...")).not.toBeNull();
    const cancel = screen.getByRole("button", { name: "Cancel Gini Relay connect" });
    await user.click(cancel);
    expect(handlers.onCancel).toHaveBeenCalledTimes(1);
    expect(handlers.onSelect).not.toHaveBeenCalled();
  });

  test("connecting: non-selected rows, their Connects, and Save are disabled", () => {
    renderPanel({ status: "connecting" });
    const tailscale = row("Tailscale");
    expect(tailscale.getAttribute("aria-disabled")).toBe("true");
    expect(tailscale.getAttribute("tabindex")).toBe("-1");
    // The one in-flight connect locks every other row's Connect too.
    expect((screen.getByRole("button", { name: "Connect Tailscale" }) as HTMLButtonElement).disabled).toBe(true);
    const save = screen.getByRole("button", { name: "Save" });
    expect((save as HTMLButtonElement).disabled).toBe(true);
  });

  test("connected: the selected row shows Disconnect (not Connect) and routes onDisconnect", async () => {
    const user = userEvent.setup();
    renderPanel({ status: "connected", url: "https://g31.example" });
    expect(screen.queryByRole("button", { name: "Connect Gini Relay" })).toBeNull();
    const disconnect = screen.getByRole("button", { name: "Disconnect Gini Relay" });
    await user.click(disconnect);
    expect(handlers.onDisconnect).toHaveBeenCalledTimes(1);
    expect(handlers.onSelect).not.toHaveBeenCalled();
  });

  test("connected ⇒ available: a LIVE provider flagged !enabled by detection still shows Disconnect, no 'Requires', and a selectable radio", () => {
    // The detection probe lagged/flaked and reports cloudflare unavailable,
    // but it is the live tunnel. The connection is the source of truth: the
    // row must read available, not "unavailable + Connect".
    const stale: TunnelProvider[] = [
      { id: "gini-relay", name: "Gini Relay", enabled: true },
      { id: "tailscale", name: "Tailscale", enabled: false, requires: "Tailscale network" },
      { id: "ngrok", name: "ngrok", enabled: false, requires: "ngrok account" },
      { id: "cloudflare", name: "Cloudflare", enabled: false, requires: "cloudflared CLI" }
    ];
    renderPanel({
      providers: stale,
      selectedProvider: "cloudflare",
      status: "connected",
      url: "https://app.example"
    });
    // Disconnect, not a stale unavailable Connect.
    expect(screen.queryByRole("button", { name: "Disconnect Cloudflare" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Connect Cloudflare" })).toBeNull();
    // No "Requires …" caption on the live provider, despite enabled:false.
    expect(screen.queryByText(/Requires cloudflared CLI/)).toBeNull();
    // Its radio is selectable (not aria-disabled) — connected proves available.
    const cloudflare = row("Cloudflare");
    expect(cloudflare.getAttribute("aria-disabled")).toBeNull();
    expect(cloudflare.getAttribute("tabindex")).toBe("0");
    // A genuinely-unavailable OTHER provider still shows its requirement.
    expect(screen.queryByText(/Requires Tailscale network/)).not.toBeNull();
  });

  test("error: the message renders", () => {
    renderPanel({ status: "error", message: "Tunnel handshake failed" });
    expect(screen.queryByText("Tunnel handshake failed")).not.toBeNull();
  });

  test("the header Close button routes onClose", async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(handlers.onClose).toHaveBeenCalledTimes(1);
  });

  test("the footer Cancel button routes onClose", async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(handlers.onClose).toHaveBeenCalledTimes(1);
  });

  test("the footer Save button routes onClose when idle", async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(handlers.onClose).toHaveBeenCalledTimes(1);
  });

  test("an unavailable row's Connect lives OUTSIDE the aria-disabled radio so it stays interactive", () => {
    renderPanel();
    const connect = screen.getByRole("button", { name: "Connect Tailscale" });
    // AT and real pointer semantics treat descendants of a disabled widget as
    // inert — the whole point of this Connect is to work on unavailable rows.
    expect(connect.closest('[aria-disabled="true"]')).toBeNull();
  });

  test("there is no info toggle and no aggregate-guide footer — Connect is the only affordance", () => {
    renderPanel();
    expect(screen.queryByRole("button", { name: /setup instructions/ })).toBeNull();
    expect(screen.queryByText(/Unavailable providers show an/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Remote Access" })).toBeNull();
  });
});
