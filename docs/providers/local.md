# Local (OpenAI-compatible)

The `local` provider talks to any server that exposes an OpenAI-compatible
`/v1/chat/completions` endpoint running on your own machine or network —
[Ollama](https://ollama.com/), [LM Studio](https://lmstudio.ai/),
[vLLM](https://docs.vllm.ai/), [llama.cpp](https://github.com/ggml-org/llama.cpp),
and similar. Nothing leaves your machine and there is no per-token cost.

## Step 1 — Run a local server

Pick one and start it. The only thing Gini needs is the base URL of its
OpenAI-compatible endpoint.

### Ollama (default)

Install from [ollama.com/download](https://ollama.com/download):

- **macOS:** download the app (requires macOS 14 Sonoma or later).
- **Linux:** `curl -fsSL https://ollama.com/install.sh | sh`

Pull and run a model, then confirm it is listening:

```bash
ollama pull llama3.2
ollama run llama3.2          # downloads + starts serving
```

Ollama exposes an OpenAI-compatible endpoint at `http://localhost:11434/v1`
(this is Gini's default `local` base URL). See the
[Ollama OpenAI compatibility docs](https://docs.ollama.com/api/openai-compatibility).
No real key is needed, but some clients want a placeholder string such as
`ollama`.

### LM Studio

Install from [lmstudio.ai](https://lmstudio.ai/), load a model, and start its
**Local Server** (the "Developer" tab). It serves an OpenAI-compatible API at
`http://localhost:1234/v1` by default — see the
[LM Studio OpenAI compatibility docs](https://lmstudio.ai/docs/developer/openai-compat).

### vLLM

Follow the [vLLM quickstart](https://docs.vllm.ai/en/latest/getting_started/quickstart.html).
Its OpenAI-compatible server defaults to `http://localhost:8000/v1`:

```bash
vllm serve <model> --port 8000
```

## Step 2 — Configure the provider in Gini

### CLI

```bash
gini provider set local llama3.2 --base-url http://localhost:11434/v1
```

- The model name is whatever your server expects (for Ollama, the name you
  pulled; for vLLM, the served model id).
- `--base-url` defaults to `http://127.0.0.1:11434/v1` (Ollama). Set it to match
  your server: `http://localhost:1234/v1` for LM Studio,
  `http://localhost:8000/v1` for vLLM.

`http://` is allowed for `local` (unlike the cloud providers) because a loopback
address keeps traffic on your machine.

### Web

Open **Settings → Add provider → Local**. Set the base URL to your server's
endpoint and the model to a name it serves. Leave the key blank for an open
local gateway.

## API keys for local servers

Most local servers accept requests with no authentication, so you can leave the
key blank. If your server *does* require a key (some vLLM or proxy setups do),
Gini reads it from the `GINI_LOCAL_API_KEY` environment variable. Set it in your
shell or in `~/.gini/secrets.env`:

```bash
# ~/.gini/secrets.env  (created mode 0600)
GINI_LOCAL_API_KEY=...
```

To point at a non-default env var instead, pass `--api-key-env <NAME>`.

## Re-authentication

For an open local server there is nothing to re-authenticate. If you set
`GINI_LOCAL_API_KEY` and requests start failing with an auth error, update that
value (Settings → Providers, or the secrets file) and restart the gateway. See
ADR [provider-reauth-guidance.md](../adr/provider-reauth-guidance.md).
