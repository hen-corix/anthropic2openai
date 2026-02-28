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
});
