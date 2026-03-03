# anthropic2openai

A lightweight Node.js proxy that accepts [Anthropic Messages API](https://docs.anthropic.com/en/api/messages) requests and forwards them to any OpenAI-compatible Chat Completions endpoint. Responses are converted back to the Anthropic format, so any client that speaks the Anthropic API can transparently use OpenAI (or compatible) models.

## Features

- Non-streaming and streaming (SSE) support
- System prompts (string and array form)
- Multi-modal content (text + images)
- Tool use (definitions, tool_use, tool_result round-trips)
- All common sampling parameters (temperature, top_p, max_tokens, stop_sequences)
- Runtime API key validation with descriptive error responses
- Graceful handling of upstream API errors
- Development mode with hot restart (Ctrl+R) to reload configuration

## Setup

```bash
npm install
```

## Configuration

All settings are configured via environment variables:

| Variable | Required | Default | Description |
|---|---|---|---|
| `A2O_OPENAI_API_KEY` | Yes | — | API key for the upstream OpenAI-compatible endpoint |
| `A2O_OPENAI_BASE_URL` | No | `https://api.openai.com/v1` | Base URL of the OpenAI-compatible API (no trailing slash) |
| `A2O_OPENAI_MODEL` | No | `gpt-4o` | Model identifier to use for all requests |
| `A2O_MODEL_MAP` | No | `{}` | JSON map from Anthropic model names to OpenAI model names |
| `A2O_PROXY_PORT` | No | `3456` | Local TCP port the proxy listens on |
| `A2O_SSL_KEY_PATH` | No | `""` | Filesystem path to TLS private key (PEM) |
| `A2O_SSL_CERT_PATH` | No | `""` | Filesystem path to TLS certificate (PEM) |

Copy `.env.example` to `.env` and fill in your values, or export them directly.

## Usage

Start the proxy:

```bash
export A2O_OPENAI_API_KEY="sk-..."
export A2O_OPENAI_MODEL="gpt-4o"
npm start
```

Then point any Anthropic-compatible client at `http://localhost:3456` (or the port set via `A2O_PROXY_PORT`) as the base URL.

### curl example

```bash
curl http://localhost:3456/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-3-5-sonnet-20241022",
    "max_tokens": 256,
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

The `model` field in the request is passed through in the response but does not affect which upstream model is used — that is controlled by `A2O_OPENAI_MODEL`.

### Python (Anthropic SDK)

```python
import anthropic

client = anthropic.Anthropic(
    base_url="http://localhost:3456",
    api_key="unused",  # the proxy uses A2O_OPENAI_API_KEY
)

message = client.messages.create(
    model="claude-3-5-sonnet-20241022",
    max_tokens=256,
    messages=[{"role": "user", "content": "Hello!"}],
)
print(message.content[0].text)
```

### Claude Code

```bash
ANTHROPIC_AUTH_TOKEN="empty"; ANTHROPIC_BASE_URL="http://localhost:3456"; claude
```

## Endpoints

| Method | Path | Description |
|---|---|---|
| POST | `/v1/messages` | Anthropic Messages API (proxied) |
| GET | `/health` | Health check — returns `{"status": "ok"}` |

### SSL/TLS configuration

The proxy can serve HTTPS when you provide a TLS private key and certificate.

**Environment variables**

- `A2O_SSL_KEY_PATH` – Path to a PEM‑encoded private key file.
- `A2O_SSL_CERT_PATH` – Path to a PEM‑encoded certificate file.

If both variables are set and the files can be read, the server starts with HTTPS on the port defined by `A2O_PROXY_PORT`. Otherwise it falls back to plain HTTP.

The server now logs a warning `SSL configuration missing or invalid – falling back to HTTP` when the SSL files are missing or unreadable.

**Generating a self‑signed certificate**

```bash
# Generate a private key
openssl genpkey -algorithm RSA -out key.pem -pkeyopt rsa_keygen_bits:2048

# Generate a self‑signed certificate (valid for 365 days)
openssl req -new -x509 -key key.pem -out cert.pem -days 365 -subj "/CN=localhost"
```

Place `key.pem` and `cert.pem` somewhere safe and set the environment variables, e.g.:

```bash
export A2O_SSL_KEY_PATH="/path/to/key.pem"
export A2O_SSL_CERT_PATH="/path/to/cert.pem"
npm start
```

The proxy will now listen on `https://localhost:${A2O_PROXY_PORT}`.

### Development mode (hot restart)

When running the proxy directly (`npm start`), you can restart the server without stopping the process by pressing **Ctrl+R**. This reloads all environment variables and configuration, useful when iterating on settings or code changes.

```
Server running on http://localhost:3456
[CTRL+R] Restarting server...
Server running on http://localhost:3456
```

### Error handling

The proxy validates API configuration at runtime and returns descriptive error responses:

- **Missing API key**: Returns HTTP 401 with `{"type": "error", "error": {"type": "authentication_error", "message": "API key missing"}}`
- **OpenAI API errors**: Returns HTTP 502 with `{"type": "error", "error": {"type": "upstream_error", "message": "..."}}` for network failures or invalid responses

These errors follow the Anthropic API error format, allowing clients to handle them consistently.

