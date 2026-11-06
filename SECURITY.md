# Security policy

Sluice builds transactions that people sign with their own wallets on Stellar mainnet. The server never signs and never holds a key, but a bug in how a transaction is built, ranked or relayed can still cost a user money. Please report problems privately.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting: open the repository's **Security** tab and choose **Report a vulnerability**. Do not open a public issue or pull request for a security problem.

Include what you found, the smallest way to reproduce it (a request, a transaction, a test), and what you think the impact is. A working proof against testnet or a mainnet *simulation* is ideal. Please do not send real mainnet transactions to demonstrate a problem.

You can expect an acknowledgement within a few days. This is a small open-source project, so fixes are made on a best-effort basis, but a confirmed issue that can lose user funds is handled first.

## What is in scope

- `/v1/build` producing a transaction that does something other than what the route and review screen show (wrong venue, recipient, amount, or minimum output).
- Minimum-output (slippage) guards that are missing, wrong, or bypassable.
- `/v1/submit` relaying something it should refuse (unsigned, multi-operation or fee-bump envelopes).
- Anything that would make the server hold, request or log a private key or a signature it should not see.
- Cross-site scripting, request forgery, or missing security headers in the web app or API.
- Server-side request forgery or denial of service through the API's outbound calls.
- Flaws in `contracts/router` (below).

## Known limits, not vulnerabilities

- **The Sluice router contract is unaudited and not deployed on mainnet.** It is deployed on testnet only. Leave `SLUICE_ROUTER_CONTRACT` unset on mainnet. Reports about the contract are welcome and in scope; the missing audit alone is not a finding.
- Cross-layer routes are two transactions and are not atomic (a Soroban transaction holds one operation). If the second does not go through the user holds the intermediate asset. This is documented behaviour.
- Mainnet execution through Sluice has not yet been recorded for every venue (see "Verified on real chains" in the README).
- The public RPC endpoint has unknown rate limits.
- Third-party venues (Aquarius, Soroswap, Phoenix, Comet, Blend) and wallets have their own security policies. Report issues in those to their maintainers.

## Supported versions

Only the latest commit on `main` is supported. There are no tagged releases yet.

## Safe harbour

Good-faith research that follows this policy, avoids other people's funds and data, and gives us reasonable time to fix before disclosure will not be pursued.
