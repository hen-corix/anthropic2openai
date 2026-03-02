const request = require('supertest');
const { app } = require('../index');

// No custom mock helper; we'll use jest-fetch-mock directly in each test
describe('Error path tests', () => {
  beforeEach(() => {
    jest.resetModules();
    global.fetch = jest.fn();
    // Ensure env var for API key is set for tests
    process.env.A2O_OPENAI_API_KEY = 'test-key';
  });


  test('Upstream non-200 response forwards error', async () => {
    global.fetch.mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
      json: async () => ({}),
    });
    const res = await request(app)
      .post('/v1/messages')
      .send({ model: 'gpt-4.1', messages: [] })
      .expect(401);
    expect(res.body).toMatchObject({
      type: 'error',
      error: { type: 'api_error', message: expect.stringContaining('Upstream error') },
    });
  });

  test('Fetch rejection results in 500 response', async () => {
    global.fetch.mockRejectedValue(new Error('Network failure'));
    const res = await request(app)
      .post('/v1/messages')
      .send({ model: 'gpt-4.1', messages: [] })
      .expect(500);
    expect(res.body).toMatchObject({
      type: 'error',
      error: { type: 'api_error', message: 'Network failure' },
    });
  });

  test('Upstream JSON parse error results in 502 response', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError('Unexpected token in JSON'); },
    });
    const res = await request(app)
      .post('/v1/messages')
      .send({ model: 'gpt-4.1', messages: [] })
      .expect(502);
    expect(res.body).toMatchObject({
      type: 'error',
      error: { type: 'upstream_error', message: 'Invalid response from OpenAI API.' },
    });
  });

  test('Network error (TypeError) results in 502 response', async () => {
    global.fetch.mockRejectedValue(new TypeError('Failed to fetch'));
    const res = await request(app)
      .post('/v1/messages')
      .send({ model: 'gpt-4.1', messages: [] })
      .expect(502);
    expect(res.body).toMatchObject({
      type: 'error',
      error: { type: 'upstream_error', message: expect.stringContaining('Failed to reach') },
    });
  });
});
