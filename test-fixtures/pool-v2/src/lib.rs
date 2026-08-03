#![no_std]
//! A stand-in "next release" of mortgage-pool, used only by `mortgage-pool`'s
//! upgrade tests. See test-fixtures/registry-v2 for the rationale.

use soroban_sdk::{contract, contractimpl, contracttype, Address, BytesN, Env};

pub const CONTRACT_VERSION: u32 = 2;

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LoanStatus {
    Active = 0,
    Repaid = 1,
    Defaulted = 2,
}

// Field names and types match v1 exactly.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LoanInfo {
    pub borrower: Address,
    pub principal: u128,
    pub interest_rate_bps: u32,
    pub amount_repaid: u128,
    pub collateral_amount: u128,
    pub status: LoanStatus,
    pub property_id: u64,
}

// This is why the pool keeps `PendingAdmin` out of `Config`: the four addresses
// here are read on every entry point, so `Config` is the shape most likely to
// be depended on across versions and the least worth churning.
#[contracttype(export = false)]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    pub admin: Address,
    pub usdc_token: Address,
    pub pool_token: Address,
    pub property_registry: Address,
}

// Reordered relative to v1, with an extra variant, for the same reason as
// registry-v2's DataKey.
#[contracttype(export = false)]
pub enum DataKey {
    Loan(u64),
    Collateral(u64),
    PendingAdmin,
    Config,
    Paused,
}

#[contract]
pub struct MortgagePoolV2;

#[contractimpl]
impl MortgagePoolV2 {
    pub fn version(_env: Env) -> u32 {
        CONTRACT_VERSION
    }

    pub fn get_admin(env: Env) -> Address {
        Self::config(&env).admin
    }

    pub fn get_usdc_token(env: Env) -> Address {
        Self::config(&env).usdc_token
    }

    pub fn get_pool_token(env: Env) -> Address {
        Self::config(&env).pool_token
    }

    pub fn get_property_registry(env: Env) -> Address {
        Self::config(&env).property_registry
    }

    pub fn get_pending_admin(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::PendingAdmin)
    }

    pub fn get_loan(env: Env, property_id: u64) -> LoanInfo {
        env.storage()
            .persistent()
            .get(&DataKey::Loan(property_id))
            .unwrap()
    }

    pub fn get_locked_collateral(env: Env, property_id: u64) -> u128 {
        env.storage()
            .persistent()
            .get(&DataKey::Collateral(property_id))
            .unwrap_or(0)
    }

    // New in v2: a pause switch, stored under a key v1 never wrote. Reading it
    // as `false` by default is what makes adding state to a live contract safe.
    pub fn is_paused(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
    }

    pub fn set_paused(env: Env, paused: bool) {
        Self::config(&env).admin.require_auth();
        env.storage().instance().set(&DataKey::Paused, &paused);
    }

    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) {
        Self::config(&env).admin.require_auth();
        env.deployer().update_current_contract_wasm(new_wasm_hash);
    }
}

impl MortgagePoolV2 {
    fn config(env: &Env) -> Config {
        env.storage().instance().get(&DataKey::Config).unwrap()
    }
}
