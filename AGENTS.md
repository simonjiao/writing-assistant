# Agent Instructions

This file applies to the whole repository.

## Primary Rules

- Follow `docs/engineering-guidelines.md` before making code changes.
- Keep the monorepo dependency direction intact:
  - `apps/web` calls `apps/api` over HTTP.
  - `apps/api` depends on `packages/core` and `packages/skills`.
  - `packages/skills` depends on `packages/core`.
  - `packages/core` must not depend on apps or framework adapters.
- Apply the file-splitting rules in `docs/engineering-guidelines.md` when a file becomes too heavy.

## Layer References

- Product and architecture: `docs/product-definition.md`, `docs/product-architecture.md`, `docs/technical-architecture.md`
- API layer: `docs/modules/api.md`
- Frontend layer: `docs/modules/frontend.md`
- Workflow layer: `docs/modules/workflow.md`
- Runtime and skills context: `docs/modules/agent-runtime.md`, `docs/modules/skills-context.md`
- Stores: `docs/modules/stores.md`
- Deployment and testing: `docs/deployment-testing.md`

## Local Runtime

- Use Node.js 22.x. Run `nvm use` before local project commands.
- Do not commit `.env`, `.data`, `dist`, `dist-ts`, `node_modules`, or generated runtime data.
