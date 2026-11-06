## What and why

<!-- One or two sentences. Link the issue: "Closes #123". -->

## How I checked it

- [ ] `pnpm build`, `pnpm typecheck` and `pnpm test` pass
- [ ] `cargo test` passes (only if `contracts/` changed)
- [ ] `pnpm e2e` passes (only if `apps/web` changed)
- [ ] I added or updated tests for this change

<!-- If this changes how a transaction is built or a route is ranked, paste the evidence:
     a mainnet simulation, a testnet hash, or probe output. "It should work" is not evidence. -->

## Checklist

- [ ] One issue, one change; no unrelated refactors
- [ ] README statements still match what the code does (or I updated them)
- [ ] No keys, `.env` files, `dist/` or `target/` committed
- [ ] The server still never signs or holds a key
- [ ] Code copied from other projects is MIT-compatible (none from GPL projects such as Phoenix)
