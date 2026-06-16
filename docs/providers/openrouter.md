# OpenRouter

OpenRouter is an OpenAI-compatible API-key provider that routes a single key to
hundreds of models from many vendors. Gini talks to
`https://openrouter.ai/api/v1` and authenticates with a Bearer key.

## Step 1 — Get an API key

1. Sign in at [openrouter.ai](https://openrouter.ai/).
2. Create a key on the [keys page](https://openrouter.ai/keys) and copy it.
3. Add credit (OpenRouter is pay-as-you-go and bills per model). Some models have
   free tiers — see the [models catalog](https://openrouter.ai/models).

See the [OpenRouter quickstart](https://openrouter.ai/docs/quickstart) for the
full API reference.

## Step 2 — Set the key

Gini reads the key from the `OPENROUTER_API_KEY` environment variable. Set it in
your shell or in `~/.gini/secrets.env` for persistence:

```bash
# ~/.gini/secrets.env  (created mode 0600)
OPENROUTER_API_KEY=sk-or-...
```

The web Add Provider form writes this for you.

## Step 3 — Configure the provider in Gini

### CLI

```bash
gini provider set openrouter openrouter/auto
```

The default model `openrouter/auto` lets OpenRouter pick a model per request. To
pin one, pass its slug from the [models catalog](https://openrouter.ai/models).
The base URL defaults to `https://openrouter.ai/api/v1`; override it only for a
proxy with `--base-url`.

### Web

Open **Settings → Add provider → OpenRouter**, paste the key, and pick or type a
model slug.

## Re-authentication

OpenRouter is an API-key provider, so a credential failure surfaces OpenRouter's
own message and links to **Settings → Providers** to paste a new key. Rotate keys
on the [keys page](https://openrouter.ai/keys). See ADR
[provider-reauth-guidance.md](../adr/provider-reauth-guidance.md).
