# Synthetic Node HTTP deployment fixture

Use `entrypoint=server.cjs`, `healthPath=/health`, no install/build. Optional task-only PostgreSQL verifies a real TCP connection; this is a deployment health fixture, not a real business PRD or SQL application acceptance. Platform credentials must not be inherited.
