---
name: yc-cli
description: "Interact with Y Combinator's Bookface from the terminal via the `yc` CLI: authenticate, look up the current user, and search the YC network (companies, founders, investors, deals, jobs, forum posts, and more). Run YC agent tools directly and read YC playbooks. Use when the user asks about YC, Bookface, an investor/fund/company/founder lookup, YC deals, or the `yc` command."
license: MIT
compatibility: "macOS and Linux. Requires the `yc` CLI; this skill installs it if missing. Authentication is browser-based OAuth."
allowed-tools: "terminal_exec browser_connect browser_navigate read_skill"
metadata:
  gini:
    version: 1.0.0
    author: Gini
    platforms: [macos, linux]
    prerequisites:
      commands: [yc]
---

# YC CLI (`yc`)

`yc` is the Y Combinator CLI. It talks to **Bookface** — YC's internal founder
platform — over an authenticated API, so a YC community member can search the YC
network, run the YC agent's tools, and read YC playbooks from the terminal.

The body below is loaded on demand; check `yc --help` and `yc <command> --help`
for the authoritative, current syntax before relying on exact flags — the CLI
evolves and this skill should not drift from the installed version.

## When to use

- The user asks about YC, Bookface, or the `yc` command.
- Looking up an investor / fund, a YC company, a founder, a YC deal, a job, or a forum post.
- Asking the YC agent a question, or loading a YC playbook (`yc skills read <name>`).

## When NOT to use

- General web search unrelated to the YC network → use `web_search`.
- The user is not a YC community member / has no `yc` account — `yc` requires YC auth and will not return data.

## Prerequisites

`yc` must be installed and on `PATH`.

- **Install (if missing):** `curl -fsSL https://bookface.ycombinator.com/cli/install.sh | bash`
- The installer drops the binary under the user's home (commonly `~/.yc/bin/yc`,
  sometimes `~/.local/bin/yc`) and adds it to `PATH`. A non-interactive shell
  (e.g. `terminal_exec`) may not have that on `PATH` yet, so prefer a robust
  invocation:

  ```bash
  export PATH="$HOME/.yc/bin:$HOME/.local/bin:$PATH"
  ```

- If an existing `yc` command was detected at install time, the CLI may be
  installed as **`ycp`** instead — fall back to `ycp` if `yc` is absent.
- Verify: `yc --version`.

## Authentication

Auth is OAuth-based; the token is cached in `~/.yc/credentials.json` and
refreshes automatically. Always check state first and only log in when needed —
re-running login on an already-authenticated session rewrites credentials for
nothing.

```bash
yc me            # prints the signed-in user, or reports "Not logged in"
```

If not logged in, pick the login mode that fits where the agent is running:

- **Local machine the user is sitting at:** `yc login` — opens a browser on this
  machine for OAuth.
- **Remote / headless machine the user reaches through Gini (the common case for
  an agent):** `yc login --device` — prints a verification URL and short code so
  the user authenticates on their own device; nothing needs a browser on the box.
  Surface both the URL and the code to the user and wait for them to finish
  before continuing.
- **No browser/device flow available:** `yc login --manual` — prints the auth URL
  and accepts the redirect URL pasted back.

When a browser sign-in is required and the agent has browser tools, drive it the
way Gini drives any auth wall: open the URL and hand off with `browser_connect`
so the user signs in through a live view of the agent's browser. The agent never
sees the password.

```bash
yc logout        # clears stored credentials from ~/.yc
```

## Core commands

```bash
yc me                              # current user / auth check         | --json
yc search "<query>" --type <type>  # search Bookface                   | --json
yc agent "<question>"              # ask the YC agent (streams output) | --json
yc tools list                      # list YC agent tools               | --json
yc tools describe <name>           # show a tool's JSON schema          | --json
yc tools run <name> --input '<json>'   # run a YC agent tool directly  | --json
yc skills list                     # list YC playbooks                  | --json
yc skills read <name>              # print a YC playbook's content
```

`--json` is supported on the read commands above. Prefer it whenever you are
going to parse or summarize the result — the default human output (plain text
for `me`, CSV-with-markdown-links for `search`) is for a terminal, not a stable
parse target.

## Search

`yc search` covers many entity types via `--type` (companies, founders,
investors, deals, meetups, forum, jobs, launches, and more — see
`yc tools describe search` for the full list and each type's filters).

```bash
yc search "developer tools" --type companies
yc search "fintech seed" --type investors --json
```

The structured form goes through the agent's `search` tool and returns a JSON
envelope with `total_count`, `available_filters`, and `available_extra_fields`:

```bash
yc tools run search --input '{"entity":"investors","query":"<fund>","limit":3}'
```

Useful conventions:

- **Use a small `limit`.** Some entities (notably `investors`) embed large nested
  payloads — a fund record carries its full partner roster and investment
  history — so an unbounded query is slow and noisy. Start with `limit: 3` and
  page up only if needed.
- **Request the fields you need with `extra_fields`.** The base result is lean;
  detail fields are opt-in. For an investor, fields like
  `average_series_a_check_size`, `n_investments`, `rating`, and `description`
  only come back when named in `extra_fields`. Probe with `limit: 0` first to
  read `available_extra_fields` for that entity.
- **Batch values use short names** (`W25`, `S26`), not long form (`w2025`).
  Filter values must match exactly ("Harvard" ≠ "Harvard University").

## Running YC agent tools and playbooks

The YC agent exposes named tools (search, deals, company/profile lookups, and
more). `yc tools list` enumerates them; `yc tools describe <name>` shows the
JSON-Schema arguments; `yc tools run <name> --input '<json>'` invokes one.
Dotted names select an action — `tool:search.companies` means run `search` with
`entity: "companies"`. `yc tools context` prints the current user's role and
guidance. `yc skills read <name>` loads a YC playbook (e.g. fundraising,
pricing, sales advice) on demand.

## Rules

1. Check `yc me` before assuming auth; only run `yc login` when it reports "Not logged in", and prefer `--device` on any machine the user reaches remotely.
2. If `yc` is not on `PATH`, set `PATH` to include `~/.yc/bin` and `~/.local/bin`, fall back to `ycp`, and only run the install script if the binary is genuinely absent.
3. Never expose the user's password or token — login is browser/device-based and the token stays in `~/.yc`; the agent never handles the credential.
4. Prefer `--json` for anything you will parse; use a small `limit` and request `extra_fields` explicitly on heavy entities like investors.
5. Don't refuse a YC-network ask without checking — confirm syntax with `yc <command> --help` or `yc tools describe <name>` before concluding something isn't supported.
