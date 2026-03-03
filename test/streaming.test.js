const request = require('supertest');
const { app } = require('../index');

// Helper to create a mock ReadableStream compatible with fetch response
function createMockStream(chunks) {
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

describe('Streaming conversion tests', () => {
  beforeAll(() => {
    // Ensure fetch is mocked
    require('jest-fetch-mock').enableMocks();
    process.env.A2O_OPENAI_API_KEY = "test"
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('should convert OpenAI SSE stream to Anthropic SSE events', async () => {
    // Mock fetch to return a streaming response
    const sseChunks = [
      'data: {"choices":[{"delta":{"content":"Hello"}}]}' + '\n\n',
      'data: {"choices":[{"delta":{"content":" world"}}]}' + '\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":7}}' + '\n\n',
      'data: [DONE]' + '\n\n',
    ];
    global.fetch.mockResolvedValue({
      ok: true,
      body: createMockStream(sseChunks),
    });

    const response = await request(app)
      .post('/v1/messages')
      .send({ model: 'gpt-4.1', messages: [], stream: true })
      .expect('Content-Type', /text\/event-stream/)
      .expect(200);

    const text = response.text;
    // Verify key events are present
    expect(text).toContain('event: message_start');
    expect(text).toContain('event: content_block_start');
    expect(text).toContain('event: content_block_delta');
    expect(text).toContain('event: message_delta');
    expect(text).toContain('event: message_stop');
    // Verify the combined text content appears in delta events
    expect(text).toMatch(/"text":"Hello"/);
    expect(text).toMatch(/"text":" world"/);
  });

  test('should include input_tokens and output_tokens in message_delta usage', async () => {
    const sseChunks = [
      'data: {"choices":[{"delta":{"content":"Hello"}}]}' + '\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5}}' + '\n\n',
      'data: [DONE]' + '\n\n',
    ];
    global.fetch.mockResolvedValue({
      ok: true,
      body: createMockStream(sseChunks),
    });

    const response = await request(app)
      .post('/v1/messages')
      .send({ model: 'gpt-4.1', messages: [], stream: true })
      .expect('Content-Type', /text\/event-stream/)
      .expect(200);

    const text = response.text;
    // Extract the message_delta event data (handle nested objects)
    const messageDeltaMatch = text.match(/event: message_delta\ndata: ({[\s\S]*?})\n\n/);
    expect(messageDeltaMatch).toBeTruthy();

    const messageDelta = JSON.parse(messageDeltaMatch[1]);
    expect(messageDelta.usage).toBeDefined();
    expect(messageDelta.usage.input_tokens).toBe(10);
    expect(messageDelta.usage.output_tokens).toBe(5);
  });

  test('should handle stream reading error gracefully', async () => {
    const errorStream = {
      getReader() {
        return {
          async read() {
            throw new Error('Stream broken');
          },
        };
      },
    };

    global.fetch.mockResolvedValue({
      ok: true,
      body: errorStream,
    });

    const response = await request(app)
      .post('/v1/messages')
      .send({ model: 'gpt-4.1', messages: [], stream: true })
      .expect('Content-Type', /text\/event-stream/)
      .expect(200);

    const text = response.text;
    // Should have error event
    expect(text).toContain('event: error');
    expect(text).toContain('upstream_error');
    expect(text).toContain('Stream interrupted');
  });

  test('should handle empty stream (edge case)', async () => {
    const emptyStream = {
      getReader() {
        return {
          async read() {
            return { done: true };
          },
        };
      },
    };

    global.fetch.mockResolvedValue({
      ok: true,
      body: emptyStream,
    });

    const response = await request(app)
      .post('/v1/messages')
      .send({ model: 'gpt-4.1', messages: [], stream: true })
      .expect('Content-Type', /text\/event-stream/)
      .expect(200);

    const text = response.text;
    // Should still have message_start and message_stop even for empty stream
    expect(text).toContain('event: message_start');
    expect(text).toContain('event: message_stop');
    expect(text).toContain('event: message_delta');
  });

  test('should skip invalid JSON in SSE data', async () => {
    const sseChunks = [
      'data: {"choices":[{"delta":{"content":"Hello"}}]}' + '\n\n',
      'data: invalid json here' + '\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}' + '\n\n',
      'data: [DONE]' + '\n\n',
    ];
    global.fetch.mockResolvedValue({
      ok: true,
      body: createMockStream(sseChunks),
    });

    const response = await request(app)
      .post('/v1/messages')
      .send({ model: 'gpt-4.1', messages: [], stream: true })
      .expect('Content-Type', /text\/event-stream/)
      .expect(200);

    const text = response.text;
    // Should still process valid chunks
    expect(text).toContain('event: message_start');
    expect(text).toContain('Hello');
  });
});
