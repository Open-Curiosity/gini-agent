# Anthropic (first-party Claude API)

This is the **first-party** Anthropic Claude API — the `sk-ant…` key sent in an
`x-api-key` header against `https://api.anthropic.com`. If you want Claude
through AWS instead, that is the separate [Amazon Bedrock](bedrock.md) provider
(no API key, AWS-signed).

## Step 1 — Get an API key

1. Sign in at the [Anthropic Console](https://console.anthropic.com/).
2. Go to **Settings → API Keys → Create Key**, name it, and copy the `sk-ant…`
   value (shown once).
3. Add credit under **Billing**; the API is pay-as-you-go and separate from a
   Claude.ai subscription.

See the [Claude API get-started guide](https://platform.claude.com/docs/en/get-started).

## Step 2 — Set the key

Gini reads the key from the `ANTHROPIC_API_KEY` environment variable. Set it in
your shell or in `~/.gini/secrets.env` for persistence:

```bash
# ~/.gini/secrets.env  (created mode 0600)
ANTHROPIC_API_KEY=sk-ant-...
```

The web Add Provider form writes this for you.

## Step 3 — Configure the provider in Gini

### CLI

```bash
gini provider set anthropic claude-opus-4-8
```

Available models include `claude-opus-4-8`, `claude-opus-4-7`,
`claude-sonnet-4-6`, and `claude-haiku-4-5`. The base URL defaults to
`https://api.anthropic.com`; if you override it with `--base-url`, it must be
`https://` (the API key is sent on every request), except for a localhost proxy.

### Web

Open **Settings → Add provider → Anthropic**, paste the key, pick a model, and
optionally set a base URL.

## Re-authentication

Anthropic is an API-key provider, so a credential failure surfaces Anthropic's
own message and links to **Settings → Providers** to paste a new key. Rotate keys
in the [Anthropic Console](https://console.anthropic.com/). See ADR
[provider-reauth-guidance.md](../adr/provider-reauth-guidance.md).
