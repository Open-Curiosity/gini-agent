# Azure OpenAI

Azure OpenAI is a first-class provider named `azure`. Unlike plain OpenAI, Azure
routes requests **per deployment** on **your** resource, so setup needs four
pieces of information: a resource endpoint, a deployment name, an API version,
and an auth scheme. See ADR [azure-provider.md](../adr/azure-provider.md) for the
routing contract.

Gini sends every chat call to:

```
https://<resource>.openai.azure.com/openai/deployments/<deployment>/chat/completions?api-version=<version>
```

## Step 1 — Create an Azure OpenAI resource

You need an Azure subscription with access to Azure OpenAI (in Microsoft
Foundry). In the [Azure portal](https://portal.azure.com/) create an **Azure
OpenAI** resource, or use the [Microsoft Foundry portal](https://ai.azure.com/).
Microsoft's walkthrough: [Create and deploy an Azure OpenAI resource](https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/create-resource).

After the resource is created, note its **endpoint**, which looks like
`https://<resource-name>.openai.azure.com`. You will also find its **keys**
under **Resource Management → Keys and Endpoint**.

## Step 2 — Create a deployment

A deployment is a named instance of a model on your resource. In the
[Microsoft Foundry portal](https://ai.azure.com/) open your resource, select
**Deploy model → Deploy base model**, pick a model (for example `gpt-4o`), and
give the deployment a name (the Step 1 guide covers this too).

The **deployment name** goes in Gini's `--deployment` flag. Name it after the
model it serves and you can omit `--deployment` — Gini defaults it to the model
id.

## Step 3 — Get the key (or an Entra token)

Azure OpenAI accepts two auth styles, and Gini supports both via
`--auth-scheme`:

- **`api-key`** (default) — a resource key from **Keys and Endpoint**. Gini
  sends it in Azure's `api-key:` header.
- **`bearer`** — a Microsoft Entra ID access token. Gini sends it as
  `Authorization: Bearer …`. Use this if your org disables resource keys and
  requires [Entra ID authentication](https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/managed-identity).

Gini reads the secret from the `AZURE_OPENAI_API_KEY` environment variable by
default. Set it in your shell or, for persistence across gateway restarts, in
`~/.gini/secrets.env`:

```bash
# ~/.gini/secrets.env  (created mode 0600)
AZURE_OPENAI_API_KEY=...
```

The web Add Provider form writes this for you.

## Step 4 — Configure the provider in Gini

### CLI

```bash
gini provider set azure gpt-4o \
  --base-url https://<resource>.openai.azure.com \
  --deployment <deployment> \
  --api-version 2024-10-21 \
  --auth-scheme api-key
```

- `--base-url` is **required** (Azure has no default endpoint) and must be
  `https://` — the credential is sent on every request.
- `--deployment` defaults to the model id when omitted.
- `--api-version` defaults to `2024-10-21`. Gini uses the dated
  deployment-scoped path (not Azure's newer undated `/openai/v1/` channel), so
  pass a dated GA value here — override with a later one like `2025-11-01` if you
  need its features. See Microsoft's [API version lifecycle](https://learn.microsoft.com/en-us/azure/ai-foundry/openai/api-version-lifecycle).
- `--auth-scheme` defaults to `api-key`; pass `bearer` for an Entra token.

### Web

Open **Settings → Add provider → Azure OpenAI**. Fill in the resource endpoint,
API key, model, deployment, API version, and auth scheme. The endpoint and a
model are required before you can save.

## Re-authentication

Azure is an API-key provider, so when a chat turn fails with a credential error,
Gini surfaces the provider's own message (for example "incorrect API key" or
"you exceeded your quota") and links to **Settings → Providers** to paste a new
key. Rotate keys under **Keys and Endpoint** in the
[Azure portal](https://portal.azure.com/). See ADR
[provider-reauth-guidance.md](../adr/provider-reauth-guidance.md).
