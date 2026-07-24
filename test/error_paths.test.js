const request = require('supertest');
// Must be set before requiring index.js: the API key is captured into a
// module-level variable at load time and no longer re-read from process.env
// per request.
process.env.A2O_OPENAI_API_KEY = 'test-key';
const { app } = require('../index');

// No custom mock helper; we'll use jest-fetch-mock directly in each test
describe('Error path tests', () => {
  beforeEach(() => {
    global.fetch = jest.fn();
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
      error: { type: 'upstream_error', message: expect.stringContaining('Upstream error') },
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

  test('Generic server error results in 500 response', async () => {
    global.fetch.mockRejectedValue(new Error('Something unexpected happened'));
    const res = await request(app)
      .post('/v1/messages')
      .send({ model: 'gpt-4.1', messages: [] })
      .expect(500);
    expect(res.body).toMatchObject({
      type: 'error',
      error: { type: 'api_error', message: 'Something unexpected happened' },
    });
  });

  test('TypeError with network-related code results in 502 response', async () => {
    const err = new TypeError('Connection failed');
    err.code = 'ECONNREFUSED';
    global.fetch.mockRejectedValue(err);
    const res = await request(app)
      .post('/v1/messages')
      .send({ model: 'gpt-4.1', messages: [] })
      .expect(502);
    expect(res.body).toMatchObject({
      type: 'error',
      error: { type: 'upstream_error', message: expect.stringContaining('Failed to reach') },
    });
  });

  test('SyntaxError (JSON parsing error) results in 502 response', async () => {
    const err = new SyntaxError('Unexpected token');
    err.name = 'SyntaxError';
    global.fetch.mockRejectedValue(err);
    const res = await request(app)
      .post('/v1/messages')
      .send({ model: 'gpt-4.1', messages: [] })
      .expect(502);
    expect(res.body).toMatchObject({
      type: 'error',
      error: { type: 'upstream_error', message: 'Invalid response from OpenAI API.' },
    });
  });
});
