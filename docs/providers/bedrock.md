# Amazon Bedrock

Bedrock stores no API key. Gini signs every [Converse API](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-messages-api.html)
request with **AWS SigV4** using the credentials it finds on your machine at call
time; `config.json` holds only the model id and an optional region. Because
Converse is model-agnostic, this one provider reaches every Bedrock family —
Claude, Amazon Nova, Meta Llama, Mistral, DeepSeek — through the same transport.
See ADR [bedrock-converse-provider.md](../adr/bedrock-converse-provider.md) for
the wire-level design.

## Where Gini looks for credentials

Gini resolves AWS credentials in this order on each chat turn:

1. The `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` environment variables (plus
   `AWS_SESSION_TOKEN` when you are using a temporary session).
2. The `[default]` profile in your `~/.aws/credentials` file.

That is the whole list. Gini uses **static credentials only**. It does **not**
read IAM Identity Center (SSO) session caches, `~/.aws/config` role chains,
`credential_process` entries, or EC2/container instance roles. This is the most
common source of "I logged in but Gini still says no credentials" — see
[I signed in but Gini sees no credentials](#i-signed-in-but-gini-sees-no-credentials)
below.

## Step 1 — Install the AWS CLI (recommended)

The CLI is the easiest way to create and manage the credentials file. (You can
skip it if you already have keys to export as environment variables.) Install
AWS CLI v2:

- **All platforms:** [Installing or updating to the latest version of the AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)
- **macOS (GUI installer):** download and run [`https://awscli.amazonaws.com/AWSCLIV2.pkg`](https://awscli.amazonaws.com/AWSCLIV2.pkg)
- **Linux (x86-64):**

  ```bash
  curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"
  unzip awscliv2.zip
  sudo ./aws/install
  ```

Confirm it works:

```bash
aws --version
# aws-cli/2.27.41 Python/3.11.6 ...
```

## Step 2 — Get credentials

Pick whichever path matches your AWS account. The goal is the same in every
case: end up with a valid `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` (and, if
temporary, `AWS_SESSION_TOKEN`) that Gini can read.

### Path A — Long-term IAM access keys (simplest, stays logged in)

Long-term keys do not expire, so you set them once and never sign in again.

1. Sign in to the [IAM console](https://console.aws.amazon.com/iam/) as your IAM
   user (not the account root user — [AWS recommends against root keys](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_access-keys.html)).
2. Go to **Users → your user → Security credentials → Access keys → Create
   access key**. Choose "Command Line Interface (CLI)" as the use case.
3. Copy both the **Access key ID** (starts with `AKIA…`) and the **Secret access
   key**. The secret is shown only once.
4. Write them to `~/.aws/credentials` with the CLI:

   ```bash
   aws configure
   # AWS Access Key ID [None]: AKIA...
   # AWS Secret Access Key [None]: ...
   # Default region name [None]: us-east-1
   # Default output format [None]: json
   ```

This writes the key to `~/.aws/credentials` — the file Gini reads. See
[Configuration and credential file settings](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-files.html).

### Path B — IAM Identity Center / SSO (logged in, but no credentials file)

If your organization uses AWS IAM Identity Center, you sign in with
`aws configure sso` and refresh with `aws sso login`. Per the [AWS docs](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-files.html),
for this method **"the credentials file is not used"** — the session is cached
elsewhere and only `~/.aws/config` is written. Gini cannot read that, so you
must export the active session into environment variables that Gini *can* read:

```bash
aws sso login --profile my-sso-profile          # opens the browser, refreshes the session
eval "$(aws configure export-credentials --profile my-sso-profile --format env)"
```

`export-credentials --format env` prints the `AWS_*` variables as shell `export`
lines; `eval` loads them into the current shell. See the
[export-credentials reference](https://docs.aws.amazon.com/cli/latest/reference/configure/export-credentials.html).

These credentials are **temporary** — they expire with the SSO session (usually a
few hours). To survive a gateway restart, write them into Gini's secrets file
(see [Make credentials persist](#make-credentials-persist)); re-run the two
commands above to refresh when they lapse.

## Step 3 — Enable model access in Bedrock

Access to Bedrock models is [enabled by default](https://docs.aws.amazon.com/bedrock/latest/userguide/model-access.html)
in commercial AWS regions, given AWS Marketplace permissions
(`aws-marketplace:Subscribe`, `Unsubscribe`, `ViewSubscriptions`) and a valid
payment method on the account.

The one exception: **Anthropic (Claude) models require a one-time First Time Use
form**, submitted once per account or AWS Organization. Submit it by opening an
Anthropic model in the [Amazon Bedrock console](https://console.aws.amazon.com/bedrock/)
→ **Model access**. A first call may return `AccessDeniedException` for a minute
or two while the subscription finalizes — retry.

## Step 4 — Configure the provider in Gini

### CLI

```bash
gini provider set bedrock us.anthropic.claude-opus-4-8 --aws-region us-east-1
```

The model id is a Bedrock [cross-region inference-profile id](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles-support.html)
(for example `us.amazon.nova-pro-v1:0`, `us.meta.llama4-scout-17b-instruct-v1:0`).
`--aws-region` is optional; when omitted Gini resolves `AWS_REGION` /
`AWS_DEFAULT_REGION`, then falls back to `us-east-1`.

### Web

Open **Settings → Add provider → Amazon Bedrock**. There is no API-key field
(by design — the credentials live in `~/.aws`, not in Gini). Pick a model (or
enter a custom inference-profile id) and an optional region, then save.

## Make credentials persist

Variables exported in a shell don't outlive it. To give the gateway credentials
across restarts, add them to Gini's secrets file (sourced on launch):

```bash
# ~/.gini/secrets.env  (created mode 0600)
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=...
# AWS_SESSION_TOKEN=...   # only for temporary / SSO sessions
```

Long-term IAM keys (Path A) written here never expire. Temporary SSO keys
(Path B) must be refreshed when the session lapses. After editing the file,
restart the gateway (`gini stop` then `gini run`) so the new values are read.

## Troubleshooting

### I signed in but Gini sees no credentials

You almost certainly authenticated with **IAM Identity Center / SSO**
(`aws sso login` or `aws configure sso`). That flow does not write
`~/.aws/credentials`, and Gini does not read SSO session caches. Follow
[Path B](#path-b--iam-identity-center--sso-logged-in-but-no-credentials-file)
to export the session into environment variables, or use
[Path A](#path-a--long-term-iam-access-keys-simplest-stays-logged-in) for keys
that never expire.

Quick check — this prints your credentials only if they resolve to the static
form Gini uses:

```bash
aws configure export-credentials --format env
```

If that errors or prints nothing, Gini will see nothing either.

### Re-authentication

Bedrock has no API key to rotate, so when a chat turn fails with a credential
error, Gini's note points you at **Settings → Providers** with guidance to check
your AWS credentials rather than to a key form. To recover:

- **Long-term keys:** confirm `~/.aws/credentials` still holds a valid, active
  access key (a key can be disabled or deleted in the [IAM console](https://console.aws.amazon.com/iam/)).
- **Temporary / SSO keys:** the session expired — re-run `aws sso login` and
  re-export (Path B). Update `~/.gini/secrets.env` if you persisted them there,
  then restart the gateway.

See ADR [provider-reauth-guidance.md](../adr/provider-reauth-guidance.md) for how
Gini surfaces credential failures.
