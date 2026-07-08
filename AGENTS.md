# Agent Instructions

This file applies to the whole repository.

## Primary Rules

- Follow `docs/engineering-guidelines.md` before making code changes.
- Keep the monorepo dependency direction intact:
  - `apps/web` calls `apps/api` over HTTP.
  - `apps/api` depends on `packages/core` and `packages/workflows`.
  - `packages/workflows` depends on `packages/core`.
  - `packages/core` must not depend on apps or framework adapters.
- Apply the file-splitting rules in `docs/engineering-guidelines.md` when a file becomes too heavy.

## Layer References

- Product and architecture: `docs/product-definition.md`, `docs/product-architecture.md`, `docs/technical-architecture.md`
- Target pi-agent workflow runner redesign: `docs/pi-agent-workflow-runner-design.md`
- Target pi-agent unified runtime redesign: `docs/pi-agent-unified-runtime-design.md`
- API layer: `docs/modules/api.md`
- Frontend layer: `docs/modules/frontend.md`
- Workflow layer: `docs/modules/workflow.md`
- Runtime and workflow context: `docs/modules/agent-runtime.md`, `docs/modules/prompt-programs-context.md`
- Stores: `docs/modules/stores.md`
- Deployment and testing: `docs/deployment-testing.md`

## Local Runtime

- Use Node.js 22.x. Run `nvm use` before local project commands.
- Use one fixed local runtime path: `npm run local:start`, `npm run local:status`, `npm run local:stop`, and `npm run local:restart`.
- Use target-specific restarts with npm argument forwarding, for example `npm run local:restart -- api` or `npm run local:restart -- web`.
- Do not start project services with ad hoc `npm run start`, `npm run dev`, `nohup`, manual PID management, or temporary `launchctl submit` commands.
- Local runtime logs must stay under `.data/logs/`.
- Redis is not part of the workflow runtime. Do not add workflow queue toggles or worker switches; pi-agent owns progression inside the API process.
- Do not commit `.env`, `.data`, `dist`, `dist-ts`, `node_modules`, or generated runtime data.
