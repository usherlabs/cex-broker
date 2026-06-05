# cex-broker-server-modularization

Establish canonical `src/helpers/` and `src/handlers/` layout, extract `server.ts` helpers, deduplicate shared primitives, and shrink `server.ts` to gRPC wiring and dispatch only.