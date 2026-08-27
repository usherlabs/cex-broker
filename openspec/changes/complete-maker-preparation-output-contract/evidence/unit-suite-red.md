# Unit-suite RED evidence

- Recorded at: `2026-08-25T08:51:56Z`
- Branch: `ed/famous-sails-battle-fxc0c`
- Commit: `ae16314dabaf91f835a5af0ef6ff2344e8636356`
- Command: `bun test test`
- Command source: repository `package.json` script `test`
- Working directory: the `cex-broker` repository root
- Bun: `1.3.12` (`700fc117`)
- Node: `v22.22.2`
- npm: `10.9.7`
- Host: Linux x86_64, UTC
- External services and credentials: none required or supplied
- Dependency assumption: the command was run before a worktree-local frozen install; Bun resolved some packages from the parent checkout while the current lockfile dependencies `canonicalize@4.0.0`, `ajv@8.17.1`, and `hyparquet-writer@0.16.6` were absent from this worktree's `node_modules`.

## Result

- Exit code: `1`
- Tests: `753 passed`, `27 failed`, `25 errors`, `780 total`
- Assertions: `2,305 expect() calls`
- Duration: `20.83s`

The earliest unhandled failures were deterministic module-resolution errors:

- `Cannot find package 'canonicalize'` imported by `src/helpers/market-data-vendor-backfill/identity.ts`.
- `Cannot find module 'ajv/dist/2020.js'` imported by the market-data preparation contract codecs.
- `Cannot find package 'hyparquet-writer'` imported by `test/cryptohftdata-backfill-adapter.test.ts`.

The runner also reported the following explicit failed assertions after the
module-loading failures:

- `market-data vendor backfill package boundary > publishes a dedicated entrypoint without importing the broker server`
- `market-data vendor backfill package boundary > copies every manifest artifact and the golden fixtures into dist`

This is environment/package-install RED evidence. The GREEN record must use the
same command and toolchain after a frozen dependency install and after all
change-specific tests and implementation are complete.
