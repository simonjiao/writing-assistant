import { ChatRequest, ChatResponse, LLMProvider } from './types';
import { safeJsonParse } from './utils';

export interface OpenAICompatibleProviderConfig {
  baseURL: string;
  apiKey: string;
  model: string;
  defaultTemperature?: number;
  maxRetries?: number;
  retryDelayMs?: number;
}

export class OpenAICompatibleProvider implements LLMProvider {
  constructor(private readonly config: OpenAICompatibleProviderConfig) {}

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const maxRetries = this.config.maxRetries ?? 2;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        return await this.chatOnce(request, attempt, maxRetries);
      } catch (error) {
        if (attempt >= maxRetries || !isRetryableLlmError(error)) throw normalizeLlmError(error);
        await delay((this.config.retryDelayMs ?? 500) * (attempt + 1));
      }
    }
    throw new Error('LLM request failed after retries.');
  }

  private async chatOnce(request: ChatRequest, attempt: number, maxRetries: number): Promise<ChatResponse> {
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
      const error = new Error(`LLM request failed: ${response.status} ${body}`);
      if (isRetryableLlmStatus(response.status) && attempt < maxRetries) throw error;
      throw error;
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

function isRetryableLlmStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function isRetryableLlmError(error: unknown): boolean {
  const message = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /LLM request failed: (408|409|425|429|5\d\d)\b|terminated|fetch failed|network|socket|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|UND_ERR|AbortError/i.test(message);
}

function normalizeLlmError(error: unknown): Error {
  if (error instanceof Error && /^LLM request failed/.test(error.message)) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`LLM request failed: ${message}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
