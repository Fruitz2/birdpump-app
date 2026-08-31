# PumpBird launch runbook

Everything needed to go from "the token does not exist" to "a player can pay $1 and play".
Written 2026-08-31.

## How the $1 actually works

The player pays in **$PUMPBIRD, not SOL**. The dollar is a USD *target* converted to a token
amount at the live price when they click.

They still need a little SOL, but only for the Solana network fee, roughly 0.000005 SOL.

1. `/api/entry/quote` reads the **pump.fun bonding curve directly over RPC** and combines it
   with SOL/USD from Birdeye to price 1 $PUMPBIRD in dollars. Once the curve graduates it falls
   back to Birdeye's direct token price, which is why `BIRDEYE_API_KEY` is not optional.
2. `/api/entry/create` locks a target amount with a slippage band, issues a unique memo
   (`bp:xxxxxxxx`) and a 15 minute ticket.
3. The browser builds ONE transaction: create the player's token account if missing, transfer
   the quoted amount to the treasury token account, attach the memo.
4. `/api/entry/confirm` fetches that signature, computes the **treasury token account balance
   delta**, and checks the wallet signed it, the memo matches, and the amount is inside the
   band. Then it grants the lives.
5. The entry is split `BURN_CUT_BPS` (default 2500) → 25% burn treasury, 75% pot.

The split is **accounting, not two transfers**. Every token sits in one treasury account and
the database tracks how much of it is pot and how much is the buyback and burn reserve. There
is no `Burn` instruction anywhere in this repo. If the marketing says tokens were burned,
somebody has to actually go and burn them.

## The one command

```bash
npm run launch -- <CONTRACT_ADDRESS>
```

It reads the mint off chain rather than trusting anything typed at it, and it is safe to run
as many times as you like. In order it:

1. Confirms the mint exists and is an initialised token mint
2. **Detects which token program owns it** and sets `PUMPBIRD_TOKEN_PROGRAM` accordingly
3. Reads the Token-2022 extension list and fails if the mint has a transfer fee, a transfer
   hook or a permanent delegate, because none of those are supported by the payment path
4. Reads the real `decimals` off the mint instead of assuming 6
5. Reads the bonding curve and reports how much SOL is in it
6. Fetches SOL/USD and warns loudly if it is falling back to the hardcoded constant
7. **Quotes a real dollar** and prints how many tokens that is
8. Checks the treasury has enough SOL for payout fees and winner account rent
9. **Creates the treasury token account** if it is missing (idempotent, safe to repeat)
10. Prints the exact environment variables to set

`npm run launch:check -- <CA>` does all of the above read only and creates nothing.

Then, after setting the env vars and redeploying:

```bash
npm run launch:verify
```

That talks to the deployed site over HTTP exactly the way a player's browser does, so it
catches the failure local checks cannot: variables set in the wrong scope, or set and never
redeployed. It passes only when production quotes a real dollar with a real mint, a real
treasury and a real token account.

## Why the token program check exists

**pump.fun issues Token-2022 mints, not classic SPL Token.** Verified 2026-08-31 against three
live pump.fun mints, all owned by `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`.

The token program id is one of the seeds in an associated token account address. Deriving with
the wrong program does not throw, it produces a **different, valid looking address that nobody
owns**. Before this was fixed, every payment would have been built against an account that does
not exist, and the confirm route would have been watching an account that never moved.

The proof is in `tests/token-program.test.ts`: the Token-2022 derived address for a real mint
exists on chain with the expected owner and mint, and the classic derived address for the same
pair does not exist at all.

## Environment variables

Set these after running `npm run launch`, which prints them filled in:

| Variable | Notes |
|---|---|
| `PUMPBIRD_TOKEN_MINT` | the CA |
| `PUMPBIRD_TOKEN_DECIMALS` | read off the mint, do not guess |
| `PUMPBIRD_TOKEN_PROGRAM` | `token2022` for any pump.fun launch |
| `NEXT_PUBLIC_TREASURY_ADDRESS` | must match `TREASURY_SECRET_KEY`, which is checked at boot |
| `SLIPPAGE_BPS` | defaults to 1000. See below before lowering it |

Already required and unrelated to the token: `DATABASE_URL`, `KV_REST_API_URL`,
`KV_REST_API_TOKEN`, `TREASURY_SECRET_KEY`, `JWT_SECRET`, `HELIUS_API_KEY`, `BIRDEYE_API_KEY`.

## Why the slippage band defaults to 10%

The band is frozen when the ticket is created and checked when the payment is confirmed, and a
fresh pump.fun curve moves several percent in seconds. At the old 3% a player who took ninety
seconds to sign would land outside the band, their ticket would be marked `mispaid`, and their
tokens would already be in the treasury with nothing given back.

If that happens anyway:

```bash
npm run refund:list                 # every mispaid ticket
npm run refund:mispaid -- --all     # refund all of them
npm run refund:mispaid -- <TICKET>  # refund one
```

The refunded amount is read back off chain from the payment signature using the same verifier
the confirm route uses, never from anything a client claimed. The status flips to `refunded`
only after the transfer confirms, and only from `mispaid`, so two concurrent runs cannot pay
twice.

## Launch day order

1. Push and deploy the current `main`
2. Fund the treasury wallet with SOL. 0.2 is plenty
3. Launch the token on pump.fun
4. `npm run launch -- <CA>` and fix anything it flags
5. Set the printed environment variables and redeploy
6. `npm run launch:verify`
7. **Buy one life with a real wallet and play it.** Nothing before this proves the end to end
   flow, because the flow cannot exist until the mint does
8. Announce

## Known gaps, stated plainly

- The 25% burn reserve is a database number. Burning it is a manual job.
- No automated test covers payment verification, the split or settlement. The 23 that exist
  cover the simulator, SIWS and the token program derivation.
- `npm run launch` needs `TREASURY_SECRET_KEY` in the local environment to check the treasury
  and create its token account. Everything before that step runs without it.
