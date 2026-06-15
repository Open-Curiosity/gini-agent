# DeepSeek

DeepSeek is an OpenAI-compatible API-key provider. Gini talks to
`https://api.deepseek.com` and authenticates with a Bearer key.

## Step 1 — Get an API key

1. Sign in at the [DeepSeek platform](https://platform.deepseek.com/).
2. Open the [API keys page](https://platform.deepseek.com/api_keys) and create a
   new key. Copy it (it is shown once).
3. DeepSeek billing is pay-as-you-go; add credit under the platform's billing
   section so the key is active.

See the [DeepSeek API docs](https://api-docs.deepseek.com/) for the current model
list and pricing.

## Step 2 — Set the key

Gini reads the key from the `DEEPSEEK_API_KEY` environment variable. Set it in
your shell or, for persistence across gateway restarts, in `~/.gini/secrets.env`:

```bash
# ~/.gini/secrets.env  (created mode 0600)
DEEPSEEK_API_KEY=sk-...
```

The web Add Provider form writes this for you.

## Step 3 — Configure the provider in Gini

### CLI

```bash
gini provider set deepseek deepseek-v4-flash
```

Available models include `deepseek-v4-flash` and `deepseek-v4-pro`. (The older
`deepseek-chat` and `deepseek-reasoner` names are scheduled for deprecation by
DeepSeek — prefer the `v4` ids.) The base URL defaults to
`https://api.deepseek.com`; override it only for a proxy with `--base-url`.

### Web

Open **Settings → Add provider → DeepSeek**, paste the key, and pick a model.

## Re-authentication

DeepSeek is an API-key provider, so when a chat turn fails on a credential error
Gini shows DeepSeek's own message (bad key, exhausted quota, etc.) and links to
**Settings → Providers** to paste a new key. Rotate keys on the
[DeepSeek API keys page](https://platform.deepseek.com/api_keys). See ADR
[provider-reauth-guidance.md](../adr/provider-reauth-guidance.md).
