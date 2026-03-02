// Tests for anthropicToOpenAI conversion of tool_result and tool_use blocks

const { anthropicToOpenAI} = require('..');

describe('anthropicToOpenAI conversion', () => {
  beforeEach(() => {
    fetch.resetMocks();
    process.env.A2O_OPENAI_API_KEY = "test"
  });
  const supertest = require('supertest');
  require('jest-fetch-mock');
  const app = require('..').app;

  // Helper to create a mock streaming OpenAI response
  function mockOpenAIStream(chunks) {
    // Create a mock of the Web Streams API's ReadableStream with getReader()
    const encoder = new TextEncoder();
    const sseLines = chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
    let idx = 0;
    return {
      ok: true,
      body: {
        getReader() {
          return {
            async read() {
              if (idx < sseLines.length) {
                // Return one character at a time to simulate streaming
                const char = sseLines.charAt(idx);
                idx++;
                const value = encoder.encode(char);
                return { done: false, value };
              }
              return { done: true };
            },
          };
        },
      },
    };
  }

  test('streaming conversion handles tool calls', async () => {
    // Prepare mock OpenAI streaming chunks
    const chunks = [
      // First chunk with tool_use start
      {
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: 'tool-123',
              function: { name: 'compute', arguments: '{"a":5}' },
            }],
          },
          finish_reason: null,
        }],
      },
      // Second chunk with partial arguments (simulating incremental)
      {
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              function: { arguments: ',"b":7}' },
            }],
          },
          finish_reason: null,
        }],
      },
      // Final chunk with usage and finish reason
      {
        usage: { prompt_tokens: 10, completion_tokens: 20 },
        choices: [{ finish_reason: 'stop' }],
      },
    ];

    fetch.mockResolvedValueOnce(mockOpenAIStream(chunks));

    const response = await supertest(app)
      .post('/v1/messages')
      .send({ model: 'gpt-4', messages: [], stream: true })
      .expect(200)
      .expect('Content-Type', /text\/event-stream/);

    const text = response.text;
    // Verify tool_use start event
    expect(text).toMatch(/event: content_block_start\n.*"type":"tool_use"/s);
    // Verify input_json_delta contains the partial JSON as received from OpenAI
    expect(text).toMatch(/"partial_json":"{\\"a\\":5}"/s);
    expect(text).toMatch(/"partial_json":",\\"b\\":7}"/s);
    // Verify message_delta includes stop_reason tool_use since we had tool calls
    expect(text).toMatch(/event: message_delta[\s\S]*"stop_reason":"tool_use"/);
  });

  test('converts user message with tool_result blocks', () => {
    const body = {
      model: 'gpt-4',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is the answer?' },
            {
              type: 'tool_result',
              tool_use_id: 'call-123',
              content: '42',
            },
          ],
        },
      ],
    };

    const result = anthropicToOpenAI(body);
    expect(result.messages).toHaveLength(2);

    // First message: user text
    expect(result.messages[0]).toEqual({
      role: 'user',
      content: 'What is the answer?',
    });

    // Second message: tool result
    expect(result.messages[1]).toEqual({
      role: 'tool',
      tool_call_id: 'call-123',
      content: '42',
    });
  });

  test('converts assistant message with tool_use blocks', () => {
    const body = {
      model: 'gpt-4',
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'call-456',
              name: 'compute',
              input: { a: 5, b: 7 },
            },
          ],
        },
      ],
    };

    const result = anthropicToOpenAI(body);
    expect(result.messages).toHaveLength(1);
    const msg = result.messages[0];
    expect(msg.role).toBe('assistant');
    expect(msg.content).toBeNull();
    expect(msg.tool_calls).toEqual([
      {
        id: 'call-456',
        type: 'function',
        function: {
          name: 'compute',
          arguments: JSON.stringify({ a: 5, b: 7 }),
        },
      },
    ]);
  });

  test('converts user message with multiple tool_result blocks and no text', () => {
    const body = {
      model: 'gpt-4',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'call-1', content: 'Result 1' },
            { type: 'tool_result', tool_use_id: 'call-2', content: ['Part A', 'Part B'] },
          ],
        },
      ],
    };

    const result = anthropicToOpenAI(body);
    // Should only contain tool messages, no preceding user text message
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]).toEqual({ role: 'tool', tool_call_id: 'call-1', content: 'Result 1' });
    expect(result.messages[1]).toEqual({ role: 'tool', tool_call_id: 'call-2', content: 'Part A\nPart B' });
  });

  test('handles tool calls with late-arriving name/id (partial chunks)', async () => {
    // Simulate OpenAI sending partial tool call info across multiple chunks
    const chunks = [
      // First chunk: only index, no id or name yet
      {
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              // No id or function.name in first chunk
              function: { arguments: '{"query": "weather"}' },
            }],
          },
          finish_reason: null,
        }],
      },
      // Second chunk: id arrives
      {
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: 'tool-late-123',
              // Still no name
            }],
          },
          finish_reason: null,
        }],
      },
      // Third chunk: name arrives
      {
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              function: { name: 'get_weather' },
            }],
          },
          finish_reason: null,
        }],
      },
      // Fourth chunk: more arguments
      {
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              function: { arguments: ',"city":"NYC"' },
            }],
          },
          finish_reason: null,
        }],
      },
      // Final chunk
      {
        usage: { prompt_tokens: 15, completion_tokens: 25 },
        choices: [{ finish_reason: 'stop' }],
      },
    ];

    fetch.mockResolvedValueOnce(mockOpenAIStream(chunks));

    const response = await supertest(app)
      .post('/v1/messages')
      .send({ model: 'gpt-4', messages: [], stream: true })
      .expect(200)
      .expect('Content-Type', /text\/event-stream/);

    const text = response.text;

    // The content_block_start should only appear AFTER we have both id and name
    // It should contain the complete, correct information
    const blockStartMatch = text.match(/event: content_block_start\ndata: ({[\s\S]*?"type":"tool_use"[\s\S]*?})\n\n/);
    expect(blockStartMatch).toBeTruthy();

    const blockStart = JSON.parse(blockStartMatch[1]);
    expect(blockStart.content_block.id).toBe('tool-late-123');
    expect(blockStart.content_block.name).toBe('get_weather');

    // Verify all argument chunks were sent - check for JSON content within the partial_json field
    expect(text).toMatch(/partial_json.*query.*weather/);
    expect(text).toMatch(/partial_json.*city.*NYC/);

    // Verify stop_reason is tool_use since we had tool calls
    expect(text).toMatch(/"stop_reason":"tool_use"/);
  });

});
