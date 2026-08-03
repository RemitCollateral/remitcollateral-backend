#![no_std]
use soroban_sdk::{
    contract, contractclient, contracterror, contractevent, contractimpl, contracttype,
    panic_with_error, token, Address, Env,
};

// The slice of PropertyRegistry this pool actually calls.
//
// This replaces `contractimport!`, which read the registry's compiled `.wasm`
// off disk at macro-expansion time. That created a build ordering cargo could
// not see (a cold workspace build raced and failed) and pulled the registry's
// entire type spec -- every struct, enum and entry point, including ones the
// pool never touches -- into this contract's spec section.
//
// `status` is declared `u32` here while the registry declares it as
// `PropertyStatus`. A `#[contracttype]` enum with integer discriminants is
// encoded as `ScVal::U32`, so the two are identical on the wire. The
// cross-contract test in `test.rs` drives this path against the real compiled
// registry and will fail loudly if that ever stops being true.
//
// Plain `//` comments, not `///`: rustdoc comments on public contract items are
// embedded verbatim in the wasm's `contractspecv0` section.
#[contractclient(name = "RegistryClient")]
pub trait PropertyRegistryInterface {
    fn get_collateral_token(env: Env, property_id: u64) -> Address;
    fn get_underwriting(env: Env, property_id: u64) -> (Address, u128);
    fn update_status(env: Env, property_id: u64, status: u32);
}

// Discriminants of PropertyRegistry::PropertyStatus. Kept in sync by the
// cross-contract tests rather than by importing the enum.
const STATUS_MORTGAGED: u32 = 3;
const STATUS_REPAID: u32 = 4;
const STATUS_DEFAULTED: u32 = 5;

const INTEREST_RATE_BPS: u32 = 800; // 8%
const BPS_DENOMINATOR: u128 = 10_000;
const MAX_LTV_PCT: u128 = 70;

// See the note on PropertyRegistry's error enum -- integer codes rather than
// string panics.
#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    LoanNotFound = 3,
    LoanNotActive = 4,
    LoanNotDefaulted = 5,
    NoCollateral = 6,
    LtvExceeded = 7,
    AmountOverflow = 8,
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LoanStatus {
    Active = 0,
    Repaid = 1,
    Defaulted = 2,
}

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

// The four configured addresses in a single instance entry.
//
// They used to be four separate keys, so an entry point such as
// `issue_mortgage` paid three independent instance-storage reads -- each its
// own host call with its own key conversion -- to assemble state that never
// changes after initialisation. One key means one read, and every entry point
// below now loads it exactly once and passes it down.
#[contracttype(export = false)]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    pub admin: Address,
    pub usdc_token: Address,
    pub pool_token: Address,
    pub property_registry: Address,
}

// Internal storage shapes; see the note in property-registry.
#[contracttype(export = false)]
pub enum DataKey {
    Config,
    Loan(u64),       // property_id -> LoanInfo
    Collateral(u64), // property_id -> collateral amount, until the loan absorbs it
}

// Events. See the note in property-registry for why `data_format` is explicit
// and `export = false`. Type names stay within nine characters once
// snake_cased so the derived topic is a short symbol rather than one the host
// has to intern from linear memory.
#[contractevent(data_format = "single-value", export = false)]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Deposit {
    #[topic]
    pub investor: Address,
    pub usdc_amount: u128,
}

#[contractevent(data_format = "vec", export = false)]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CollLock {
    #[topic]
    pub property_id: u64,
    pub borrower: Address,
    pub token_amount: u128,
}

#[contractevent(data_format = "vec", export = false)]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MtgIssue {
    #[topic]
    pub property_id: u64,
    pub build_escrow: Address,
    pub principal: u128,
}

#[contractevent(data_format = "single-value", export = false)]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Repaid {
    #[topic]
    pub property_id: u64,
    pub usdc_amount: u128,
}

#[contractevent(data_format = "single-value", export = false)]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Defaulted {
    #[topic]
    pub property_id: u64,
    pub outstanding: u128,
}

#[contractevent(data_format = "vec", export = false)]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Liquidate {
    #[topic]
    pub property_id: u64,
    pub liquidator: Address,
    pub remaining_debt: u128,
}

#[contract]
pub struct MortgagePool;

// Internal helpers, kept out of the contract spec.
impl MortgagePool {
    fn config(env: &Env) -> Config {
        match env.storage().instance().get(&DataKey::Config) {
            Some(config) => config,
            None => panic_with_error!(env, Error::NotInitialized),
        }
    }

    fn load_loan(env: &Env, property_id: u64) -> LoanInfo {
        match env.storage().persistent().get(&DataKey::Loan(property_id)) {
            Some(loan) => loan,
            None => panic_with_error!(env, Error::LoanNotFound),
        }
    }

    fn store_loan(env: &Env, property_id: u64, loan: &LoanInfo) {
        env.storage()
            .persistent()
            .set(&DataKey::Loan(property_id), loan);
    }

    // The token interface deals in `i128`. A bare `as i128` cast wraps
    // silently, which on a funds path is the wrong failure mode, so the
    // conversion is checked.
    fn to_amount(env: &Env, value: u128) -> i128 {
        match i128::try_from(value) {
            Ok(amount) => amount,
            Err(_) => panic_with_error!(env, Error::AmountOverflow),
        }
    }
}

#[contractimpl]
impl MortgagePool {
    pub fn initialize(
        env: Env,
        admin: Address,
        usdc_token: Address,
        pool_token: Address,
        property_registry: Address,
    ) {
        let storage = env.storage().instance();
        if storage.has(&DataKey::Config) {
            panic_with_error!(&env, Error::AlreadyInitialized);
        }
        storage.set(
            &DataKey::Config,
            &Config {
                admin,
                usdc_token,
                pool_token,
                property_registry,
            },
        );
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

    pub fn deposit_liquidity(env: Env, investor: Address, usdc_amount: u128) {
        investor.require_auth();

        let config = Self::config(&env);
        let pool = env.current_contract_address();
        let amount = Self::to_amount(&env, usdc_amount);

        // Take the USDC in, hand back POOL-HC 1:1.
        token::Client::new(&env, &config.usdc_token).transfer(&investor, &pool, &amount);
        token::Client::new(&env, &config.pool_token).transfer(&pool, &investor, &amount);

        Deposit {
            investor,
            usdc_amount,
        }
        .publish(&env);
    }

    pub fn lock_collateral(env: Env, borrower: Address, property_id: u64, token_amount: u128) {
        borrower.require_auth();

        let config = Self::config(&env);
        let property_token =
            RegistryClient::new(&env, &config.property_registry).get_collateral_token(&property_id);

        let pool = env.current_contract_address();
        token::Client::new(&env, &property_token).transfer(
            &borrower,
            &pool,
            &Self::to_amount(&env, token_amount),
        );

        env.storage()
            .persistent()
            .set(&DataKey::Collateral(property_id), &token_amount);

        CollLock {
            property_id,
            borrower,
            token_amount,
        }
        .publish(&env);
    }

    pub fn issue_mortgage(env: Env, property_id: u64, requested_usdc: u128, build_escrow: Address) {
        let config = Self::config(&env);
        config.admin.require_auth();

        let storage = env.storage().persistent();
        let collateral: u128 = match storage.get(&DataKey::Collateral(property_id)) {
            Some(collateral) => collateral,
            None => panic_with_error!(&env, Error::NoCollateral),
        };

        let registry = RegistryClient::new(&env, &config.property_registry);
        let (trustee, valuation) = registry.get_underwriting(&property_id);

        // Loan-to-value ceiling. Overflow here traps rather than wrapping --
        // `overflow-checks` is on in the release profile for exactly this.
        if requested_usdc > valuation * MAX_LTV_PCT / 100 {
            panic_with_error!(&env, Error::LtvExceeded);
        }

        let pool = env.current_contract_address();
        token::Client::new(&env, &config.usdc_token).transfer(
            &pool,
            &build_escrow,
            &Self::to_amount(&env, requested_usdc),
        );

        Self::store_loan(
            &env,
            property_id,
            &LoanInfo {
                borrower: trustee,
                principal: requested_usdc,
                interest_rate_bps: INTEREST_RATE_BPS,
                amount_repaid: 0,
                collateral_amount: collateral,
                status: LoanStatus::Active,
                property_id,
            },
        );

        // The collateral amount now lives inside the loan record. Leaving the
        // separate Collateral entry in place would duplicate it for the life of
        // the loan and pay persistent-entry rent on a value nothing reads.
        storage.remove(&DataKey::Collateral(property_id));

        registry.update_status(&property_id, &STATUS_MORTGAGED);

        MtgIssue {
            property_id,
            build_escrow,
            principal: requested_usdc,
        }
        .publish(&env);
    }

    pub fn repay(env: Env, property_id: u64, usdc_amount: u128) {
        let mut loan = Self::load_loan(&env, property_id);
        if loan.status != LoanStatus::Active {
            panic_with_error!(&env, Error::LoanNotActive);
        }
        loan.borrower.require_auth();

        let config = Self::config(&env);
        let pool = env.current_contract_address();
        token::Client::new(&env, &config.usdc_token).transfer(
            &loan.borrower,
            &pool,
            &Self::to_amount(&env, usdc_amount),
        );

        loan.amount_repaid += usdc_amount;

        // Derived from the rate stored on the loan rather than a second
        // hard-coded 8%, so the two cannot drift apart.
        let total_due =
            loan.principal + loan.principal * loan.interest_rate_bps as u128 / BPS_DENOMINATOR;

        if loan.amount_repaid >= total_due {
            loan.status = LoanStatus::Repaid;

            let registry = RegistryClient::new(&env, &config.property_registry);
            let property_token = registry.get_collateral_token(&property_id);

            token::Client::new(&env, &property_token).transfer(
                &pool,
                &loan.borrower,
                &Self::to_amount(&env, loan.collateral_amount),
            );

            registry.update_status(&property_id, &STATUS_REPAID);
        }

        Self::store_loan(&env, property_id, &loan);

        Repaid {
            property_id,
            usdc_amount,
        }
        .publish(&env);
    }

    pub fn trigger_default(env: Env, property_id: u64) {
        let config = Self::config(&env);
        config.admin.require_auth();

        let mut loan = Self::load_loan(&env, property_id);
        if loan.status != LoanStatus::Active {
            panic_with_error!(&env, Error::LoanNotActive);
        }

        loan.status = LoanStatus::Defaulted;
        Self::store_loan(&env, property_id, &loan);

        RegistryClient::new(&env, &config.property_registry)
            .update_status(&property_id, &STATUS_DEFAULTED);

        Defaulted {
            property_id,
            outstanding: loan.principal - loan.amount_repaid,
        }
        .publish(&env);
    }

    pub fn liquidate(env: Env, property_id: u64, liquidator: Address) {
        liquidator.require_auth();

        let loan = Self::load_loan(&env, property_id);
        if loan.status != LoanStatus::Defaulted {
            panic_with_error!(&env, Error::LoanNotDefaulted);
        }

        let config = Self::config(&env);
        let pool = env.current_contract_address();

        // The liquidator buys the collateral for the outstanding principal.
        let remaining_debt = loan.principal - loan.amount_repaid;

        token::Client::new(&env, &config.usdc_token).transfer(
            &liquidator,
            &pool,
            &Self::to_amount(&env, remaining_debt),
        );

        let property_token =
            RegistryClient::new(&env, &config.property_registry).get_collateral_token(&property_id);

        token::Client::new(&env, &property_token).transfer(
            &pool,
            &liquidator,
            &Self::to_amount(&env, loan.collateral_amount),
        );

        // Only the loan entry needs clearing; the Collateral entry was released
        // when the mortgage was issued.
        env.storage()
            .persistent()
            .remove(&DataKey::Loan(property_id));

        Liquidate {
            property_id,
            liquidator,
            remaining_debt,
        }
        .publish(&env);
    }

    pub fn get_loan(env: Env, property_id: u64) -> LoanInfo {
        Self::load_loan(&env, property_id)
    }

    pub fn get_locked_collateral(env: Env, property_id: u64) -> u128 {
        env.storage()
            .persistent()
            .get(&DataKey::Collateral(property_id))
            .unwrap_or(0)
    }
}

#[cfg(test)]
mod test;
