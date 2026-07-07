import { afterEach, describe, expect, it } from 'vitest';
import { OpenAICompatibleProvider } from './llm';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('OpenAICompatibleProvider', () => {
  it('retries transient transport failures', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) throw new TypeError('terminated');
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    const provider = new OpenAICompatibleProvider({ baseURL: 'https://llm.example/v1', apiKey: 'test-key', model: 'test-model', retryDelayMs: 0 });
    const response = await provider.chat({ jsonMode: true, messages: [{ role: 'user', content: 'hi' }] });

    expect(calls).toBe(2);
    expect(response.content).toBe('{"ok":true}');
    expect(response.usage?.totalTokens).toBe(13);
  });

  it('retries retryable HTTP statuses', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) return new Response('rate limited', { status: 429 });
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    const provider = new OpenAICompatibleProvider({ baseURL: 'https://llm.example/v1', apiKey: 'test-key', model: 'test-model', retryDelayMs: 0 });
    const response = await provider.chat({ messages: [{ role: 'user', content: 'hi' }] });

    expect(calls).toBe(2);
    expect(response.content).toBe('ok');
  });

  it('keeps non-retryable HTTP errors explicit', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response('bad request', { status: 400 });
    }) as typeof fetch;

    const provider = new OpenAICompatibleProvider({ baseURL: 'https://llm.example/v1', apiKey: 'test-key', model: 'test-model', retryDelayMs: 0 });

    await expect(provider.chat({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow('LLM request failed: 400 bad request');
    expect(calls).toBe(1);
  });
});
