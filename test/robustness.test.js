const request = require("supertest");

// These tests toggle config that is captured into module-level variables at
// require time, so each one sets process.env and re-requires a fresh module.

function freshApp() {
  jest.resetModules();
  return require("../index").app;
}

// Minimal ReadableStream-compatible mock for a streaming fetch response.
function mockStream(chunks) {
  return {
    getReader() {
      let i = 0;
      return {
        async read() {
          if (i < chunks.length) {
            const value = new TextEncoder().encode(chunks[i]);
            i++;
            return { done: false, value };
          }
          return { done: true };
        },
      };
    },
  };
}

afterEach(() => {
  delete global.fetch;
  delete process.env.A2O_DEBUG_SSE;
  delete process.env.A2O_DEBUG_REQUESTS;
  delete process.env.A2O_UPSTREAM_TIMEOUT_MS;
  jest.resetModules();
  jest.restoreAllMocks();
});

test("malformed JSON body returns an Anthropic-shaped 400 instead of Express HTML", async () => {
  process.env.A2O_OPENAI_API_KEY = "test-key";
  jest.spyOn(console, "error").mockImplementation(() => {});
  const app = freshApp();

  const res = await request(app)
    .post("/v1/messages")
    .set("Content-Type", "application/json")
    .send('{"model": "claude-xyz", "messages": [')  // truncated / invalid JSON
    .expect(400);

  expect(res.body).toMatchObject({
    type: "error",
    error: { type: "invalid_request_error", message: "Invalid request body." },
  });
});

test("A2O_UPSTREAM_TIMEOUT_MS=0 disables the timeout and a normal request still succeeds", async () => {
  process.env.A2O_OPENAI_API_KEY = "test-key";
  process.env.A2O_UPSTREAM_TIMEOUT_MS = "0";
  global.fetch = jest.fn(async () => ({
    ok: true,
    json: async () => ({
      choices: [{ finish_reason: "stop", message: { content: "Hi!" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }),
  }));
  const app = freshApp();

  const res = await request(app)
    .post("/v1/messages")
    .send({ model: "claude-xyz", messages: [{ role: "user", content: "Hello" }] })
    .expect(200);

  expect(res.body.type).toBe("message");
});

test("A2O_DEBUG_REQUESTS logs a conversation content preview to stdout", async () => {
  process.env.A2O_OPENAI_API_KEY = "test-key";
  process.env.A2O_DEBUG_REQUESTS = "1";
  const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
  global.fetch = jest.fn(async () => ({
    ok: true,
    json: async () => ({
      choices: [{ finish_reason: "stop", message: { content: "Hi!" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }),
  }));
  const app = freshApp();

  await request(app)
    .post("/v1/messages")
    .send({
      model: "claude-xyz",
      messages: [{ role: "assistant", content: "previous answer" }],
    })
    .expect(200);

  const loggedPreview = logSpy.mock.calls.some(
    (args) => typeof args[0] === "string" && args[0].includes("content:")
  );
  expect(loggedPreview).toBe(true);
});

test("A2O_DEBUG_SSE writes SSE debug output during streaming", async () => {
  process.env.A2O_OPENAI_API_KEY = "test-key";
  process.env.A2O_DEBUG_SSE = "1";
  const debugSpy = jest.spyOn(console, "debug").mockImplementation(() => {});
  global.fetch = jest.fn(async () => ({
    ok: true,
    body: mockStream([
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n',
      "data: [DONE]\n\n",
    ]),
  }));
  const app = freshApp();

  await request(app)
    .post("/v1/messages")
    .send({ model: "claude-xyz", messages: [], stream: true })
    .expect(200);

  const loggedSse = debugSpy.mock.calls.some(
    (args) => typeof args[0] === "string" && args[0].includes("[SSE]")
  );
  expect(loggedSse).toBe(true);
});
