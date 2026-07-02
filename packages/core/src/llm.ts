import { ChatRequest, ChatResponse, LLMProvider } from './types';
import { safeJsonParse } from './utils';

export interface OpenAICompatibleProviderConfig {
  baseURL: string;
  apiKey: string;
  model: string;
  defaultTemperature?: number;
}

export class OpenAICompatibleProvider implements LLMProvider {
  constructor(private readonly config: OpenAICompatibleProviderConfig) {}

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const response = await fetch(`${this.config.baseURL.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: request.model ?? this.config.model,
        messages: request.messages,
        temperature: request.temperature ?? this.config.defaultTemperature ?? 0.3,
        max_tokens: request.maxTokens,
        response_format: request.jsonMode ? { type: 'json_object' } : undefined,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`LLM request failed: ${response.status} ${body}`);
    }

    const raw = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    return {
      content: raw.choices?.[0]?.message?.content ?? '',
      raw,
      usage: {
        promptTokens: raw.usage?.prompt_tokens,
        completionTokens: raw.usage?.completion_tokens,
        totalTokens: raw.usage?.total_tokens,
      },
    };
  }

  async json<T>(request: ChatRequest): Promise<T> {
    const response = await this.chat({ ...request, jsonMode: true });
    const parsed = safeJsonParse<T>(response.content);
    if (!parsed) {
      throw new Error(`LLM did not return valid JSON: ${response.content.slice(0, 300)}`);
    }
    return parsed;
  }
}

export class MockLLMProvider implements LLMProvider {
  async chat(request: ChatRequest): Promise<ChatResponse> {
    const lastUser = [...request.messages].reverse().find((message) => message.role === 'user')?.content ?? '';
    return {
      content: `Mock response generated for: ${lastUser.slice(0, 120)}`,
      raw: { provider: 'mock' },
    };
  }

  async json<T>(request: ChatRequest): Promise<T> {
    const response = await this.chat(request);
    return { content: response.content, provider: 'mock' } as T;
  }
}
