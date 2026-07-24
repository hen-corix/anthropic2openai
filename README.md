# anthropic2openai

A lightweight Node.js proxy that accepts [Anthropic Messages API](https://docs.anthropic.com/en/api/messages) requests and forwards them to any OpenAI-compatible Chat Completions endpoint. Responses are converted back to the Anthropic format, so any client that speaks the Anthropic API can transparently use OpenAI (or compatible) models.

## Features

- Non-streaming and streaming (SSE) support
- System prompts (string and array form)
- Multi-modal content (text + images)
- Tool use (definitions, tool_use, tool_result round-trips, tool_choice — forwarded only when `tools` are also present)
- All common sampling parameters (temperature, top_p, max_tokens, stop_sequences) — `temperature` is passed through unchanged (Anthropic's 0–1 range is **not** rescaled to OpenAI's 0–2)
- `top_k` is accepted but not forwarded (no OpenAI equivalent); a warning is logged when it is set
- Runtime API key validation with descriptive error responses
- Graceful handling of upstream API errors
- Development mode with hot restart (Ctrl+R) to reload configuration

## Setup

```bash
npm install
```

## Configuration

All settings are configured via environment variables:

| Variable                  | Required | Default                     | Description                                                                                 |
|---------------------------|----------|-----------------------------|---------------------------------------------------------------------------------------------|
| `A2O_OPENAI_API_KEY`      | Yes      | —                           | API key for the upstream OpenAI-compatible endpoint                                         |
| `A2O_OPENAI_BASE_URL`     | No       | `https://api.openai.com/v1` | Base URL of the OpenAI-compatible API (no trailing slash)                                   |
| `A2O_OPENAI_MODEL`        | No       | `gpt-4o`                    | Model identifier to use for all requests                                                    |
| `A2O_MODEL_MAP`           | No       | `{}`                        | JSON map from Anthropic model names to OpenAI model names                                   |
| `A2O_PROXY_PORT`          | No       | `3456`                      | Local TCP port the proxy listens on                                                         |
| `A2O_BIND_HOST`           | No       | `127.0.0.1`                 | Network interface to bind. Loopback by default; set `0.0.0.0` to expose (see security note) |
| `A2O_UPSTREAM_TIMEOUT_MS` | No       | `600000`                    | Abort the upstream request after this many milliseconds; `0` disables the timeout           |
| `A2O_SSL_KEY_PATH`        | No       | `""`                        | Filesystem path to TLS private key (PEM)                                                    |
| `A2O_SSL_CERT_PATH`       | No       | `""`                        | Filesystem path to TLS certificate (PEM)                                                    |
| `A2O_LOG_FILE`            | No       | — (logging disabled)        | Path to log message conversations (JSON Lines format); logging is opt-in                    |
| `A2O_DEBUG_REQUESTS`      | No       | — (off)                     | When set, logs a preview of each request's conversation content to stdout                   |
| `A2O_DEBUG_SSE`           | No       | — (off)                     | When set, logs every emitted SSE event (incl. full content) to stdout while streaming       |

Copy `.env.example` to `.env` and fill in your values, or export them directly.

> **Security note:** the proxy performs no client authentication — every request is forwarded upstream using the server-side `A2O_OPENAI_API_KEY`. It therefore binds to `127.0.0.1` by default. Only set `A2O_BIND_HOST=0.0.0.0` if you accept that anyone able to reach the port can spend against your upstream key, and put your own authentication/network controls in front of it.

> **Debug logging note:** `A2O_DEBUG_REQUESTS` and `A2O_DEBUG_SSE` both write conversation content to stdout and are off by default. They are independent of `A2O_LOG_FILE` (structured JSON Lines to a file).

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

### Message logging

Set `A2O_LOG_FILE` to enable conversation logging. Each request/response pair is appended as a single JSON line with timestamp, messages, and response.

```bash
export A2O_LOG_FILE="messages.log"
npm start
```

Log entry format (JSON Lines):
```json
{"ts": "2024-01-15T10:30:00.000Z", "messages": [{"role": "user", "content": "Hello"}], "response": "Hi there!"}
```

### Development mode (hot restart)

When running the proxy directly (`npm start`), you can restart the server without stopping the process by pressing **Ctrl+R**. This re-reads `process.env` and reapplies configuration (model, model map, SSL, log file, etc.).

```
Server running on http://localhost:3456
[CTRL+R] Restarting server...
Server running on http://localhost:3456
```

**Note:** Ctrl+R does **not** reload `.env` files — those are only loaded once at process startup. To pick up `.env` changes, restart the `npm start` process itself, or `export` the changed variables in the shell before pressing Ctrl+R.

### Error handling

The proxy validates API configuration at runtime and returns descriptive error responses:

- **Missing API key**: Returns HTTP 401 with `{"type": "error", "error": {"type": "authentication_error", "message": "API key missing"}}`
- **OpenAI API errors**: Returns HTTP 502 with `{"type": "error", "error": {"type": "upstream_error", "message": "..."}}` for network failures or invalid responses

These errors follow the Anthropic API error format, allowing clients to handle them consistently.

