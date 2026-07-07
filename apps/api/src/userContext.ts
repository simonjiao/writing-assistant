import { FastifyRequest } from 'fastify';

export interface UserContext {
  userId: string;
}

export function resolveUserContext(request: FastifyRequest, explicitUserId?: string): UserContext | undefined {
  const userId = normalizeUserId(explicitUserId)
    ?? normalizeUserId(readHeader(request, 'x-user-id'))
    ?? normalizeUserId(readHeader(request, 'x-wa-user-id'));
  return userId ? { userId } : undefined;
}

export function normalizeUserId(value: string | undefined): string | undefined {
  const userId = value?.trim();
  return userId || undefined;
}

function readHeader(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  if (Array.isArray(value)) return value[0];
  return value;
}
