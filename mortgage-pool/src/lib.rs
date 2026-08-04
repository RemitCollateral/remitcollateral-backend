#![no_std]
use soroban_sdk::{
    contract, contractclient, contracterror, contractevent, contractimpl, contracttype,
    panic_with_error, token, Address, BytesN, Env,
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

// Interface to call the PropertyRegistry contract
pub mod property_registry_contract {
    use soroban_sdk::{contractclient, contracttype, Address, BytesN, Env};

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

    #[contractclient(name = "Client")]
    pub trait PropertyRegistryTrait {
        fn get_property(env: Env, property_id: u64) -> PropertyInfo;
        fn update_status(env: Env, property_id: u64, status: PropertyStatus);
    }
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
    // Deliberately its own key rather than a field on `Config`. A pending
    // handover is short-lived state, and keeping `Config`'s serialised shape
    // stable matters more than usual in a contract whose whole point is that
    // the code can be swapped out from under its storage.
    PendingAdmin,
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

#[contractevent(data_format = "single-value", export = false)]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Upgraded {
    #[topic]
    pub from_version: u32,
    pub new_wasm_hash: BytesN<32>,
}

#[contractevent(data_format = "single-value", export = false)]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdminReq {
    #[topic]
    pub current_admin: Address,
    pub pending_admin: Address,
}

#[contractevent(data_format = "single-value", export = false)]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdminSet {
    #[topic]
    pub admin: Address,
    pub previous_admin: Address,
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

    pub fn version(_env: Env) -> u32 {
        CONTRACT_VERSION
    }

    // Replace this contract's executable, preserving all ledger state. See the
    // equivalent function in property-registry for why `require_auth()` is the
    // entire authorisation model, and UPGRADING.md for the storage-layout rules
    // the incoming wasm has to respect.
    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) {
        Self::config(&env).admin.require_auth();

        env.deployer()
            .update_current_contract_wasm(new_wasm_hash.clone());

        Upgraded {
            from_version: CONTRACT_VERSION,
            new_wasm_hash,
        }
        .publish(&env);
    }

    // Two-step handover; see the note in property-registry.
    pub fn propose_admin(env: Env, new_admin: Address) {
        let config = Self::config(&env);
        config.admin.require_auth();

        env.storage()
            .instance()
            .set(&DataKey::PendingAdmin, &new_admin);

        AdminReq {
            current_admin: config.admin,
            pending_admin: new_admin,
        }
        .publish(&env);
    }

    pub fn accept_admin(env: Env) {
        let storage = env.storage().instance();
        let pending: Address = match storage.get(&DataKey::PendingAdmin) {
            Some(pending) => pending,
            None => panic_with_error!(&env, Error::NoPendingAdmin),
        };
        pending.require_auth();

        let mut config = Self::config(&env);
        let previous_admin = config.admin;
        config.admin = pending.clone();
        storage.set(&DataKey::Config, &config);
        storage.remove(&DataKey::PendingAdmin);

        AdminSet {
            admin: pending,
            previous_admin,
        }
        .publish(&env);
    }

    pub fn cancel_admin_proposal(env: Env) {
        Self::config(&env).admin.require_auth();
        env.storage().instance().remove(&DataKey::PendingAdmin);
    }

    pub fn get_pending_admin(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::PendingAdmin)
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

// ============================================================================
// TESTS
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{Env, Address, token};
    use soroban_sdk::testutils::Address as _;
    use property_registry::{PropertyRegistry, PropertyRegistryClient};
    use property_registry::PropertyStatus as RegStatus;

    fn dummy_hash(env: &Env, val: u8) -> soroban_sdk::BytesN<32> {
        let mut arr = [0u8; 32];
        arr[0] = val;
        soroban_sdk::BytesN::from_array(env, &arr)
    }

    fn setup_test(env: &Env) -> (Address, Address, Address, Address, Address, MortgagePoolClient, PropertyRegistryClient) {
        let admin = Address::generate(env);
        let investor = Address::generate(env);
        let borrower = Address::generate(env);
        let liquidator = Address::generate(env);

        // Deploy USDC token
        let usdc_addr = env.register_stellar_asset_contract(admin.clone());
        let usdc_admin = token::StellarAssetClient::new(env, &usdc_addr);
        usdc_admin.mint(&investor, &10_000);
        usdc_admin.mint(&liquidator, &10_000);
        usdc_admin.mint(&borrower, &10_000);

        // Deploy Pool token (POOL-HC)
        let pool_token_addr = env.register_stellar_asset_contract(admin.clone());
        let pool_token_admin = token::StellarAssetClient::new(env, &pool_token_addr);

        // Deploy PropertyRegistry
        let registry_addr = env.register(PropertyRegistry, ());
        let registry_client = PropertyRegistryClient::new(env, &registry_addr);
        registry_client.initialize(&admin);

        // Deploy MortgagePool
        let pool_addr = env.register(MortgagePool, ());
        let pool_client = MortgagePoolClient::new(env, &pool_addr);
        pool_client.initialize(&admin, &usdc_addr, &pool_token_addr, &registry_addr);

        // Pre-fund pool token to the pool contract so it can transfer it to depositors
        pool_token_admin.mint(&pool_addr, &10_000);

        (admin, investor, borrower, liquidator, usdc_addr, pool_client, registry_client)
    }

    #[test]
    fn test_deposit_liquidity() {
        let env = Env::default();
        env.mock_all_auths();

        let (_admin, investor, _borrower, _liquidator, usdc_addr, pool_client, _registry_client) = setup_test(&env);
        let usdc_client = token::Client::new(&env, &usdc_addr);
        let pool_token_addr = pool_client.get_pool_token();
        let pool_token_client = token::Client::new(&env, &pool_token_addr);

        // Deposit liquidity
        pool_client.deposit_liquidity(&investor, &3000);

        // Verify balances
        assert_eq!(usdc_client.balance(&investor), 7000);
        assert_eq!(usdc_client.balance(&pool_client.address), 3000);
        assert_eq!(pool_token_client.balance(&investor), 3000);
    }

    #[test]
    fn test_mortgage_ltv_success() {
        let env = Env::default();
        env.mock_all_auths();

        let (admin, investor, borrower, _liquidator, usdc_addr, pool_client, registry_client) = setup_test(&env);
        let usdc_client = token::Client::new(&env, &usdc_addr);

        // Setup property registry with valuation = 1000 USDC
        let title_hash = dummy_hash(&env, 1);
        let survey_hash = dummy_hash(&env, 2);
        let prop_id = registry_client.submit_property(&title_hash, &borrower, &survey_hash);
        registry_client.verify_property(&prop_id);
        registry_client.set_valuation(&prop_id, &1000);

        // Deploy PROP token contract for this property and register it
        let prop_token_addr = env.register_stellar_asset_contract(admin.clone());
        let prop_token_admin = token::StellarAssetClient::new(&env, &prop_token_addr);
        prop_token_admin.mint(&borrower, &100);
        registry_client.mint_property_tokens(&prop_id, &prop_token_addr);

        // Deposit liquidity to MortgagePool
        pool_client.deposit_liquidity(&investor, &5000);

        // Lock 100 PROP tokens as collateral
        pool_client.lock_collateral(&borrower, &prop_id, &100);

        // Max borrow limit is 700 USDC (70% of 1000)
        // Request 700 USDC (within limit)
        let build_escrow = Address::generate(&env);
        pool_client.issue_mortgage(&prop_id, &700, &build_escrow);

        // Verify state
        assert_eq!(usdc_client.balance(&build_escrow), 700);
        assert_eq!(registry_client.get_property(&prop_id).status, RegStatus::Mortgaged);
    }

    #[test]
    #[should_panic(expected = "requested amount exceeds 70% LTV limit")]
    fn test_mortgage_ltv_exceeded() {
        let env = Env::default();
        env.mock_all_auths();

        let (admin, investor, borrower, _liquidator, _usdc_addr, pool_client, registry_client) = setup_test(&env);

        // Setup property registry with valuation = 1000 USDC
        let title_hash = dummy_hash(&env, 1);
        let survey_hash = dummy_hash(&env, 2);
        let prop_id = registry_client.submit_property(&title_hash, &borrower, &survey_hash);
        registry_client.verify_property(&prop_id);
        registry_client.set_valuation(&prop_id, &1000);

        // Deploy PROP token contract
        let prop_token_addr = env.register_stellar_asset_contract(admin.clone());
        let prop_token_admin = token::StellarAssetClient::new(&env, &prop_token_addr);
        prop_token_admin.mint(&borrower, &100);
        registry_client.mint_property_tokens(&prop_id, &prop_token_addr);

        // Deposit liquidity
        pool_client.deposit_liquidity(&investor, &5000);

        // Lock collateral
        pool_client.lock_collateral(&borrower, &prop_id, &100);

        // Attempt to borrow 701 USDC (exceeds 70% limit) -> should panic
        let build_escrow = Address::generate(&env);
        pool_client.issue_mortgage(&prop_id, &701, &build_escrow);
    }

    #[test]
    fn test_repayment_success() {
        let env = Env::default();
        env.mock_all_auths();

        let (admin, investor, borrower, _liquidator, usdc_addr, pool_client, registry_client) = setup_test(&env);
        let usdc_client = token::Client::new(&env, &usdc_addr);

        // Setup property with valuation = 1000 USDC
        let title_hash = dummy_hash(&env, 1);
        let survey_hash = dummy_hash(&env, 2);
        let prop_id = registry_client.submit_property(&title_hash, &borrower, &survey_hash);
        registry_client.verify_property(&prop_id);
        registry_client.set_valuation(&prop_id, &1000);

        // Deploy PROP token
        let prop_token_addr = env.register_stellar_asset_contract(admin.clone());
        let prop_token_admin = token::StellarAssetClient::new(&env, &prop_token_addr);
        let prop_token_client = token::Client::new(&env, &prop_token_addr);
        prop_token_admin.mint(&borrower, &100);
        registry_client.mint_property_tokens(&prop_id, &prop_token_addr);

        // Deposit and lock
        pool_client.deposit_liquidity(&investor, &5000);
        pool_client.lock_collateral(&borrower, &prop_id, &100);

        // Borrow 500 USDC
        let build_escrow = Address::generate(&env);
        pool_client.issue_mortgage(&prop_id, &500, &build_escrow);

        // Repay partial: 200 USDC
        pool_client.repay(&prop_id, &200);
        
        // Repay remaining to clear loan: 500 * 1.08 = 540 USDC total due.
        // We already repaid 200, so remaining is 340 USDC.
        pool_client.repay(&prop_id, &340);

        // Verify repayment cleared loan and returned collateral
        assert_eq!(prop_token_client.balance(&borrower), 100);
        assert_eq!(prop_token_client.balance(&pool_client.address), 0);
        assert_eq!(registry_client.get_property(&prop_id).status, RegStatus::Repaid);
    }

    #[test]
    fn test_liquidation_flow() {
        let env = Env::default();
        env.mock_all_auths();

        let (admin, investor, borrower, liquidator, usdc_addr, pool_client, registry_client) = setup_test(&env);
        let usdc_client = token::Client::new(&env, &usdc_addr);

        // Setup property with valuation = 1000 USDC
        let title_hash = dummy_hash(&env, 1);
        let survey_hash = dummy_hash(&env, 2);
        let prop_id = registry_client.submit_property(&title_hash, &borrower, &survey_hash);
        registry_client.verify_property(&prop_id);
        registry_client.set_valuation(&prop_id, &1000);

        // Deploy PROP token
        let prop_token_addr = env.register_stellar_asset_contract(admin.clone());
        let prop_token_admin = token::StellarAssetClient::new(&env, &prop_token_addr);
        let prop_token_client = token::Client::new(&env, &prop_token_addr);
        prop_token_admin.mint(&borrower, &100);
        registry_client.mint_property_tokens(&prop_id, &prop_token_addr);

        // Deposit and lock
        pool_client.deposit_liquidity(&investor, &5000);
        pool_client.lock_collateral(&borrower, &prop_id, &100);

        // Borrow 500 USDC
        let build_escrow = Address::generate(&env);
        pool_client.issue_mortgage(&prop_id, &500, &build_escrow);

        // Admin triggers default
        pool_client.trigger_default(&prop_id);
        assert_eq!(registry_client.get_property(&prop_id).status, RegStatus::Defaulted);

        // Liquidator liquidates the loan. Debt is remaining principal: 500 USDC (no repayments made).
        let liquidator_usdc_before = usdc_client.balance(&liquidator);
        pool_client.liquidate(&prop_id, &liquidator);

        // Verify liquidator paid outstanding debt and received the PROP tokens
        assert_eq!(usdc_client.balance(&liquidator), liquidator_usdc_before - 500);
        assert_eq!(prop_token_client.balance(&liquidator), 100);
        assert_eq!(prop_token_client.balance(&pool_client.address), 0);
    }

    #[test]
    #[should_panic(expected = "loan is not in defaulted status")]
    fn test_liquidation_fails_if_active() {
        let env = Env::default();
        env.mock_all_auths();

        let (admin, investor, borrower, liquidator, _usdc_addr, pool_client, registry_client) = setup_test(&env);

        // Setup property
        let title_hash = dummy_hash(&env, 1);
        let survey_hash = dummy_hash(&env, 2);
        let prop_id = registry_client.submit_property(&title_hash, &borrower, &survey_hash);
        registry_client.verify_property(&prop_id);
        registry_client.set_valuation(&prop_id, &1000);

        // Deploy PROP token
        let prop_token_addr = env.register_stellar_asset_contract(admin.clone());
        let prop_token_admin = token::StellarAssetClient::new(&env, &prop_token_addr);
        prop_token_admin.mint(&borrower, &100);
        registry_client.mint_property_tokens(&prop_id, &prop_token_addr);

        // Deposit, lock, and borrow
        pool_client.deposit_liquidity(&investor, &5000);
        pool_client.lock_collateral(&borrower, &prop_id, &100);
        let build_escrow = Address::generate(&env);
        pool_client.issue_mortgage(&prop_id, &500, &build_escrow);

        // Attempt liquidation on active loan -> should panic
        pool_client.liquidate(&prop_id, &liquidator);
    }

    #[test]
    fn test_valuation_change_margin_call_liquidation() {
        let env = Env::default();
        env.mock_all_auths();

        let (admin, investor, borrower, liquidator, usdc_addr, pool_client, registry_client) = setup_test(&env);
        let usdc_client = token::Client::new(&env, &usdc_addr);

        // Setup property with valuation = 1000 USDC
        let title_hash = dummy_hash(&env, 1);
        let survey_hash = dummy_hash(&env, 2);
        let prop_id = registry_client.submit_property(&title_hash, &borrower, &survey_hash);
        registry_client.verify_property(&prop_id);
        registry_client.set_valuation(&prop_id, &1000);

        // Deploy PROP token
        let prop_token_addr = env.register_stellar_asset_contract(admin.clone());
        let prop_token_admin = token::StellarAssetClient::new(&env, &prop_token_addr);
        let prop_token_client = token::Client::new(&env, &prop_token_addr);
        prop_token_admin.mint(&borrower, &100);
        registry_client.mint_property_tokens(&prop_id, &prop_token_addr);

        // Deposit, lock, and borrow 700 USDC (max 70% LTV of 1000)
        pool_client.deposit_liquidity(&investor, &5000);
        pool_client.lock_collateral(&borrower, &prop_id, &100);
        let build_escrow = Address::generate(&env);
        pool_client.issue_mortgage(&prop_id, &700, &build_escrow);

        // Valuation drops significantly: e.g. down to 500 USDC
        // LTV is now 700 / 500 = 140% (exceeds borrowing limit and liquidation threshold)
        registry_client.set_valuation(&prop_id, &500);

        // Admin triggers default (margin call threshold breach)
        pool_client.trigger_default(&prop_id);
        assert_eq!(registry_client.get_property(&prop_id).status, RegStatus::Defaulted);

        // Liquidator liquidates the defaulted loan for the remaining debt (700 USDC)
        let liquidator_usdc_before = usdc_client.balance(&liquidator);
        pool_client.liquidate(&prop_id, &liquidator);

        // Verify successful liquidation after valuation drop
        assert_eq!(usdc_client.balance(&liquidator), liquidator_usdc_before - 700);
        assert_eq!(prop_token_client.balance(&liquidator), 100);
        assert_eq!(prop_token_client.balance(&pool_client.address), 0);
    }
}
