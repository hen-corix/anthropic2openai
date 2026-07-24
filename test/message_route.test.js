const request = require("supertest");
const fs = require("fs");

beforeEach(() => {
  process.env.A2O_OPENAI_API_KEY = "test-key";
});

afterEach(() => {
  delete global.fetch;
  delete process.env.A2O_LOG_FILE;
  jest.resetModules();
  jest.restoreAllMocks();
});

test("POST /v1/messages proxies non-streaming and returns Anthropic-shaped response", async () => {
  global.fetch = jest.fn(async () => ({
    ok: true,
    json: async () => ({
      model: "gpt-any",
      choices: [{ finish_reason: "stop", message: { content: "Hi!" } }],
      usage: { prompt_tokens: 3, completion_tokens: 2 },
    }),
  }));

  const { app } = require("../index");

  const res = await request(app)
    .post("/v1/messages")
    .send({
      model: "claude-xyz",
      max_tokens: 10,
      messages: [{ role: "user", content: "Hello" }],
      stream: false,
    });

  expect(res.status).toBe(200);
  expect(res.body.type).toBe("message");
  expect(res.body.role).toBe("assistant");
  expect(res.body.model).toBe("claude-xyz");
  expect(res.body.content).toEqual([{ type: "text", text: "Hi!" }]);
  expect(res.body.stop_reason).toBe("end_turn");
  expect(res.body.usage).toEqual({ input_tokens: 3, output_tokens: 2 });
});

test("POST /v1/messages returns 401 when API key missing", async () => {
  process.env.A2O_OPENAI_API_KEY = "";
  jest.resetModules();
  const { app } = require("../index");

  const res = await request(app)
    .post("/v1/messages")
    .send({ model: "claude-xyz", messages: [{ role: "user", content: "Hello" }] });

  expect(res.status).toBe(401);
  expect(res.body.type).toBe("error");
  expect(res.body.error.type).toBe("authentication_error");
});

test("POST /v1/messages checks the API key before contacting the upstream API", async () => {
  process.env.A2O_OPENAI_API_KEY = "";
  jest.resetModules();
  global.fetch = jest.fn(() => {
    throw new Error("fetch should not be called when the API key is missing");
  });
  const { app } = require("../index");

  const res = await request(app)
    .post("/v1/messages")
    .send({ model: "claude-xyz", messages: [{ role: "user", content: "Hello" }] });

  expect(res.status).toBe(401);
  expect(res.body.error.type).toBe("authentication_error");
  expect(global.fetch).not.toHaveBeenCalled();
});

test("POST /v1/messages does not write a log file when A2O_LOG_FILE is unset (opt-in logging)", async () => {
  delete process.env.A2O_LOG_FILE;
  jest.resetModules();
  const appendFileSpy = jest.spyOn(fs, "appendFile").mockImplementation((_, __, cb) => cb(null));

  global.fetch = jest.fn(async () => ({
    ok: true,
    json: async () => ({
      choices: [{ finish_reason: "stop", message: { content: "Hi!" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }),
  }));

  const { app } = require("../index");

  await request(app)
    .post("/v1/messages")
    .send({ model: "claude-xyz", messages: [{ role: "user", content: "Hello" }] });

  expect(appendFileSpy).not.toHaveBeenCalled();
});

test("POST /v1/messages writes a log file when A2O_LOG_FILE is set", async () => {
  process.env.A2O_LOG_FILE = "test-messages.log";
  jest.resetModules();
  const appendFileSpy = jest.spyOn(fs, "appendFile").mockImplementation((_, __, cb) => cb(null));

  global.fetch = jest.fn(async () => ({
    ok: true,
    json: async () => ({
      choices: [{ finish_reason: "stop", message: { content: "Hi!" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }),
  }));

  const { app } = require("../index");

  await request(app)
    .post("/v1/messages")
    .send({ model: "claude-xyz", messages: [{ role: "user", content: "Hello" }] });

  expect(appendFileSpy).toHaveBeenCalledWith(
    "test-messages.log",
    expect.any(String),
    expect.any(Function)
  );
});

test("POST /v1/messages returns a 500 error instead of hanging when messages is not an array", async () => {
  const { app } = require("../index");

  const res = await request(app)
    .post("/v1/messages")
    .send({ model: "claude-xyz", messages: "not-an-array" });

  expect(res.status).toBe(500);
  expect(res.body.type).toBe("error");
});

test("POST /v1/messages returns a 500 error instead of hanging when a messages entry is null", async () => {
  const { app } = require("../index");

  const res = await request(app)
    .post("/v1/messages")
    .send({ model: "claude-xyz", messages: [null, { role: "user", content: "Hello" }] });

  expect(res.status).toBe(500);
  expect(res.body.type).toBe("error");
});
