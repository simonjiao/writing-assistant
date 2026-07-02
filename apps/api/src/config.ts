import { config as loadDotenv } from 'dotenv';
import { WorkflowExecutionMode } from '@wa/core';

loadDotenv();

export interface AppConfig {
  host: string;
  port: number;
  dataDir: string;
  webOrigin: string;
  llmProvider: 'mock' | 'openai-compatible';
  openaiBaseURL: string;
  openaiApiKey: string;
  openaiModel: string;
  workflowExecutionMode: WorkflowExecutionMode;
  workflowQueueDriver: 'local' | 'redis';
  enableWorkers: boolean;
  runnerConcurrency: number;
  redisUrl: string;
  ragProvider: 'local' | 'http';
  ragBaseURL: string;
  ragApiKey: string;
  ragSearchPath: string;
  ragRefsPath: string;
  ragTimeoutMs: number;
  ragFallbackToLocal: boolean;
}

export function getConfig(): AppConfig {
  return {
    host: process.env.HOST ?? '0.0.0.0',
    port: Number(process.env.PORT ?? 8787),
    dataDir: process.env.DATA_DIR ?? '.data',
    webOrigin: process.env.WEB_ORIGIN ?? 'http://localhost:5173',
    llmProvider: process.env.LLM_PROVIDER === 'openai-compatible' ? 'openai-compatible' : 'mock',
    openaiBaseURL: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
    openaiApiKey: process.env.OPENAI_API_KEY ?? '',
    openaiModel: process.env.OPENAI_MODEL ?? 'gpt-4.1-mini',
    workflowExecutionMode: process.env.WORKFLOW_EXECUTION_MODE === 'async' ? 'async' : 'inline',
    workflowQueueDriver: process.env.WORKFLOW_QUEUE_DRIVER === 'redis' || process.env.QUEUE_PROVIDER === 'redis' ? 'redis' : 'local',
    enableWorkers: process.env.ENABLE_WORKERS !== 'false',
    runnerConcurrency: Math.max(1, Number(process.env.RUNNER_CONCURRENCY ?? process.env.RUNNER_COUNT ?? 2)),
    redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
    ragProvider: process.env.RAG_PROVIDER === 'http' || process.env.RAG_BASE_URL ? 'http' : 'local',
    ragBaseURL: process.env.RAG_BASE_URL ?? '',
    ragApiKey: process.env.RAG_API_KEY ?? '',
    ragSearchPath: process.env.RAG_SEARCH_PATH ?? '/search',
    ragRefsPath: process.env.RAG_REFS_PATH ?? process.env.RAG_BY_REFS_PATH ?? '/refs',
    ragTimeoutMs: Number(process.env.RAG_TIMEOUT_MS ?? 10000),
    ragFallbackToLocal: process.env.RAG_FALLBACK_LOCAL !== 'false' && process.env.RAG_FALLBACK_TO_LOCAL !== 'false',
  };
}
