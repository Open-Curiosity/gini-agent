# OpenAI

OpenAI is an API-key provider. Gini talks to `https://api.openai.com/v1` and
authenticates with a Bearer key.

> Looking for the ChatGPT/Codex sign-in instead of an API key? That is the
> separate [Codex](codex.md) provider, which reuses your `codex login` OAuth and
> stores no key.

## Step 1 — Get an API key

1. Sign in at the [OpenAI platform](https://platform.openai.com/).
2. Open the [API keys page](https://platform.openai.com/api-keys) and choose
   **Create new secret key**. Copy it — the full secret is shown only once.
3. Add a payment method under [Billing](https://platform.openai.com/account/billing/overview);
   API usage is billed pay-as-you-go and is separate from a ChatGPT subscription.

See the [OpenAI developer quickstart](https://platform.openai.com/docs/quickstart).

## Step 2 — Set the key

Gini reads the key from the `OPENAI_API_KEY` environment variable. Set it in your
shell or in `~/.gini/secrets.env` for persistence:

```bash
# ~/.gini/secrets.env  (created mode 0600)
OPENAI_API_KEY=sk-...
```

`gini setup` and the web Add Provider form both write this for you.

## Step 3 — Configure the provider in Gini

### CLI

```bash
gini provider set openai gpt-5.4-mini
```

The base URL defaults to `https://api.openai.com/v1`; override it only for a
compatible proxy with `--base-url`.

### Web

Open **Settings → Add provider → OpenAI**, paste the key, and pick a model.
(`gini setup`'s interactive picker also configures OpenAI, like every provider.)

## Re-authentication

OpenAI is an API-key provider, so a credential failure surfaces OpenAI's own
message (bad key, exhausted quota, disabled key) and links to **Settings →
Providers** to paste a new key. Rotate keys on the
[API keys page](https://platform.openai.com/api-keys). See ADR
[provider-reauth-guidance.md](../adr/provider-reauth-guidance.md).
