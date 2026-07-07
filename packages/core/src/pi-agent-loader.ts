import type { Agent, AgentOptions } from '@earendil-works/pi-agent-core';

type PiAgentCoreModule = typeof import('@earendil-works/pi-agent-core');
type NativeImporter = (specifier: string) => Promise<PiAgentCoreModule>;

const nativeImport = new Function('specifier', 'return import(specifier)') as NativeImporter;

export async function loadPiAgentCore(): Promise<PiAgentCoreModule> {
  return nativeImport('@earendil-works/pi-agent-core');
}

export async function createPiAgent(options?: AgentOptions): Promise<Agent> {
  const { Agent: PiAgent } = await loadPiAgentCore();
  return new PiAgent(options);
}
