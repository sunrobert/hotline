# Hotline

**A voice agent on Arc that calls you before it spends.**

UBC 2026 Hackathon · Agentic Payments & AI · Arc testnet · built Nov 12–20, 2026

Hotline is an onchain agent you reach by phone. It holds USDC on Arc and acts within limits you set. Small sends go through. Anything over your threshold needs a spoken yes and a PIN. Anything over your caps is refused, and it tells you which rule stopped it. When money lands in its wallet and your standing rule says act, it calls *you* and waits for a yes before it moves anything.

The phone call is the guardrail.

> **Status: in progress.** The decision loop, policy engine, ledger, tool API, and Arc wallet are built and tested. The voice agent, outbound approval calls, the onchain deposit trigger, the dashboard, and the iMessage channel are next. This README is updated as each piece lands. Planning docs: [UBC-Hackathon-2026](https://github.com/sunrobert/UBC-Hackathon-2026).

## The decision loop

```
intent ──> normalize ──> policy ──┬─ AUTO  ──> send now ──────────────────┐
(voice, text,            (pure,   ├─ CALL  ──> wait for spoken yes + PIN ─┼─> ledger row
 or a deposit)            ordered)└─ BLOCK ──> do nothing, name the rule ─┘   (always)
```

1. **Intent arrives.** A spoken command through a tool call, a text, or an onchain deposit.
2. **Normalize** to an action: kind, recipient label, amount in micro-USDC.
3. **Policy** ([`src/policy.ts`](src/policy.ts)) runs its rules in a fixed order. The first match wins, so every decision names exactly one rule.
4. **Act.** `AUTO` broadcasts immediately. `CALL` waits as `pending` for the owner's voice. `BLOCK` does nothing.
5. **Record.** Every path writes a ledger row: source, caller, conversation, decision, rule, lifecycle status, transaction hash.

### Policy rules, in order

| # | Condition | Decision | Rule name |
|---|---|---|---|
| 1 | Agent is paused | BLOCK | `paused` |
| 2 | Amount is not a positive number | BLOCK | `invalid_amount` |
| 3 | Recipient is not an allowlist label | BLOCK | `not_allowlisted` |
| 4 | Amount over the per-transaction cap | BLOCK | `per_tx_cap` |
| 5 | Would pass the daily cap | BLOCK | `daily_cap` |
| 6 | Would leave less than the gas reserve | BLOCK | `gas_reserve` |
| 7 | Nobody asked for it (it came from an onchain event) | CALL | `stream_source` |
| 8 | Amount over the auto-approve threshold | CALL | `approval_threshold` |
| 9 | Otherwise | AUTO | `auto` |

Blocks are checked before approvals, so an over-cap amount can never be talked through.

## Safety limits

- **Per-transaction cap, daily cap, gas reserve.** Enforced in the backend on every proposal and again at confirmation.
- **Allowlist by label.** The agent can only name recipients by label. A raw address is refused, even one that belongs to an allowlisted label. Labels are set in config, never by voice.
- **Spoken approval plus PIN** for anything over the threshold or not requested by the owner. One retry on a wrong PIN, then the action is cancelled. The PIN is compared on digits only, in constant time.
- **Owner gate.** Tool calls must carry a shared secret and come from a conversation with an owner number: the caller on inbound calls, the called party on outbound ones.
- **Confirmation binds to the conversation.** A yes can only execute the action proposed or presented on that same call. It cannot reach an action from another call.
- **Never more than you heard.** If the balance grows while an approval call is in progress, the yes still sends at most the amount that was read out. The remainder gets its own call.
- **Money is never promised twice.** Funds committed to a pending or in-flight action are subtracted before any new decision.
- **Re-checked at confirm time.** Pause the agent, or let the balance drop, after the question was asked, and the yes no longer executes.
- **Expiry.** A pending action nobody decides within ten minutes expires.
- **Idempotent confirmation.** A repeated yes returns the original result. It does not send twice.
- **Fails closed on restart.** An action interrupted before broadcast is marked failed and is never re-sent.
- **Pause by voice, unpause only from the dashboard.** There is no tool for changing rules or unpausing.
- **Deduplicated deposits.** A deposit log is keyed on transaction hash and log index, so at-least-once delivery from two sources produces one action.

### Known limitations

- Caller ID can be spoofed. The PIN mitigates this; it does not eliminate it.
- The PIN is spoken aloud. Rotate it after a live demo.
- The backend holds the agent's key. This is a testnet demo wallet, not a custody design.
- Circle's hosted spending policies do not enforce on testnet, so the limits above live in this backend.

## How it uses Arc

- **USDC is the native asset and the gas token.** A transfer is a plain value send, and fees are paid in the same USDC the agent is managing. The gas reserve rule exists because of this.
- **Deposit detection uses Arc's native Transfer events.** Arc logs every USDC movement as an ERC-20 `Transfer` from a system address (EIP-7708). Hotline filters on that one emitter. Filtering on the ERC-20 contract instead would miss native sends and double-count ERC-20 ones.
- **Two decimal scales.** Native values are 18 decimals; the ERC-20 view is 6. Hotline works in integer micro-USDC and floors on the way in, so it never credits more than arrived.
- **20 gwei fee floor.** Arc's mempool silently drops transactions priced under it. Every send goes through a floor ([`src/wallet/fees.ts`](src/wallet/fees.ts)).
- **Deterministic finality.** One confirmation is final, which is what lets the agent say "done" on the call.

| What | Address (Arc testnet, chain ID 5042002) |
|---|---|
| USDC system event emitter (deposit trigger) | `0xffffFFFfFFffffffffffffffFfFFFfffFFFfFFfE` |
| USDC ERC-20 interface (not used for detection) | `0x3600000000000000000000000000000000000000` |
| Agent wallet | `0x354ea63B9120b9d98fd8FbD18145055561EFBa9D` |

Explorer: https://explorer.testnet.arc.io

## Layout

| Path | What |
|---|---|
| `src/policy.ts` | The rules. Pure, no I/O. |
| `src/engine.ts` | The decision loop: propose, confirm, deposits, sweep, expiry, recovery. |
| `src/ledger.ts` | SQLite ledger of every decision. |
| `src/sweep.ts` | The standing rule: keep a threshold on hand, sweep the rest. |
| `src/server.ts` | HTTP tool endpoints for the voice agent, with the owner gate. |
| `src/wallet/arc.ts` | Arc testnet wallet through viem. |
| `src/config.ts` | Environment to typed config. Refuses to boot on a bad limit. |
| `test/` | Unit tests for all of the above. |

## Run it

Needs Node 24 or newer. No build step: Node runs the TypeScript directly.

```bash
npm install
npm run setup      # writes .env.local with fresh TESTNET keys, a PIN, and secrets
npm run chain      # read-only check of Arc testnet and the demo wallets
npm run check      # typecheck + tests
npm start          # after setting OWNER_NUMBERS in .env.local
```

Fund the `sender` and `agent` addresses with testnet USDC at https://faucet.circle.com (network: Arc Testnet).

## Tool API

`POST /tools/<name>` with header `X-Hotline-Secret` and a JSON body that includes `caller_id`, `called_number`, and `conversation_id`.

| Tool | Does |
|---|---|
| `get_status` | Balance, pause flag, pending actions, recent history |
| `get_rules` | Limits and recipient labels. Never addresses. |
| `propose_action` | `to_label`, `amount_usdc`. Returns AUTO, CALL, or BLOCK with the rule. |
| `confirm_action` | `approved`, `pin`. Acts on the action bound to this conversation. |
| `get_action_status` | Where the latest action on this call stands |
| `pause` | Stops everything |
