---
name: google-workspace-setup
description: "One-time setup for gws: install, OAuth, scopes, auto-approve."
license: MIT
compatibility: "macOS and Linux. Requires Homebrew (or another package manager) and a Google account."
metadata:
  gini:
    version: 3.2.0
    author: Gini
    platforms: [macos, linux]
    prerequisites:
      commands: [gws]
---

# Google Workspace Setup

One-time onboarding for the Google Workspace skills (`google-gmail`, `google-calendar`, `google-drive`, `google-docs`, `google-meet`, `google-forms`). Installs `gws` and `gcloud`, signs the user into their own Google Cloud project, enables the Workspace APIs, captures an OAuth Desktop client through the inline Connect form, and completes `gws auth login`.

The OAuth client lives in the user's own GCP project. The Client ID and Client Secret are captured through the inline Connect form (`request_connector` tool) and stored in Gini's encrypted secret store — never write them to chat or logs, and never write `client_secret.json` to disk.

This skill is idempotent — re-running it re-verifies the install and lets the user widen scopes.

## The Flow

This is the **exact sequence** the user wants. Do not branch into shortcuts, do not pre-ask whether they have an existing OAuth client, do not list completed actions retrospectively. Status messages are action-oriented: what the user must do *next*.

1. The user asks Gini to do a Workspace thing (read mail, check calendar, share a Drive file, etc.).
2. Confirm setup with the user.
3. Install `gws` and `gcloud` silently in the background.
4. Run `gcloud auth login`, which pops up the user's default browser for sign-in.
5. After they sign in, create the Cloud project and enable the six Workspace APIs in the background.
6. Send a single chat bubble with the last-step instructions (two Cloud Console URLs) and call `request_connector` — the inline form renders below the bubble.
7. After the user pastes the credentials and clicks **Save**, run `gws auth login`, which pops up the user's default browser for OAuth consent.
8. After they sign in, the original ask resumes.

## Step 1 — Confirm setup

Tell the user, in one short sentence, that Google Workspace isn't set up yet, and ask whether to set it up now. Wait for confirmation before doing anything.

If they say yes, proceed silently — do not narrate each substep. The user sees a chat bubble per **milestone** (sign in, last step), not per command.

## Step 2 — Install `gws` and `gcloud`

Both installs are silent and run through `terminal_exec`. If a binary is already on `$PATH`, skip its install.

Detect first:

```bash
command -v gws
command -v gcloud
```

Install whichever is missing:

```bash
# gws (macOS / Linux)
brew install googleworkspace-cli

# gcloud (macOS)
brew install --cask google-cloud-sdk

# gcloud (Linux) — see https://docs.cloud.google.com/sdk/docs/install for the
# tarball install. Use the platform-appropriate command via terminal_exec.
```

Verify both are on `$PATH` afterwards:

```bash
gws --version
gcloud --version
```

If either install fails (network, sudo, broken Homebrew), STOP and tell the user verbatim what failed and the one-line command to try manually. Do not loop.

## Step 3 — Sign in with `gcloud`

```bash
gcloud auth login
```

This opens the user's **default browser** to Google's OAuth consent page. They sign in there. The command returns when the user completes consent.

If `gcloud auth list` already shows an active account, ask once: "gcloud is signed in as `<email>`. Use this account?" — proceed on confirmation. Otherwise run `gcloud auth login` straight through.

## Step 4 — Create the Cloud project and enable APIs

Both substeps are silent. The user does not need to click anything in a browser for this step.

Create (or reuse) a project. Default name is `gini-workspace`; append a suffix like the user's initials if the global ID is taken:

```bash
gcloud projects create gini-workspace --name="Gini Workspace"
gcloud config set project gini-workspace
```

If `gini-workspace` returns `ALREADY_EXISTS`, try `gini-workspace-<initials>` or ask the user briefly.

Enable all six Workspace APIs in one call (already-enabled APIs are no-ops):

```bash
gcloud services enable \
  gmail.googleapis.com \
  calendar-json.googleapis.com \
  drive.googleapis.com \
  docs.googleapis.com \
  forms.googleapis.com \
  meet.googleapis.com
```

Calendar's service ID is `calendar-json.googleapis.com` (not `calendar.googleapis.com`).

On `PERMISSION_DENIED`, surface the error verbatim and ask the user to pick a project they own with `gcloud config set project <project_id>`.

## Step 5 — Last step: capture OAuth Desktop credentials

This is the only step that requires the user to click in a browser. Send **one** chat bubble with the two Cloud Console URLs and call `request_connector` immediately after. The inline form renders below the bubble; the user pastes the Client ID and Client Secret and clicks **Save**.

Construct the `reason` string as multi-line markdown with the URLs and click instructions. **Substitute `<PROJECT_ID>` with the actual project id from Step 4** — there is no runtime substitution.

Use this exact format:

```text
**Last step.** Complete the two Cloud Console pages below, then paste the credentials.

**Step 1 — OAuth consent screen** (skip if already configured)

https://console.cloud.google.com/apis/credentials/consent?project=<PROJECT_ID>

- User Type: **External**
- App name: **Gini Workspace**
- Your email for support contact and developer contact
- Save through Scopes (no scopes to add)
- Add yourself as a **Test user**

**Step 2 — Create an OAuth client**

https://console.cloud.google.com/apis/credentials?project=<PROJECT_ID>

- Click **Create Credentials → OAuth client ID**
- Application type: **Desktop app**
- Name it whatever (e.g. "Gini")
- Click **Create**

Then paste the **Client ID** and **Client Secret** below.
```

Then call:

```text
request_connector {
  provider: "google-oauth-desktop",
  reason: "<the constructed markdown string above, with <PROJECT_ID> filled in>"
}
```

Do NOT post a separate chat message before the tool call. Do NOT `open <url>` for either Console URL — let the user click from the bubble. Don't gate on "reply done" between the two pages — the form submission is what advances the flow.

On Save, the connector is created with env bindings (`GOOGLE_WORKSPACE_CLI_CLIENT_ID`, `GOOGLE_WORKSPACE_CLI_CLIENT_SECRET`), and the chat-task resumes at Step 6.

## Step 6 — Run `gws auth login`

```bash
gws auth login -s drive,gmail,calendar,docs,meet,forms
```

`gws` reads the Client ID and Client Secret from the env vars Gini binds, opens the user's **default browser** for OAuth consent, and prompts them to pick scopes. The `-s` list picks default scopes for each service (read + write but not permanent delete or admin).

If `gws auth login` exits with an OAuth client error, the Client ID or Client Secret entered in Step 5 was wrong — re-run `request_connector` for `google-oauth-desktop` to capture the correct pair.

### Picking scopes if the user wants narrower

```bash
# Read-only across listed services
gws auth login --readonly -s gmail,drive

# Exact per-scope picks (full URLs)
gws auth login --scopes "https://www.googleapis.com/auth/gmail.readonly,https://www.googleapis.com/auth/drive"
```

`-s` takes **service names**, not scope strings — `-s gmail.readonly` is silently dropped.

Recommended starting scopes per product (first column = `-s` shorthand; second column = full URL for `--scopes`):

- **Gmail** — `-s gmail` ↔ `https://www.googleapis.com/auth/gmail.modify` (read + send + reply + label + draft; NOT permanent delete). Narrower: `.readonly` / `.send` / `.compose`.
- **Gmail (full, incl. permanent delete)** — `--scopes "https://mail.google.com/"`. No `-s` shorthand.
- **Drive** — `-s drive` ↔ `https://www.googleapis.com/auth/drive` (`.file`, `.readonly`, `.metadata.readonly` available as full URLs).
- **Calendar** — `-s calendar` ↔ `https://www.googleapis.com/auth/calendar` (`.events`, `.readonly`, `.freebusy` available as full URLs).
- **Docs** — `-s docs` ↔ `https://www.googleapis.com/auth/documents` (`.readonly` available).
- **Meet** — `-s meet` ↔ `https://www.googleapis.com/auth/meetings.space.created` (`.readonly` available).
- **Forms** — `-s forms` ↔ `https://www.googleapis.com/auth/forms.body` (`.body.readonly`, `.responses.readonly` available).

If the user is on a personal `@gmail.com` account, the default `recommended` preset will fail because the app is unverified. Always use a comma-separated `-s` list.

## Step 7 — Stop the per-call approval prompt (optional)

Every `gws` call goes through Gini's approval-gated `terminal_exec` tool. To stop the prompt firing on every invocation, patch the per-instance auto-approve list:

```bash
curl -X PATCH -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"patterns": ["gws *"]}' \
  http://127.0.0.1:<port>/api/settings/auto-approve
```

Set `$TOKEN` from `~/.gini/instances/<instance>/config.json` (the `apiToken` field).

For finer-grained gating, list each product:

```json
{ "patterns": ["gws gmail *", "gws calendar *", "gws drive *", "gws docs *"] }
```

## Step 8 — Smoke test

A read-only call that exercises auth:

```bash
gws drive files list --params '{"pageSize": 1}'
```

If that returns JSON without an auth error, the setup is complete. Resume the user's original ask (read mail, list calendar events, etc.).

## Rules

1. Walk this skill end-to-end the first time. Do not skip to `request_connector` or `gws auth login` without the install + project + APIs in place.
2. **Sign-in is a human-in-the-loop step.** Never attempt to type the user's email or password. `gcloud auth login` and `gws auth login` both open the default browser — wait for the command to return.
3. **Capture credentials through the inline form, not files.** Always use `request_connector { provider: "google-oauth-desktop" }`. Never ask the user for a path to `client_secret.json`, never write a JSON file under `~/.config/gws/`, and never `cat` or echo the credentials back into chat.
4. **Enable all six Workspace APIs in Step 4 regardless of which product triggered setup.** One `gcloud services enable` call covers them all; this lets the user pivot to another product later without re-running setup.
5. **Status messages are action-oriented and ungrouped.** Do not list "Installed gws, installed gcloud, signed in, created project, enabled APIs." The user sees a chat bubble per milestone (confirm setup, last-step form, done) — not a retrospective changelog.
6. **Fail gracefully.** If `gcloud` errors with `PERMISSION_DENIED` or `ALREADY_EXISTS`, surface the error verbatim and ask the user. If an install fails, STOP — do not retry in a loop, hand off to the user with the one-line manual command.
7. Narrow OAuth scopes to what the user actually asked for. Do not silently expand from read-only to write.
8. If the user is in a CI or headless environment, point them at the export flow (`gws auth export --unmasked > credentials.json` on a desktop machine, then `GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=…` on the headless one).

## Manual Fallback

If `gcloud` cannot be installed at all (uncommon — Homebrew is the standard path on macOS, and Linux has a documented tarball install), hand off the Cloud Console flow to the user manually:

1. Tell them to open https://console.cloud.google.com/ and create a project named `gini-workspace`.
2. Enable the six APIs at https://console.cloud.google.com/apis/library — Gmail, Calendar, Drive, Docs, Forms, Meet.
3. Then resume from Step 5 (configure OAuth consent, create Desktop OAuth client, paste credentials into the inline form).

For flags not shown here, run `gws auth --help` and `gws --help`.
