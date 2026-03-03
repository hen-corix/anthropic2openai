beforeAll(() => {
  process.env.A2O_OPENAI_API_KEY = process.env.A2O_OPENAI_API_KEY || "test-key";
});

test("anthropicToOpenAI maps system string + user text", () => {
  const { anthropicToOpenAI } = require("../index");

  const out = anthropicToOpenAI({
    model: "claude-anything",
    system: "You are helpful.",
    messages: [{ role: "user", content: "Hello" }],
    max_tokens: 12,
    temperature: 0.2,
    top_p: 0.9,
    stop_sequences: ["\n\nHuman:"],
  });

  expect(out.model).toBeDefined();
  expect(out.messages[0]).toEqual({ role: "system", content: "You are helpful." });
  expect(out.messages[1]).toEqual({ role: "user", content: "Hello" });
  expect(out.max_tokens).toBe(12);
  expect(out.temperature).toBe(0.2);
  expect(out.top_p).toBe(0.9);
  expect(out.stop).toEqual(["\n\nHuman:"]);
});

test("anthropicToOpenAI converts assistant tool_use blocks to tool_calls", () => {
  const { anthropicToOpenAI } = require("../index");

  const out = anthropicToOpenAI({
    model: "claude-anything",
    messages: [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Calling a tool..." },
          { type: "tool_use", id: "toolu_1", name: "doThing", input: { x: 1 } },
        ],
      },
    ],
  });

  expect(out.messages).toHaveLength(1);
  expect(out.messages[0].role).toBe("assistant");
  expect(out.messages[0].tool_calls).toEqual([
    {
      id: "toolu_1",
      type: "function",
      function: { name: "doThing", arguments: JSON.stringify({ x: 1 }) },
    },
  ]);
});

test("openAIToAnthropic converts tool_calls to tool_use blocks + stop_reason tool_use", () => {
  const { openAIToAnthropic } = require("../index");

  const out = openAIToAnthropic(
    {
      model: "upstream-model",
      choices: [
        {
          finish_reason: "stop",
          message: {
            content: "Sure.",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "doThing", arguments: "{\"x\":1}" },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    },
    "original-anthropic-model"
  );

  expect(out.type).toBe("message");
  expect(out.role).toBe("assistant");
  expect(out.model).toBe("original-anthropic-model");
  expect(out.stop_reason).toBe("tool_use");
  expect(out.content).toEqual([
    { type: "text", text: "Sure." },
    { type: "tool_use", id: "call_1", name: "doThing", input: { x: 1 } },
  ]);
  expect(out.usage).toEqual({ input_tokens: 10, output_tokens: 5 });
});

test("anthropicToOpenAI handles system message as array of content blocks", () => {
  const { anthropicToOpenAI } = require("../index");

  const out = anthropicToOpenAI({
    model: "claude-anything",
    system: [{ text: "You are helpful" }, { text: "Be concise" }],
    messages: [{ role: "user", content: "Hello" }],
  });

  expect(out.messages[0]).toEqual({ role: "system", content: "You are helpful\nBe concise" });
});

test("anthropicToOpenAI warns and treats unexpected role as user", () => {
  const { anthropicToOpenAI } = require("../index");
  const consoleSpy = jest.spyOn(console, "warn").mockImplementation();

  anthropicToOpenAI({
    model: "claude-anything",
    messages: [{ role: "system", content: "test" }],
  });

  expect(consoleSpy).toHaveBeenCalledWith('Unexpected role "system" in message, treating as "user"');
  consoleSpy.mockRestore();
});

test("anthropicToOpenAI converts image with URL source", () => {
  const { anthropicToOpenAI } = require("../index");

  const out = anthropicToOpenAI({
    model: "claude-anything",
    messages: [{
      role: "user",
      content: [{ type: "image", source: { type: "url", url: "http://example.com/img.png" } }],
    }],
  });

  expect(out.messages[0].content[0]).toEqual({
    type: "image_url",
    image_url: { url: "http://example.com/img.png" },
  });
});

test("anthropicToOpenAI handles tool result with array content", () => {
  const { anthropicToOpenAI } = require("../index");

  const out = anthropicToOpenAI({
    model: "claude-anything",
    messages: [{
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "tool_123",
        content: [{ text: "Result 1" }, { text: "Result 2" }],
      }],
    }],
  });

  expect(out.messages[0].content).toBe("Result 1\nResult 2");
});

// Map all finish_reason values to stop_reason
test("mapFinishReason maps all finish_reason values correctly", () => {
  const { openAIToAnthropic } = require("../index");

  // stop -> end_turn
  let out = openAIToAnthropic({
    model: "upstream-model",
    choices: [{ finish_reason: "stop", message: { content: "Hi" } }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  }, "claude-model");
  expect(out.stop_reason).toBe("end_turn");

  // length -> max_tokens
  out = openAIToAnthropic({
    model: "upstream-model",
    choices: [{ finish_reason: "length", message: { content: "Hi" } }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  }, "claude-model");
  expect(out.stop_reason).toBe("max_tokens");

  // content_filter -> end_turn
  out = openAIToAnthropic({
    model: "upstream-model",
    choices: [{ finish_reason: "content_filter", message: { content: "Hi" } }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  }, "claude-model");
  expect(out.stop_reason).toBe("end_turn");

  // unknown -> end_turn
  out = openAIToAnthropic({
    model: "upstream-model",
    choices: [{ finish_reason: "unknown_reason", message: { content: "Hi" } }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  }, "claude-model");
  expect(out.stop_reason).toBe("end_turn");
});

test("openAIToAnthropic handles tool_calls with invalid JSON arguments gracefully", () => {
  const { openAIToAnthropic } = require("../index");

  const out = openAIToAnthropic({
    model: "upstream-model",
    choices: [{
      finish_reason: "stop",
      message: {
        content: null,
        tool_calls: [{
          id: "call_1",
          type: "function",
          function: { name: "doThing", arguments: "invalid json" },
        }],
      },
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  }, "claude-model");

  expect(out.content).toEqual([{
    type: "tool_use",
    id: "call_1",
    name: "doThing",
    input: {},
  }]);
});

test("anthropicToOpenAI handles unknown message content type as null", () => {
  const { anthropicToOpenAI } = require("../index");

  const out = anthropicToOpenAI({
    model: "claude-anything",
    messages: [{ role: "user", content: { foo: "bar" } }],
  });

  // Message with null/empty content should be filtered out
  expect(out.messages.filter(m => m.role === "user")).toHaveLength(0);
});

test("anthropicToOpenAI warns when stop_sequences exceeds 4 items", () => {
  const { anthropicToOpenAI } = require("../index");
  const consoleSpy = jest.spyOn(console, "warn").mockImplementation();

  const out = anthropicToOpenAI({
    model: "claude-anything",
    messages: [{ role: "user", content: "Hello" }],
    stop_sequences: ["stop1", "stop2", "stop3", "stop4", "stop5"],
  });

  expect(consoleSpy).toHaveBeenCalledWith("stop_sequences has 5 items, truncating to 4 (OpenAI limit)");
  expect(out.stop).toEqual(["stop1", "stop2", "stop3", "stop4"]);
  consoleSpy.mockRestore();
});

test("anthropicToOpenAI maps tools to OpenAI format", () => {
  const { anthropicToOpenAI } = require("../index");

  const out = anthropicToOpenAI({
    model: "claude-anything",
    messages: [{ role: "user", content: "Hello" }],
    tools: [
      {
        name: "get_weather",
        description: "Get weather for a city",
        input_schema: { type: "object", properties: { city: { type: "string" } } },
      },
    ],
  });

  expect(out.tools).toEqual([
    {
      type: "function",
      function: {
        name: "get_weather",
        description: "Get weather for a city",
        parameters: { type: "object", properties: { city: { type: "string" } } },
      },
    },
  ]);
});

test("anthropicToOpenAI handles empty tools array", () => {
  const { anthropicToOpenAI } = require("../index");

  const out = anthropicToOpenAI({
    model: "claude-anything",
    messages: [{ role: "user", content: "Hello" }],
    tools: [],
  });

  expect(out.tools).toBeUndefined();
});
