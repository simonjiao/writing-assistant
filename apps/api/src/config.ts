import { config as loadDotenv } from 'dotenv';
import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

const projectRoot = resolve(__dirname, '../../..');

function loadAppEnv() {
  const envPaths = [resolve(process.cwd(), '.env'), resolve(projectRoot, '.env')];
  const seen = new Set<string>();
  for (const path of envPaths) {
    if (!seen.has(path) && existsSync(path)) {
      loadDotenv({ path });
      seen.add(path);
    }
  }
}

function resolveDataDir(value: string): string {
  return isAbsolute(value) ? value : resolve(projectRoot, value);
}

loadAppEnv();

export interface AppConfig {
  host: string;
  port: number;
  dataDir: string;
  webOrigin: string;
  llmProvider: 'mock' | 'openai-compatible';
  openaiBaseURL: string;
  openaiApiKey: string;
  openaiModel: string;
  ragProvider: 'local' | 'http' | 'tonglingyu';
  ragBaseURL: string;
  ragApiKey: string;
  ragSearchPath: string;
  ragRefsPath: string;
  ragTimeoutMs: number;
}

function getRagProvider(): AppConfig['ragProvider'] {
  const provider = (process.env.RAG_PROVIDER ?? '').toLowerCase();
  if (provider === 'tonglingyu' || provider === 'knownledge' || provider === 'tonglingyu-knownledge') return 'tonglingyu';
  if (provider === 'http' || process.env.RAG_BASE_URL) return 'http';
  return 'local';
}

export function getConfig(): AppConfig {
  const ragProvider = getRagProvider();
  return {
    host: process.env.HOST ?? '0.0.0.0',
    port: Number(process.env.PORT ?? 8787),
    dataDir: resolveDataDir(process.env.DATA_DIR ?? '.data'),
    webOrigin: process.env.WEB_ORIGIN ?? 'http://localhost:5173',
    llmProvider: process.env.LLM_PROVIDER === 'openai-compatible' ? 'openai-compatible' : 'mock',
    openaiBaseURL: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
    openaiApiKey: process.env.OPENAI_API_KEY ?? '',
    openaiModel: process.env.OPENAI_MODEL ?? 'gpt-4.1-mini',
    ragProvider,
    ragBaseURL: process.env.RAG_BASE_URL ?? '',
    ragApiKey: process.env.RAG_API_KEY ?? '',
    ragSearchPath: process.env.RAG_SEARCH_PATH ?? (ragProvider === 'tonglingyu' ? '/retrieve' : '/search'),
    ragRefsPath: process.env.RAG_REFS_PATH ?? process.env.RAG_BY_REFS_PATH ?? '/refs',
    ragTimeoutMs: Number(process.env.RAG_TIMEOUT_MS ?? 10000),
  };
}
