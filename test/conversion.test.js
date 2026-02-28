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
