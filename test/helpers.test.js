delete process.env.A2O_MODEL_MAP;
require('supertest');
const {openAIToAnthropic } = require('../index');

describe('Helper function tests', () => {
  beforeEach(() => {
    jest.resetModules();
    delete process.env.A2O_MODEL_MAP;
    delete process.env.A2O_OPENAI_MODEL;
  });
  afterEach(() => {
    delete process.env.A2O_MODEL_MAP;
    delete process.env.A2O_OPENAI_MODEL;
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
    // Suppress the expected console.error from malformed JSON parsing
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    process.env.A2O_MODEL_MAP = '{invalid json}';
    const { anthropicToOpenAI } = require('../index');
    const body = { model: 'any-model', messages: [] };
    const result = anthropicToOpenAI(body);
    // Should fallback to default OPENAI_MODEL env or default value defined in code
    expect(result.model).toBe(process.env.A2O_OPENAI_MODEL || 'gpt-4o');
    consoleSpy.mockRestore();
  });

  test('MODEL_MAP parsing: non-object JSON results in empty map', () => {
    jest.resetModules();
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    process.env.A2O_MODEL_MAP = '"string_value"';
    const { anthropicToOpenAI } = require('../index');
    const body = { model: 'any-model', messages: [] };
    const result = anthropicToOpenAI(body);
    expect(result.model).toBe(process.env.A2O_OPENAI_MODEL || 'gpt-4o');
    consoleSpy.mockRestore();
  });

  test('MODEL_MAP parsing: null JSON results in empty map', () => {
    jest.resetModules();
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    process.env.A2O_MODEL_MAP = 'null';
    const { anthropicToOpenAI } = require('../index');
    const body = { model: 'any-model', messages: [] };
    const result = anthropicToOpenAI(body);
    expect(result.model).toBe(process.env.A2O_OPENAI_MODEL || 'gpt-4o');
    consoleSpy.mockRestore();
  });

  test('MODEL_MAP parsing: invalid entries with empty string values are rejected', () => {
    jest.resetModules();
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    process.env.A2O_MODEL_MAP = '{"valid-model":"gpt-4o","invalid-model":""}';
    const { anthropicToOpenAI } = require('../index');
    const body = { model: 'valid-model', messages: [] };
    const result = anthropicToOpenAI(body);
    // Since map has invalid entries, whole map is rejected
    expect(result.model).toBe(process.env.A2O_OPENAI_MODEL || 'gpt-4o');
    consoleSpy.mockRestore();
  });

  test('MODEL_MAP parsing: non-string keys or values are rejected', () => {
    jest.resetModules();
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    process.env.A2O_MODEL_MAP = '{"model":123}';
    const { anthropicToOpenAI } = require('../index');
    const body = { model: 'model', messages: [] };
    const result = anthropicToOpenAI(body);
    // Since value is not a string, map is rejected
    expect(result.model).toBe(process.env.A2O_OPENAI_MODEL || 'gpt-4o');
    consoleSpy.mockRestore();
  });

  test('openAIToAnthropic uses OPENAI_MODEL when requestModel is undefined', () => {
    jest.resetModules();
    process.env.A2O_OPENAI_MODEL = 'gpt-4o-custom';
    // Must re-require to pick up the env var
    const { openAIToAnthropic: openAIToAnthropicCustom } = require('../index');

    const out = openAIToAnthropicCustom({
      model: "upstream-model",
      choices: [{ finish_reason: "stop", message: { content: "Hi" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }, undefined);

    expect(out.model).toBe('upstream-model');
  });

  test('openAIToAnthropic falls back to openaiRes.model when requestModel is undefined and env not set', () => {
    const out = openAIToAnthropic({
      model: "upstream-gpt-4",
      choices: [{ finish_reason: "stop", message: { content: "Hi" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }, undefined);

    expect(out.model).toBe("upstream-gpt-4");
  });
});
