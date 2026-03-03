const request = require("supertest");

beforeEach(() => {
  process.env.A2O_OPENAI_API_KEY = "test-key";
});

afterEach(() => {
  delete global.fetch;
  jest.resetModules();
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
