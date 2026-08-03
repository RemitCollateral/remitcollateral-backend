# Upgrading a deployed contract

`property-registry` and `mortgage-pool` can have their executable replaced in
place. The contract address, its balances, and every ledger entry it owns are
untouched — only the code changes.

```rust
pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>)
```

## Authorization

`upgrade` calls `require_auth()` on the stored admin, and that is the whole
model. Soroban binds the resulting authorization to *this* contract, *this*
function, and *these* arguments, so an admin signature approving one wasm hash
cannot be replayed to install a different one. There is no separate nonce or
allow-list to maintain.

The swap takes effect only after the invocation finishes successfully. A panic
anywhere in the same transaction leaves the old code in place.

## Running an upgrade

```sh
make build

# 1. Upload the new wasm and keep the hash it returns.
stellar contract upload \
  --source-account $ADMIN \
  --network $NETWORK \
  --wasm target/wasm32v1-none/release/property_registry.wasm

# 2. Install it on the live contract.
stellar contract invoke \
  --source-account $ADMIN \
  --network $NETWORK \
  --id $CONTRACT_ID \
  -- upgrade --new_wasm_hash $WASM_HASH

# 3. Confirm which executable is now live.
stellar contract invoke --id $CONTRACT_ID --network $NETWORK -- version
```

Bump `CONTRACT_VERSION` in the contract source whenever you cut a release, so
step 3 tells you something. The code hash alone does not.

## Storage compatibility

This is where upgrades go wrong. Existing entries are **not** migrated or
re-encoded — the new code simply starts reading bytes the old code wrote. How a
type is encoded therefore decides what you may change.

| Contract type | Encoding | Safe to change | Breaks decoding |
|---|---|---|---|
| `struct` | `ScMap` keyed by field name | reorder fields | add, remove, or rename a field; change a field's type |
| `enum` with variants | `ScVec` led by the variant name | reorder variants; add new variants | rename a variant; change a variant's payload |
| `enum` with integer discriminants | `ScVal::U32` | rename variants | change a discriminant's value |

Two consequences worth internalising:

- **Adding a field to a stored struct is a breaking change.** A `PropertyInfo`
  written by v1 has no key for a field v2 introduced, so decoding traps — on
  every read, for every pre-existing record.
  `adding_a_field_to_a_stored_struct_breaks_decoding` asserts exactly this
  rather than leaving it as a claim in a document.

- **Adding a new storage key is not.** Give new state its own `DataKey` variant
  and read it with a default:

  ```rust
  env.storage().instance().get(&DataKey::Paused).unwrap_or(false)
  ```

  Entries written before the key existed simply aren't there, which is a value
  the contract can handle rather than a decode failure.

If you genuinely must change a stored struct's shape, read it under the old
type, write it under the new one, and gate that behind a one-shot `migrate`
entry point — do not let the two shapes coexist behind the same key.

`mortgage-pool` keeps `PendingAdmin` in its own key rather than as a field on
`Config` for this reason: `Config` is read on every entry point, so it is the
shape most expensive to churn.

## Admin handover

Handover is two-step — `propose_admin`, then `accept_admin` signed by the
incoming address.

This matters more than it looks. `upgrade` is the only way to fix a bug in
deployed code, and it is gated on the admin. Setting the admin to an address
nobody can sign for would freeze the contract at its current executable
**permanently**, with no recovery path. Requiring the incoming admin to accept
proves the key works before the old one gives it up.

`cancel_admin_proposal` withdraws a pending proposal. A proposal in flight
survives an upgrade, so an upgrade cannot be used to quietly drop one.

## Testing an upgrade before you ship it

`test-fixtures/registry-v2` and `test-fixtures/pool-v2` are stand-in "next
release" builds compiled to their own wasm. The upgrade tests install them
through the real `upgrade` entry point and then read v1-written state back
through the new code — the same path a mainnet upgrade takes.

When you change a stored type, add a case there first. A test that installs the
same wasm over itself exercises the plumbing and proves nothing about whether
your state still decodes.

```sh
make test
```
