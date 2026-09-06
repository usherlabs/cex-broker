# Repository guidance

## Source layout (cex-broker)

- `src/server.ts` — gRPC registration and handler wiring only; do not add domain logic here.
- `src/handlers/` — RPC dispatch (`execute-action/`, `subscribe/`).
- `src/helpers/` — domain and shared utilities (`shared/`, `grpc/`, `order-book.ts`, etc.).
- Dependency direction: `server` → `handlers` → `helpers`. Helpers must not import from `server` or `handlers`.
- Import concrete helper modules (e.g. `helpers/deposit`); avoid growing `helpers/index.ts` with server utilities.
- Hard cutover rule: when an internal contract is superseded, delete its obsolete implementation, writer, reader, schema alias, compatibility view, adapter, package surface, and active documentation. A compatibility exception requires an explicit operator decision naming the owner, bounded lifetime, and removal condition.

## Portable documentation and comments

- Keep repository documentation and code comments independent of any contributor's machine, operating-system account, agent harness, or private work-tracking setup.
- Use repository-relative paths, explicitly documented placeholders, and portable commands instead of personal absolute paths, local orchestration scripts, or agent-session instructions.
- Describe work by its feature or contract. Do not include private task-tracker names or task identifiers in documentation or code comments; use public pull requests, commit revisions, or release references when traceability is needed.
- Keep machine-specific setup, session metadata, and private work records outside the repository. Preserve technical requirements and verification evidence without making their use depend on those local records.
