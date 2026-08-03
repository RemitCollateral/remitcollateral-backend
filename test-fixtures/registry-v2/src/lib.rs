#![no_std]
//! A stand-in "next release" of property-registry, used only by
//! `property-registry`'s upgrade tests.
//!
//! It is a separate crate so the tests install a genuinely different
//! executable. Re-installing the same wasm would exercise the plumbing but
//! prove nothing about whether v1's state is still readable.
//!
//! Everything here that mirrors v1 does so deliberately -- see UPGRADING.md.

use soroban_sdk::{contract, contractimpl, contracttype, Address, BytesN, Env};

pub const CONTRACT_VERSION: u32 = 2;

// Identical discriminants to v1. `#[contracttype]` enums with integer
// discriminants encode as ScVal::U32, so the numbers are what has to match --
// the variant *names* are free to change.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PropertyStatus {
    Pending = 0,
    Verified = 1,
    Tokenized = 2,
    Mortgaged = 3,
    Repaid = 4,
    Defaulted = 5,
}

// Field names and types match v1 exactly. Struct contract types encode as an
// ScMap keyed by field name, so names and types are load-bearing and field
// *order* is not.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PropertyInfo {
    pub title_hash: BytesN<32>,
    pub trustee: Address,
    pub survey_doc_hash: BytesN<32>,
    pub usdc_value: u128,
    pub status: PropertyStatus,
    pub token_address: Option<Address>,
}

// The same PropertyInfo with one extra field, to demonstrate the failure mode
// UPGRADING.md warns about: a v1-written entry has no `flood_zone` key, so
// decoding into this traps. Only reachable through `read_as_widened`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PropertyInfoWidened {
    pub title_hash: BytesN<32>,
    pub trustee: Address,
    pub survey_doc_hash: BytesN<32>,
    pub usdc_value: u128,
    pub status: PropertyStatus,
    pub token_address: Option<Address>,
    pub flood_zone: bool,
}

// Deliberately declared in a different order from v1, with an extra variant
// appended. Union contract types encode as an ScVec led by the variant name, so
// neither the ordering nor the addition affects how v1's keys decode -- the
// upgrade tests are what actually prove that.
#[contracttype(export = false)]
pub enum DataKey {
    Property(u64),
    PropertyCount,
    Admin,
    PendingAdmin,
    SchemaVersion,
}

#[contract]
pub struct PropertyRegistryV2;

#[contractimpl]
impl PropertyRegistryV2 {
    pub fn version(_env: Env) -> u32 {
        CONTRACT_VERSION
    }

    pub fn get_admin(env: Env) -> Address {
        env.storage().instance().get(&DataKey::Admin).unwrap()
    }

    pub fn get_pending_admin(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::PendingAdmin)
    }

    pub fn get_property(env: Env, property_id: u64) -> PropertyInfo {
        env.storage()
            .persistent()
            .get(&DataKey::Property(property_id))
            .unwrap()
    }

    // New in v2: v1 tracked the counter but never exposed it. Calling this
    // successfully is what proves the new executable is live, rather than the
    // old one still answering.
    pub fn get_property_count(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::PropertyCount)
            .unwrap_or(0)
    }

    // The safe way to add per-property state in a later version: a new key
    // alongside the existing record, not a new field inside it. Absent for
    // properties written by v1, which is a value the contract can handle rather
    // than a decode failure.
    pub fn get_schema_version(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::SchemaVersion)
            .unwrap_or(1)
    }

    pub fn set_schema_version(env: Env, schema: u32) {
        Self::get_admin(env.clone()).require_auth();
        env.storage()
            .instance()
            .set(&DataKey::SchemaVersion, &schema);
    }

    // The unsafe way, kept here so a test can assert it fails rather than
    // leaving UPGRADING.md's warning as an untested claim. Traps on any
    // v1-written entry.
    pub fn read_as_widened(env: Env, property_id: u64) -> PropertyInfoWidened {
        env.storage()
            .persistent()
            .get(&DataKey::Property(property_id))
            .unwrap()
    }

    // The escape hatch has to survive the upgrade, or v2 is the last version
    // this contract can ever run.
    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) {
        Self::get_admin(env.clone()).require_auth();
        env.deployer().update_current_contract_wasm(new_wasm_hash);
    }

    pub fn accept_admin(env: Env) {
        let storage = env.storage().instance();
        let pending: Address = storage.get(&DataKey::PendingAdmin).unwrap();
        pending.require_auth();
        storage.set(&DataKey::Admin, &pending);
        storage.remove(&DataKey::PendingAdmin);
    }
}
