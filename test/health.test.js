const request = require("supertest");

beforeAll(() => {
  process.env.A2O_OPENAI_API_KEY = process.env.A2O_OPENAI_API_KEY || "test-key";
});

test("GET /health returns ok", async () => {
  const { app } = require("../index");
  const res = await request(app).get("/health");
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ status: "ok" });
});
