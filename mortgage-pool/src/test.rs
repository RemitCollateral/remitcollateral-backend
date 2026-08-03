#![cfg(test)]

use soroban_sdk::{
    contract, contractimpl, contracttype, testutils::Address as _, token, Address, BytesN, Env,
    Error as HostError, InvokeError,
};

use crate::{Error, LoanStatus, MortgagePool, MortgagePoolClient, STATUS_MORTGAGED};

/// See the equivalent helper in property-registry: these entry points panic
/// rather than returning `Result`, so `try_*` yields a raw host error.
fn err_of<T>(result: Result<T, Result<HostError, InvokeError>>) -> HostError {
    result.err().expect("call was expected to fail").unwrap()
}

// ---------------------------------------------------------------------------
// Stub registry
//
// PropertyRegistry::mint_property_tokens currently uses its own address as a
// placeholder for the property token, which means the real registry can never
// hand back an address that actually implements the token interface. This stub
// serves the same interface but points at a real Stellar Asset Contract, so the
// pool's transfer paths can be exercised. `registry_wire_compatibility` below
// covers the pool against the *real* registry.
// ---------------------------------------------------------------------------

#[contracttype]
enum StubKey {
    Token,
    Trustee,
    Valuation,
    LastStatus,
}

#[contract]
pub struct StubRegistry;

#[contractimpl]
impl StubRegistry {
    pub fn configure(env: Env, token: Address, trustee: Address, valuation: u128) {
        let storage = env.storage().instance();
        storage.set(&StubKey::Token, &token);
        storage.set(&StubKey::Trustee, &trustee);
        storage.set(&StubKey::Valuation, &valuation);
    }

    pub fn get_collateral_token(env: Env, _property_id: u64) -> Address {
        env.storage().instance().get(&StubKey::Token).unwrap()
    }

    pub fn get_underwriting(env: Env, _property_id: u64) -> (Address, u128) {
        let storage = env.storage().instance();
        (
            storage.get(&StubKey::Trustee).unwrap(),
            storage.get(&StubKey::Valuation).unwrap(),
        )
    }

    pub fn update_status(env: Env, _property_id: u64, status: u32) {
        env.storage().instance().set(&StubKey::LastStatus, &status);
    }

    pub fn last_status(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&StubKey::LastStatus)
            .unwrap_or(u32::MAX)
    }
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const PROPERTY_ID: u64 = 1;
const VALUATION: u128 = 1_000_000;
const MAX_LOAN: u128 = 700_000; // 70% of VALUATION
const COLLATERAL: u128 = 500;

struct Fixture {
    env: Env,
    pool: MortgagePoolClient<'static>,
    pool_address: Address,
    registry: StubRegistryClient<'static>,
    usdc: Address,
    pool_token: Address,
    prop_token: Address,
    admin: Address,
    trustee: Address,
    investor: Address,
    build_escrow: Address,
}

fn setup() -> Fixture {
    let env = Env::default();
    env.mock_all_auths();

    let issuer = Address::generate(&env);
    let admin = Address::generate(&env);
    let trustee = Address::generate(&env);
    let investor = Address::generate(&env);
    let build_escrow = Address::generate(&env);

    let usdc = env
        .register_stellar_asset_contract_v2(issuer.clone())
        .address();
    let pool_token = env
        .register_stellar_asset_contract_v2(issuer.clone())
        .address();
    let prop_token = env.register_stellar_asset_contract_v2(issuer).address();

    let registry_address = env.register(StubRegistry, ());
    let registry = StubRegistryClient::new(&env, &registry_address);
    registry.configure(&prop_token, &trustee, &VALUATION);

    let pool_address = env.register(MortgagePool, ());
    let pool = MortgagePoolClient::new(&env, &pool_address);
    pool.initialize(&admin, &usdc, &pool_token, &registry_address);

    // Float the pool with USDC to lend and POOL-HC to hand to depositors, and
    // give the participants something to spend.
    mint(&env, &usdc, &pool_address, 5_000_000);
    mint(&env, &pool_token, &pool_address, 5_000_000);
    mint(&env, &usdc, &investor, 1_000_000);
    mint(&env, &usdc, &trustee, 1_000_000);
    mint(&env, &prop_token, &trustee, COLLATERAL as i128);

    Fixture {
        env,
        pool,
        pool_address,
        registry,
        usdc,
        pool_token,
        prop_token,
        admin,
        trustee,
        investor,
        build_escrow,
    }
}

fn mint(env: &Env, asset: &Address, to: &Address, amount: i128) {
    token::StellarAssetClient::new(env, asset).mint(to, &amount);
}

impl Fixture {
    fn balance(&self, asset: &Address, of: &Address) -> i128 {
        token::Client::new(&self.env, asset).balance(of)
    }

    fn lock_collateral(&self) {
        self.pool
            .lock_collateral(&self.trustee, &PROPERTY_ID, &COLLATERAL);
    }

    fn issue(&self, amount: u128) {
        self.pool
            .issue_mortgage(&PROPERTY_ID, &amount, &self.build_escrow);
    }
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/// The four addresses moved from four instance keys into one `Config` entry;
/// every accessor must still round-trip.
#[test]
fn initialize_stores_all_four_addresses() {
    let f = setup();
    assert_eq!(f.pool.get_admin(), f.admin);
    assert_eq!(f.pool.get_usdc_token(), f.usdc);
    assert_eq!(f.pool.get_pool_token(), f.pool_token);
    assert_eq!(f.pool.get_property_registry(), f.registry.address);
}

#[test]
fn initialize_is_one_shot() {
    let f = setup();
    assert_eq!(
        err_of(
            f.pool
                .try_initialize(&f.admin, &f.usdc, &f.pool_token, &f.registry.address)
        ),
        Error::AlreadyInitialized.into()
    );
}

#[test]
fn accessors_fail_before_initialization() {
    let env = Env::default();
    let pool = MortgagePoolClient::new(&env, &env.register(MortgagePool, ()));
    assert_eq!(err_of(pool.try_get_admin()), Error::NotInitialized.into());
}

// ---------------------------------------------------------------------------
// Liquidity
// ---------------------------------------------------------------------------

#[test]
fn deposit_liquidity_swaps_usdc_for_pool_tokens() {
    let f = setup();
    f.pool.deposit_liquidity(&f.investor, &250_000);

    assert_eq!(f.balance(&f.usdc, &f.investor), 750_000);
    assert_eq!(f.balance(&f.pool_token, &f.investor), 250_000);
    assert_eq!(f.balance(&f.usdc, &f.pool_address), 5_250_000);
}

// ---------------------------------------------------------------------------
// Collateral and issuance
// ---------------------------------------------------------------------------

#[test]
fn lock_collateral_takes_custody_and_records_the_amount() {
    let f = setup();
    f.lock_collateral();

    assert_eq!(f.pool.get_locked_collateral(&PROPERTY_ID), COLLATERAL);
    assert_eq!(f.balance(&f.prop_token, &f.trustee), 0);
    assert_eq!(
        f.balance(&f.prop_token, &f.pool_address),
        COLLATERAL as i128
    );
}

#[test]
fn issue_mortgage_requires_locked_collateral() {
    let f = setup();
    assert_eq!(
        err_of(f.pool.try_issue_mortgage(&PROPERTY_ID, &1, &f.build_escrow)),
        Error::NoCollateral.into()
    );
}

#[test]
fn issue_mortgage_funds_escrow_and_records_the_loan() {
    let f = setup();
    f.lock_collateral();
    f.issue(MAX_LOAN);

    assert_eq!(f.balance(&f.usdc, &f.build_escrow), MAX_LOAN as i128);

    let loan = f.pool.get_loan(&PROPERTY_ID);
    assert_eq!(loan.borrower, f.trustee);
    assert_eq!(loan.principal, MAX_LOAN);
    assert_eq!(loan.collateral_amount, COLLATERAL);
    assert_eq!(loan.amount_repaid, 0);
    assert_eq!(loan.interest_rate_bps, 800);
    assert_eq!(loan.status, LoanStatus::Active);
    assert_eq!(loan.property_id, PROPERTY_ID);

    assert_eq!(f.registry.last_status(), STATUS_MORTGAGED);
}

/// The collateral amount is copied into the loan record at issuance, so the
/// standalone Collateral entry is released rather than left duplicating it.
#[test]
fn issue_mortgage_releases_the_duplicate_collateral_entry() {
    let f = setup();
    f.lock_collateral();
    assert_eq!(f.pool.get_locked_collateral(&PROPERTY_ID), COLLATERAL);

    f.issue(MAX_LOAN);

    assert_eq!(f.pool.get_locked_collateral(&PROPERTY_ID), 0);
    assert_eq!(f.pool.get_loan(&PROPERTY_ID).collateral_amount, COLLATERAL);
    // The tokens themselves are untouched; only the bookkeeping entry went away.
    assert_eq!(
        f.balance(&f.prop_token, &f.pool_address),
        COLLATERAL as i128
    );
}

#[test]
fn issue_mortgage_enforces_the_ltv_ceiling() {
    let f = setup();
    f.lock_collateral();

    assert_eq!(
        err_of(
            f.pool
                .try_issue_mortgage(&PROPERTY_ID, &(MAX_LOAN + 1), &f.build_escrow)
        ),
        Error::LtvExceeded.into()
    );
}

// ---------------------------------------------------------------------------
// Repayment
// ---------------------------------------------------------------------------

#[test]
fn partial_repayment_leaves_the_loan_active() {
    let f = setup();
    f.lock_collateral();
    f.issue(100_000);

    f.pool.repay(&PROPERTY_ID, &50_000);

    let loan = f.pool.get_loan(&PROPERTY_ID);
    assert_eq!(loan.amount_repaid, 50_000);
    assert_eq!(loan.status, LoanStatus::Active);
    // Collateral stays with the pool until the debt clears.
    assert_eq!(f.balance(&f.prop_token, &f.trustee), 0);
}

/// Payoff is principal plus the rate stored on the loan (800bps = 8%), not a
/// separately hard-coded 8.
#[test]
fn repaying_principal_plus_interest_returns_the_collateral() {
    let f = setup();
    f.lock_collateral();
    f.issue(100_000);

    f.pool.repay(&PROPERTY_ID, &107_999);
    assert_eq!(
        f.pool.get_loan(&PROPERTY_ID).status,
        LoanStatus::Active,
        "one short of the 108,000 due"
    );

    f.pool.repay(&PROPERTY_ID, &1);

    let loan = f.pool.get_loan(&PROPERTY_ID);
    assert_eq!(loan.status, LoanStatus::Repaid);
    assert_eq!(loan.amount_repaid, 108_000);
    assert_eq!(f.balance(&f.prop_token, &f.trustee), COLLATERAL as i128);
    assert_eq!(f.registry.last_status(), 4); // PropertyStatus::Repaid
}

#[test]
fn repayment_rejects_a_settled_loan() {
    let f = setup();
    f.lock_collateral();
    f.issue(100_000);
    f.pool.repay(&PROPERTY_ID, &108_000);

    assert_eq!(
        err_of(f.pool.try_repay(&PROPERTY_ID, &1)),
        Error::LoanNotActive.into()
    );
}

#[test]
fn repayment_requires_a_loan() {
    let f = setup();
    assert_eq!(
        err_of(f.pool.try_repay(&PROPERTY_ID, &1)),
        Error::LoanNotFound.into()
    );
}

// ---------------------------------------------------------------------------
// Default and liquidation
// ---------------------------------------------------------------------------

#[test]
fn default_then_liquidation_settles_the_position() {
    let f = setup();
    f.lock_collateral();
    f.issue(100_000);
    f.pool.repay(&PROPERTY_ID, &40_000);

    f.pool.trigger_default(&PROPERTY_ID);
    assert_eq!(f.pool.get_loan(&PROPERTY_ID).status, LoanStatus::Defaulted);
    assert_eq!(f.registry.last_status(), 5); // PropertyStatus::Defaulted

    let liquidator = Address::generate(&f.env);
    mint(&f.env, &f.usdc, &liquidator, 100_000);

    f.pool.liquidate(&PROPERTY_ID, &liquidator);

    // Liquidator paid the outstanding 60,000 and took the collateral.
    assert_eq!(f.balance(&f.usdc, &liquidator), 40_000);
    assert_eq!(f.balance(&f.prop_token, &liquidator), COLLATERAL as i128);
    assert_eq!(
        err_of(f.pool.try_get_loan(&PROPERTY_ID)),
        Error::LoanNotFound.into()
    );
}

#[test]
fn liquidation_requires_a_defaulted_loan() {
    let f = setup();
    f.lock_collateral();
    f.issue(100_000);

    let liquidator = Address::generate(&f.env);
    assert_eq!(
        err_of(f.pool.try_liquidate(&PROPERTY_ID, &liquidator)),
        Error::LoanNotDefaulted.into()
    );
}

#[test]
fn default_requires_an_active_loan() {
    let f = setup();
    f.lock_collateral();
    f.issue(100_000);
    f.pool.trigger_default(&PROPERTY_ID);

    assert_eq!(
        err_of(f.pool.try_trigger_default(&PROPERTY_ID)),
        Error::LoanNotActive.into()
    );
}

// ---------------------------------------------------------------------------
// Wire compatibility with the real registry
// ---------------------------------------------------------------------------

// The registry's compiled artifact, loaded in test code only. This is
// deliberately not a Rust dependency: giving property-registry an `rlib`
// crate-type so it could be linked directly costs whole-program LTO and nearly
// doubles its deployed wasm. Importing the real wasm here is also the stronger
// check -- it tests the bytes that actually get uploaded.
//
// Because the macro reads this file at compile time, `cargo test` needs the
// registry built first. `make test` does that for you.
mod registry_wasm {
    soroban_sdk::contractimport!(file = "../target/wasm32v1-none/release/property_registry.wasm");
}

/// `RegistryClient` is hand-written rather than generated from the registry's
/// wasm, and it declares `update_status`'s argument as `u32` where the registry
/// declares `PropertyStatus`. This drives all three methods against the real
/// contract so any drift in names, arities or encodings fails here.
#[test]
fn registry_wire_compatibility() {
    use registry_wasm::PropertyStatus;

    let env = Env::default();
    env.mock_all_auths();

    let registry_address = env.register(registry_wasm::WASM, ());
    let registry = registry_wasm::Client::new(&env, &registry_address);

    let admin = Address::generate(&env);
    let trustee = Address::generate(&env);
    registry.initialize(&admin);

    let title = BytesN::from_array(&env, &[7u8; 32]);
    let id = registry.submit_property(&title, &trustee, &BytesN::from_array(&env, &[8u8; 32]));
    registry.verify_property(&id);
    registry.set_valuation(&id, &VALUATION);
    let token = registry.mint_property_tokens(&id);

    // Same client the pool uses, pointed at the real registry.
    let client = crate::RegistryClient::new(&env, &registry_address);

    assert_eq!(client.get_collateral_token(&id), token);
    assert_eq!(client.get_underwriting(&id), (trustee, VALUATION));

    // The u32 the pool sends must land as the matching PropertyStatus variant.
    client.update_status(&id, &STATUS_MORTGAGED);
    assert_eq!(registry.get_property(&id).status, PropertyStatus::Mortgaged);
}

/// Same rationale as the registry's event test: topics and payload shapes are
/// the observable interface, and both changed in this pass.
#[test]
fn events_carry_the_expected_topics_and_payloads() {
    use soroban_sdk::{symbol_short, testutils::Events as _, vec, IntoVal};

    let f = setup();
    f.lock_collateral();
    // Filtered to the pool: these invocations also emit the token contract's
    // own `transfer` events.
    assert_eq!(
        f.env.events().all().filter_by_contract(&f.pool_address),
        vec![
            &f.env,
            (
                f.pool_address.clone(),
                vec![
                    &f.env,
                    symbol_short!("coll_lock").into_val(&f.env),
                    PROPERTY_ID.into_val(&f.env)
                ],
                (f.trustee.clone(), COLLATERAL).into_val(&f.env),
            ),
        ]
    );

    f.issue(MAX_LOAN);
    assert_eq!(
        f.env.events().all().filter_by_contract(&f.pool_address),
        vec![
            &f.env,
            (
                f.pool_address.clone(),
                vec![
                    &f.env,
                    symbol_short!("mtg_issue").into_val(&f.env),
                    PROPERTY_ID.into_val(&f.env)
                ],
                (f.build_escrow.clone(), MAX_LOAN).into_val(&f.env),
            ),
        ]
    );
}

// ---------------------------------------------------------------------------
// Upgradeability
// ---------------------------------------------------------------------------

#[test]
fn version_reports_the_compiled_constant() {
    let f = setup();
    assert_eq!(f.pool.version(), crate::CONTRACT_VERSION);
}

#[test]
fn upgrade_requires_admin_authorization() {
    let f = setup();
    f.env.set_auths(&[]);
    assert!(f
        .pool
        .try_upgrade(&BytesN::from_array(&f.env, &[9u8; 32]))
        .is_err());
}

/// The admin lives inside `Config`; a handover has to rewrite it without
/// disturbing the three token/registry addresses alongside it.
#[test]
fn admin_handover_preserves_the_rest_of_config() {
    let f = setup();
    let next = Address::generate(&f.env);

    f.pool.propose_admin(&next);
    assert_eq!(f.pool.get_pending_admin(), Some(next.clone()));
    assert_eq!(f.pool.get_admin(), f.admin);

    f.pool.accept_admin();

    assert_eq!(f.pool.get_admin(), next);
    assert_eq!(f.pool.get_pending_admin(), None);
    assert_eq!(f.pool.get_usdc_token(), f.usdc);
    assert_eq!(f.pool.get_pool_token(), f.pool_token);
    assert_eq!(f.pool.get_property_registry(), f.registry.address);
}

#[test]
fn accepting_without_a_proposal_fails() {
    let f = setup();
    assert_eq!(
        err_of(f.pool.try_accept_admin()),
        Error::NoPendingAdmin.into()
    );
}

#[test]
fn a_proposal_can_be_cancelled() {
    let f = setup();
    f.pool.propose_admin(&Address::generate(&f.env));

    f.pool.cancel_admin_proposal();

    assert_eq!(f.pool.get_pending_admin(), None);
    assert_eq!(
        err_of(f.pool.try_accept_admin()),
        Error::NoPendingAdmin.into()
    );
}

#[test]
fn only_the_proposed_address_can_accept() {
    let f = setup();
    f.pool.propose_admin(&Address::generate(&f.env));

    f.env.set_auths(&[]);
    assert!(f.pool.try_accept_admin().is_err());
    assert_eq!(f.pool.get_admin(), f.admin);
}
