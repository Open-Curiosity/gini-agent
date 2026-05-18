---
name: google-workspace-setup
description: "One-time setup for gws: install, OAuth, scopes, auto-approve."
license: MIT
compatibility: "macOS and Linux. Requires Node.js 18+ (or a prebuilt `gws` binary) and a Google Cloud project for OAuth credentials."
metadata:
  gini:
    version: 1.0.0
    author: Gini
    platforms: [macos, linux]
    prerequisites:
      commands: [gws]
---

# Google Workspace Setup

One-time onboarding for the Google Workspace skills (`google-gmail`, `google-calendar`, `google-drive`, `google-docs`, `google-meet`, `google-forms`). All of them invoke the upstream `gws` CLI from `github.com/googleworkspace/cli`, which speaks every Workspace API. This skill walks the user through installing the binary, completing OAuth once, picking scopes per product, and adding `gws` to the per-instance auto-approve list so subsequent calls don't pop an approval prompt every time.

Run this skill the first time any Workspace skill is invoked. It is idempotent — re-running it just re-verifies the install and lets the user widen scopes.

## Prerequisites

- A Google account (personal `@gmail.com` or a Workspace tenant).
- A Google Cloud project for OAuth credentials. `gws auth setup` can create one if `gcloud` is installed; otherwise see the manual flow below.
- Node.js 18+ on `$PATH` if installing via npm. Homebrew and prebuilt-binary installs do not need Node.

## When to Use

- A user asks Gini to read mail, send a calendar invite, share a Drive file, etc., and `gws` is not installed or not authenticated.
- The user wants to widen scopes (e.g. moved from read-only Gmail to send).
- The user wants to stop seeing approval prompts on every `gws` invocation.

## When NOT to Use

- The user already ran setup and the smoke check passes — go straight to the product skill.
- The user wants to manage non-Google services (Slack, Notion, etc.) — those have their own skills.
- The agent only needs ephemeral, agent-internal state — use the `memory` tool instead of any Google product.

## Quick Reference

### 1. Install the `gws` binary

Pick one of these in order of preference:

```bash
# Homebrew (macOS/Linux)
brew install googleworkspace-cli

# npm (cross-platform, needs Node.js 18+)
npm install -g @googleworkspace/cli

# Prebuilt binary
# Download from https://github.com/googleworkspace/cli/releases
# and place the extracted `gws` binary on $PATH

# Build from source
cargo install --git https://github.com/googleworkspace/cli --locked
```

Verify with:

```bash
gws --version
```

### 2. Run OAuth

The fast path requires the `gcloud` CLI; it provisions the Cloud project, enables APIs, and walks the consent screen:

```bash
gws auth setup          # one-time bootstrap (needs gcloud)
gws auth login          # interactive scope pick + browser consent
```

If `gcloud` is not available, fall back to the manual flow:

1. Open the Google Cloud Console for the target project, configure the OAuth consent screen as **External** (testing mode is fine), and add the user as a **Test user**.
2. Create an OAuth client of type **Desktop app**, download the client JSON, and save it to `~/.config/gws/client_secret.json`.
3. Run `gws auth login` and complete the browser flow.

### 3. Pick the right scopes per product

Unverified OAuth apps in testing mode are capped at roughly 25 scopes by Google, and the default "recommended" preset is 85+ scopes — it will fail for `@gmail.com` accounts. There are two ways to narrow the list at login time:

```bash
# Pick services by short name (full read-write across each)
gws auth login -s drive,gmail,calendar,docs,meet,forms

# Same services, but read-only everywhere — the --readonly flag applies
# uniformly to every service listed in -s
gws auth login --readonly -s gmail,drive

# Exact per-scope picks (full URLs, no shortcuts) — use this when you
# need a mixed shape that -s/--readonly can't express, e.g. read-only
# Gmail + full Drive in the same login
gws auth login --scopes "https://www.googleapis.com/auth/gmail.readonly,https://www.googleapis.com/auth/drive"
```

`-s` takes **service names**, not scope strings — `-s gmail.readonly` is silently dropped because no service named `gmail.readonly` exists. Pair `-s` with `--readonly` for read-only across the listed services, or fall through to `--scopes` with explicit URLs for fine-grained mixes.

Recommended starting scopes per product. The first column is the `-s` shorthand (Service column from `gws auth login --help`); the second column is the full URL to pass to `--scopes` when picking a non-uniform mix:

- **Gmail** — `-s gmail` ↔ `https://www.googleapis.com/auth/gmail` (or `.readonly` / `.send` / `.modify` URLs for narrower picks).
- **Drive** — `-s drive` ↔ `https://www.googleapis.com/auth/drive` (`.file`, `.readonly`, `.metadata.readonly` available as full URLs).
- **Calendar** — `-s calendar` ↔ `https://www.googleapis.com/auth/calendar` (`.events`, `.readonly`, `.freebusy` available as full URLs).
- **Docs** — `-s docs` ↔ `https://www.googleapis.com/auth/documents` (`.readonly` available as a full URL when the agent only needs to read).
- **Meet** — `-s meet` ↔ `https://www.googleapis.com/auth/meetings.space.created` (`.readonly` available as a full URL).
- **Forms** — `-s forms` ↔ `https://www.googleapis.com/auth/forms.body` (`.body.readonly`, `.responses.readonly` available as full URLs).

### 4. Add `gws` to autoApproveCommands

Every `gws` call goes through Gini's approval-gated `terminal_exec` tool. To stop the prompt firing on every invocation, add a glob to the per-instance config at `~/.gini/instances/<instance>/config.json`:

```json
{
  "autoApproveCommands": ["gws *"]
}
```

For finer-grained gating, list each product the user has agreed to auto-approve:

```json
{
  "autoApproveCommands": [
    "gws gmail *",
    "gws calendar *",
    "gws drive *",
    "gws docs *"
  ]
}
```

You can also patch this at runtime without restarting:

```bash
curl -X PATCH http://localhost:<port>/api/settings/auto-approve \
  -H 'content-type: application/json' \
  -d '{"patterns":["gws *"]}'
```

Auto-approved commands still leave a `terminal.exec` audit row with `evidence.autoApproved=true`, so the activity trail stays intact.

### 5. Smoke-test

A read-only call that returns quickly and exercises auth:

```bash
gws drive files list --params '{"pageSize": 1}'
```

If that returns JSON without an auth error, the setup is complete and the per-product skills are ready to use.

## Rules

1. Walk this skill end-to-end before invoking any other `google-*` skill the first time. Subsequent runs of those skills assume `gws` is installed, authenticated, and auto-approved.
2. Narrow OAuth scopes to what the user actually asked for. Do not silently expand from read-only to write.
3. When the user is on a personal `@gmail.com` account, never request the full `recommended` scope preset — it will fail because the app is unverified. Use a comma-separated `-s` list.
4. Encourage `gws *` in `autoApproveCommands` only after the user understands every `gws` call still produces an audit row.
5. Treat the entire `~/.config/gws/` directory as sensitive — never `cat` or copy its contents into chat or logs. The post-OAuth authorized-user credentials are AES-256-GCM encrypted at rest, with the symmetric key held in the OS keyring (macOS Keychain / Linux Secret Service) or, as a fallback when no keyring is available, written plaintext to a local `.encryption_key` file in that directory. The OAuth client config (`client_secret.json`) is stored as plaintext alongside it. Both artifacts are sensitive: the client secret identifies the app and the encrypted blob (plus its key file) is enough to act as the user.
6. If the user is in a CI or headless environment, point them at the export flow (`gws auth export --unmasked > credentials.json` on a desktop machine, then `GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=…` on the headless one).

For flags not shown here, run `gws auth --help` and `gws --help`.
