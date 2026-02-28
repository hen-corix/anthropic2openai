// Tests for anthropicToOpenAI conversion of tool_result and tool_use blocks

const { anthropicToOpenAI} = require('..');

describe('anthropicToOpenAI conversion', () => {
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

});
