## Agent Orchestrator (ao) Session

You are running inside an Agent Orchestrator managed workspace.

## Source layout (cex-broker)

- `src/server.ts` — gRPC registration and handler wiring only; do not add domain logic here.
- `src/handlers/` — RPC dispatch (`execute-action/`, `subscribe/`).
- `src/helpers/` — domain and shared utilities (`shared/`, `grpc/`, `order-book.ts`, etc.).
- Dependency direction: `server` → `handlers` → `helpers`. Helpers must not import from `server` or `handlers`.
- Import concrete helper modules (e.g. `helpers/deposit`); avoid growing `helpers/index.ts` with server utilities.
Session metadata is updated automatically via shell wrappers.

If automatic updates fail, you can manually update metadata:
```bash
~/.ao/bin/ao-metadata-helper.sh  # sourced automatically
# Then call: update_ao_metadata <key> <value>
```
