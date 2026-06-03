# ADR: In-App Doc References Render Inline

- **Status:** Accepted
- **Date:** 2026-06-02
- **See also:** [Provider Re-Authentication Guidance](provider-reauth-guidance.md), [ChatBlock Protocol](chat-block-protocol.md)

## Decision

When the app references a specific piece of hosted documentation
(`https://gini.lilaclabs.ai/docs/<path>#<anchor>`), it renders that doc section
**inline** in a slide-over instead of opening a new browser tab, with an **Open
full docs ↗** link to the full page as the escape hatch. The mechanism is
reusable for any "see this doc" reference, not special-cased to provider re-auth.

Three decisions make it reusable:

- **The gateway serves the content.** The repo's `docs/` tree is the source of
  the hosted site, and the gateway runs from the checkout, so it serves `docs/`
  directly via `GET /api/docs/<path>?section=<slug>` rather than scraping the
  external site. This stays in sync with the running version, needs no network to
  the hosted site, and a future mobile client reuses the same endpoint. The route
  reads only `.md` confined under `docsRoot()` and is covered by the bearer gate;
  section extraction and the GitHub-style heading slug live on the gateway so
  there is one implementation.

- **The runtime still owns the URL.** `reauthUrl`, the connector `docsUrl`, and
  every persisted chat-block shape keep carrying the full hosted URL. The client
  derives the relative gateway path (everything after `/docs/`) from that URL —
  so there are no runtime, type, or serialization changes and old persisted notes
  keep working.

- **One reusable component.** `<DocReference url={hostedUrl}>` wraps any trigger,
  fetches the section lazily on open, and renders it with the existing
  `MarkdownContent` renderer; a non-`/docs/` URL falls back to a plain external
  link so a reference can never break.

## Consequences

- A new app-referenced doc needs only a hosted URL and a `<DocReference>` wrapper
  — no new endpoint, no contract change, no per-consumer component.
- A stale `#anchor` degrades to the whole doc inline rather than erroring.
- Arbitrary links inside assistant chat text are out of scope and keep opening in
  a new tab; the current consumers are the codex re-auth CTA and the connector
  **Learn more** link.

## Related

- [Provider Re-Authentication Guidance](provider-reauth-guidance.md)
- [ChatBlock Protocol](chat-block-protocol.md)
- [Connector-Backed Web Search](web-search-connectors.md)
