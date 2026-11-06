# Wallet test pass: settlement orders (Settle tab)

A manual checklist for the repo owner to run with a **real wallet on the Stellar testnet**. Nothing in this
document has been run with a real wallet. Every Settle screen was driven only with a test stand-in that signs with
a throwaway key (see [What was and was not tested](#what-was-and-was-not-tested)); the table at the end is blank on
purpose.

The question this pass answers: **does each wallet show, sign and return a Soroban authorisation entry in the way
the app and the settlement contract assume?** The app verifies the signature locally before sending anything, so
a wallet that signs something else is caught and nothing is submitted, but only a real wallet can tell us how
the popup reads and whether the fill lands.

Testnet only. Use throwaway accounts. The settlement contract is unaudited; the solver in this prototype is a key
held in the harness process. Never point any of this at mainnet (the API refuses it, and so does the harness).

## What is being tested

A settlement order is signed as a Soroban **authorisation entry** (SEP-43 `signAuthEntry`), not as a transaction.
The user's account sends nothing and pays no fee; a solver submits `settle.fill(order)`.

Which wallets are expected to work (from the wallet kit's source, v2.7.0; none of it has been confirmed on a device):

| Wallet | Kit module id | App treats it as | Why |
|---|---|---|---|
| Freighter extension (renamed "Varial" in kit 2.8.0) | `freighter` | supported | the module calls Freighter's `signAuthEntry` |
| Freighter Mobile through WalletConnect | `wallet_connect` | unknown, try | depends on the wallet at the other end |
| Hana | `hana` | unknown, try | the module forwards the call; whether it signs the same bytes is unverified |
| xBull, Albedo, LOBSTR, Rabet | `xbull`, `albedo`, `lobstr`, `rabet` | unsupported | their kit modules reject with error code -3 |

"Unsupported" wallets get a plain message and no way to try. "Unknown" wallets can try, and if they answer -3 the app
says so; if they decline (-4) the app says so. Update `apps/web/src/lib/orderWallet.ts` with whatever this pass finds.

## Setup

You need: Node 22+, pnpm, the repo built, the Rust toolchain with the `stellar` CLI (to build the contract), and a
Freighter (or other) wallet.

1. **Build everything and the contract**

   ```sh
   pnpm install
   pnpm build
   cd contracts && stellar contract build --manifest-path settle/Cargo.toml && cd ..
   ```

2. **Switch the wallet to testnet and pick an account.** Freighter: Settings, Network, "Test Net". Use an account
   whose only purpose is this test. Copy its public `G...` address. The same key also exists on mainnet: do not
   sign anything on mainnet during this pass.

3. **Start the test harness in real-wallet mode** (it deploys a fresh settle contract, two test assets `SLFA` and
   `SLFC`, a market maker with offers for the solver to hedge into, and a solver; it serves the normal production
   build of the app with orders switched on). Use this machine's flag if IPv6 is broken: `SLUICE_IPV4_FIRST=1`.

   ```sh
   SLUICE_IPV4_FIRST=1 HARNESS_PORT=8788 \
   HARNESS_WEB_DIR="$PWD/apps/web/dist" \
   HARNESS_USER_ADDRESS=G...YOUR_TESTNET_ADDRESS \
   pnpm exec tsx apps/web/e2e/settle-testnet-harness.ts
   ```

   It prints `WAITING: ... add the asset SLFA with issuer G...`. In the wallet add that asset to the account
   (Freighter: Manage assets, "Add an asset manually", code `SLFA`, the issuer it printed; approve the trustline
   transaction). The harness notices, pays you 1000 SLFA, and prints `READY {...}` with the URL and asset ids.
   Setup takes a few minutes on a slow connection. Leave it running; it holds the solver key in memory only.

   `HARNESS_WEB_DIR` is the **production** build, so the page has no test wallet in it. Do not use
   `dist-testwallet` for this pass.

4. **Open the app** at the URL it printed, with the asset pair filled in:

   ```
   http://localhost:8788/#/settle?in=SLFA:<issuer>&out=SLFC:<issuer>
   ```

   (Use the asset ids from the `READY` line.) The Settle tab only exists because the server says orders are
   enabled. You should see the "Testnet prototype, unaudited" notice.

5. **WalletConnect only** (Freighter Mobile or any WalletConnect wallet): the app offers WalletConnect only when built
   with a Reown project id, and a session must be approved for the testnet chain up front:

   ```sh
   VITE_WALLETCONNECT_PROJECT_ID=<your id> VITE_WALLETCONNECT_TESTNET=1 pnpm --filter @sluice/web build
   ```

   then restart the harness (the build is served from disk). Connecting this way also asks the wallet to approve
   the testnet chain, which a mainnet-only deployment would not.

## Cases

Do them in order with one wallet, then repeat the signing cases for each further wallet. For each: take a screenshot
of the app and of the wallet popup, and fill the results table.

**C1. Connect.** Connect the wallet from the nav. Expect the Settle tab to be visible with a small amber dot.
For an unsupported wallet (xBull, Albedo, LOBSTR, Rabet): the action reads "Your wallet cannot sign orders" and a
note says "Your wallet cannot sign this kind of order yet. Use Freighter, or the standard swap." Nothing can be
prepared. **That ends the pass for that wallet.**

**C2. Price an order that needs a trustline.** Pay `100` SLFA, receive SLFC, press "Ask the solver for a price".
Expect a "Review the order" panel: you pay 100 SLFA, you receive at least a number a little over 100, the solver
expects to pay a bit more than that, a "Good until" time with a countdown, "Network fee to you: None", and an
amber note that signing also adds an SLFC trustline (0.5 XLM reserve). Expand "Raw values to compare" and write down
`amount_in` and `min_out`.

**C3. Sign it (the main test).** Press "Sign in wallet". In the wallet popup record:
- the title and button wording (expected: "Confirm Authorizations"; not "Confirm transaction");
- whether it says anything about a fee, and the network it names (expected: testnet);
- how the arguments appear: raw values? names? is `amount_in` equal to the `amount_in` the app showed? are the token
  and user addresses shown? does it show the nested `trust` and `transfer` calls?
- whether it warns about anything.
Approve. Expect: "Signed in your wallet", "Sent to the solver", "Waiting for the fill to settle", then "Order filled"
with the received amount (read from the ledger), a testnet StellarExpert link that opens the fill, and a hedge line that
ends as "The solver sold the asset you paid on the Classic order book" within about a minute. In the wallet, SLFA
should be down by exactly 100, SLFC up by exactly the shown amount, and no transaction should appear in the
account's history as sent by you (the fill is the solver's transaction).

**C4. The signature verified.** The app checks the signature against the order before sending. If it rejects the
wallet's answer you will see "Nothing was signed or sent" with one of: "the wallet's signature does not verify
against the order's preimage", "...is not 64 bytes", "the wallet signed with <other account>". Record the exact
text. A wallet that never shows this and fills is a pass.

**C5. A second order with no trustline.** Pay `10` SLFA. Expect no trustline note. Sign and fill as in C3.
(Confirms the order is built from the account's current state.)

**C6. Decline in the wallet.** Price another order, press "Sign in wallet", reject in the popup. Expect "You
declined the request in your wallet. Nothing was signed or sent." with the order still on screen and an
"Ask my wallet again" button that works. Record the wallet's error code if it is visible in the browser console
(expected -4). If the app instead shows a generic "Nothing was signed or sent" failure, the wallet reports a refusal
the app does not recognise: record the console error object.

**C7. Close the popup without answering.** Press "Sign in wallet", then dismiss or close the wallet window without
choosing. Expect the app to keep saying "Approve it in your wallet" with a "Stop waiting" button; press it. Expect
"You stopped waiting for the wallet" and nothing sent. Record whether the wallet reported anything by itself.

**C8. Expiry.** Price an order and do nothing. Expect the "Good until" countdown to reach zero and the panel to
change to "This order expired" with "Get a new price" (a new price means a new signature). Then: price an order, press
"Sign in wallet", leave the popup open past the deadline, approve it afterwards. Expect "This order expired" (while
the wallet was open) and **nothing sent**; if the app instead submits, record what the solver said. Orders last 10 minutes.

**C9. Too large for the book.** Pay `500` SLFA (more than the market maker's book is deep). Expect "No solver will
fill this order right now" with the reasons, and **no wallet popup at all**.

**C10. Account switch.** With a review on screen, switch the account inside the wallet. Expect the review to disappear
(the order belongs to the first account) and, if the wallet signs anyway, "the wallet signed with ..." rather than a
submission.

**C11. Unsupported-at-call (Hana, WalletConnect).** For a wallet the app marked "unknown": if its answer to the signing
request is "not supported" (code -3) expect "Your wallet cannot sign this kind of order yet", with a "Use the standard
swap" link and nothing sent. Record the wallet's own wording.

## What to record for each wallet

- Wallet, version, platform (and kit module id if you can see it).
- Screenshots: the app's review panel, the wallet popup (all of it, scrolled), the filled panel.
- The popup's exact title, button labels, and how the contract arguments were rendered.
- Whether the signature verified (C4), whether the fill landed (C3), the testnet transaction hash.
- The balance change in the wallet vs what the app said (C3).
- How the wallet refused and closed (C6, C7), including any console error object.
- What happened at expiry (C8).
- Anything alarming or misleading in the wallet's wording, especially if it implies you are sending a transaction,
  paying a fee, or that the amounts are different from the app's.

## Results

Fill one row per case per wallet. Pass means exactly as expected above. Do not fill it in from memory.

| Case | Wallet and version | Expected | Observed | Pass / Fail | Evidence (screenshot, tx hash) |
|---|---|---|---|---|---|
| C1 connect | | Settle tab shown; unsupported wallets blocked | | | |
| C2 review | | summary + trustline note | | | |
| C3 sign and fill | | "Confirm Authorizations"; fill lands; exact balances | | | |
| C4 signature verifies | | no local verification error | | | |
| C5 no-trustline order | | fills; no trustline note | | | |
| C6 decline | | "You declined the request in your wallet" | | | |
| C7 close popup | | "Stop waiting" works | | | |
| C8 expiry | | "This order expired"; nothing sent | | | |
| C9 too large | | declined with reasons; no popup | | | |
| C10 account switch | | review cleared or signer mismatch | | | |
| C11 unsupported at call | | "cannot sign this kind of order yet" | | | |

Wallet popup wording (copy it exactly):

| Wallet | Title | Buttons | How `amount_in` / `min_out` / addresses are shown | Mentions a fee? | Network named |
|---|---|---|---|---|---|
| Freighter | | | | | |
| Freighter Mobile (WalletConnect) | | | | | |
| Hana | | | | | |

## Reading the outcome

- C3 and C4 pass on a wallet: add its module id to `SUPPORTED` in `apps/web/src/lib/orderWallet.ts`, add it to
  the table above, and say which version you tested.
- A wallet that answers -3 at call time: move it to unsupported in the same file.
- A wallet whose popup shows the raw arguments and nothing else: that is expected today. The app's own review panel is
  the readable summary; the popup is the cross-check. If a wallet shows nothing useful at all, note it: users cannot
  verify what they sign there.
- The fill landing but "Received" differing from the wallet's balance change is a bug in the app or contract: stop and report it.

## What was and was not tested

Before this pass, the Settle flow was driven in a real browser against the real testnet (real contract, real
solver, real fills and hedges) with a **test-only wallet stand-in**: a build of the app made with
`SLUICE_TEST_WALLET=1` that, when opened with `?testwallet=<module id>`, replaces the wallet with a small shim that
sends the preimage to a local harness, which signs `sha256(preimage)` with a throwaway key. That exercises the app's
state machine, its local signature verification, the API, the contract and the hedge. It says **nothing** about any
real wallet's popup, its error codes, or whether a real wallet signs the same bytes. That is what this pass is for.

The shim cannot reach a production build: it is imported only behind a build-time constant that is false unless
`SLUICE_TEST_WALLET=1` is set, so the bundler removes it (check: `grep -rl "__test/wallet" apps/web/dist` finds
nothing), and even a test build does nothing without `?testwallet=` in the URL.
