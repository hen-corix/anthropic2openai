delete process.env.A2O_MODEL_MAP;
const request = require('supertest');
const { anthropicToOpenAI, openAIToAnthropic } = require('../index');

describe('Helper function tests', () => {
  beforeEach(() => {
    jest.resetModules();
    delete process.env.A2O_MODEL_MAP;
  });
  afterEach(() => {
    delete process.env.A2O_MODEL_MAP;
  });
  test('openAIToAnthropic generates msg id with prefix and 24 hex chars', () => {
    const openaiRes = { choices: [{ message: { content: 'test' } }], usage: {} };
    const result = openAIToAnthropic(openaiRes);
    expect(result.id).toMatch(/^msg_[0-9a-f]{24}$/);
  });

  test('mapFinishReason mapping for stop, length, content_filter, unknown', () => {
    const makeRes = (reason) => ({
      choices: [{ finish_reason: reason, message: {} }],
      usage: {}
    });
    expect(openAIToAnthropic(makeRes('stop')).stop_reason).toBe('end_turn');
    expect(openAIToAnthropic(makeRes('length')).stop_reason).toBe('max_tokens');
    expect(openAIToAnthropic(makeRes('content_filter')).stop_reason).toBe('end_turn');
    expect(openAIToAnthropic(makeRes('other')).stop_reason).toBe('end_turn');
  });

  test('MODEL_MAP parsing: valid JSON mapping applied', () => {
    jest.resetModules();
    process.env.A2O_MODEL_MAP = '{"claude-3-5-sonnet-20241022":"gpt-4o-mini"}';
    const { anthropicToOpenAI } = require('../index');
    const body = { model: 'claude-3-5-sonnet-20241022', messages: [] };
    const result = anthropicToOpenAI(body);
    expect(result.model).toBe('gpt-4o-mini');
  });

  test('MODEL_MAP parsing: malformed JSON results in empty map', () => {
    jest.resetModules();
    process.env.A2O_MODEL_MAP = '{invalid json}';
    const { anthropicToOpenAI } = require('../index');
    const body = { model: 'any-model', messages: [] };
    const result = anthropicToOpenAI(body);
    // Should fallback to default OPENAI_MODEL env or default value defined in code (gpt-4.1)
    expect(result.model).toBe(process.env.A2O_OPENAI_MODEL || 'gpt-4.1');
  });
});
