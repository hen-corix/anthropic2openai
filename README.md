# anthropic2openai

A lightweight Node.js proxy that accepts [Anthropic Messages API](https://docs.anthropic.com/en/api/messages) requests and forwards them to any OpenAI-compatible Chat Completions endpoint. Responses are converted back to the Anthropic format, so any client that speaks the Anthropic API can transparently use OpenAI (or compatible) models.

## Features

- Non-streaming and streaming (SSE) support
- System prompts (string and array form)
- Multi-modal content (text + images)
- Tool use (definitions, tool_use, tool_result round-trips)
- All common sampling parameters (temperature, top_p, max_tokens, stop_sequences)

## Setup

```bash
npm install
```

## Configuration

All settings are configured via environment variables:

| Variable | Required | Default | Description |
|---|---|---|---|
| `OPENAI_API_KEY` | Yes | — | API key for the upstream OpenAI-compatible endpoint |
| `OPENAI_BASE_URL` | No | `https://api.openai.com/v1` | Base URL of the OpenAI-compatible API (no trailing slash) |
| `OPENAI_MODEL` | No | `gpt-4o` | Model identifier to use for all requests |
| `PROXY_PORT` | No | `3456` | Local TCP port the proxy listens on |

Copy `.env.example` to `.env` and fill in your values, or export them directly.

## Usage

Start the proxy:

```bash
export OPENAI_API_KEY="sk-..."
export OPENAI_MODEL="gpt-4o"
npm start
```

Then point any Anthropic-compatible client at `http://localhost:3456` (or the port set via `PROXY_PORT`) as the base URL.

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

The `model` field in the request is passed through in the response but does not affect which upstream model is used — that is controlled by `OPENAI_MODEL`.

### Python (Anthropic SDK)

```python
import anthropic

client = anthropic.Anthropic(
    base_url="http://localhost:3456",
    api_key="unused",  # the proxy uses OPENAI_API_KEY
)

message = client.messages.create(
    model="claude-3-5-sonnet-20241022",
    max_tokens=256,
    messages=[{"role": "user", "content": "Hello!"}],
)
print(message.content[0].text)
```

## Endpoints

| Method | Path | Description |
|---|---|---|
| POST | `/v1/messages` | Anthropic Messages API (proxied) |
| GET | `/health` | Health check — returns `{"status": "ok"}` |
