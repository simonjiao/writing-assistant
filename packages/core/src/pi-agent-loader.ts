import type { Agent, AgentOptions } from '@earendil-works/pi-agent-core';

type PiAgentCoreModule = typeof import('@earendil-works/pi-agent-core');
type PiAiModule = typeof import('@earendil-works/pi-ai');
type NativeImporter = (specifier: string) => Promise<PiAgentCoreModule>;
type NativePiAiImporter = (specifier: string) => Promise<PiAiModule>;

const nativeImport = new Function('specifier', 'return import(specifier)') as NativeImporter;
const nativePiAiImport = new Function('specifier', 'return import(specifier)') as NativePiAiImporter;

export async function loadPiAgentCore(): Promise<PiAgentCoreModule> {
  return nativeImport('@earendil-works/pi-agent-core');
}

export async function loadPiAi(): Promise<PiAiModule> {
  return nativePiAiImport('@earendil-works/pi-ai');
}

export async function createPiAgent(options?: AgentOptions): Promise<Agent> {
  const { Agent: PiAgent } = await loadPiAgentCore();
  return new PiAgent(options);
}
