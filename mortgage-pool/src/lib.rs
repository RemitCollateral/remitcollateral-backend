#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, token, Address, Env, Symbol, log};

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
    pub interest_rate_bps: u32, // e.g. 800 for 8%
    pub amount_repaid: u128,
    pub collateral_amount: u128,
    pub status: LoanStatus,
    pub property_id: u64,
}

#[contracttype]
pub enum DataKey {
    Admin,
    UsdcToken,
    PoolToken,
    PropertyRegistry,
    Loan(u64), // property_id -> LoanInfo
    Collateral(u64), // property_id -> CollateralAmount
}

#[contract]
pub struct MortgagePool;

#[contractimpl]
impl MortgagePool {
    pub fn initialize(
        env: Env,
        admin: Address,
        usdc_token: Address,
        pool_token: Address,
        property_registry: Address,
    ) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("already initialized");
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::UsdcToken, &usdc_token);
        env.storage().instance().set(&DataKey::PoolToken, &pool_token);
        env.storage().instance().set(&DataKey::PropertyRegistry, &property_registry);
    }

    pub fn get_admin(env: Env) -> Address {
        env.storage().instance().get(&DataKey::Admin).expect("not initialized")
    }

    pub fn get_usdc_token(env: Env) -> Address {
        env.storage().instance().get(&DataKey::UsdcToken).expect("not initialized")
    }

    pub fn get_pool_token(env: Env) -> Address {
        env.storage().instance().get(&DataKey::PoolToken).expect("not initialized")
    }

    pub fn get_property_registry(env: Env) -> Address {
        env.storage().instance().get(&DataKey::PropertyRegistry).expect("not initialized")
    }

    pub fn deposit_liquidity(env: Env, investor: Address, usdc_amount: u128) {
        investor.require_auth();

        let usdc_token = Self::get_usdc_token(env.clone());
        let pool_token = Self::get_pool_token(env.clone());

        let usdc_client = token::Client::new(&env, &usdc_token);
        let pool_client = token::Client::new(&env, &pool_token);

        // Transfer USDC from investor to this contract
        usdc_client.transfer(&investor, &env.current_contract_address(), &(usdc_amount as i128));

        // Mint POOL-HC tokens to investor (1:1 representation for simplicity)
        pool_client.transfer(&env.current_contract_address(), &investor, &(usdc_amount as i128));

        log!(&env, "Liquidity deposited: {} USDC by {:?}", usdc_amount, investor);
        env.events().publish(
            (Symbol::new(&env, "liquidity_deposited"), investor),
            usdc_amount,
        );
    }

    pub fn lock_collateral(
        env: Env,
        borrower: Address,
        property_id: u64,
        token_amount: u128,
    ) {
        borrower.require_auth();

        let registry_addr = Self::get_property_registry(env.clone());
        let registry_client = property_registry_contract::Client::new(&env, &registry_addr);

        let property = registry_client.get_property(&property_id);
        
        let prop_token_addr = property.token_address.expect("property not tokenized");
        let prop_token_client = token::Client::new(&env, &prop_token_addr);

        // Transfer PROP tokens from borrower to this contract
        prop_token_client.transfer(&borrower, &env.current_contract_address(), &(token_amount as i128));

        // Record collateral
        env.storage().persistent().set(&DataKey::Collateral(property_id), &token_amount);

        log!(&env, "Collateral locked for Property ID {}: {}", property_id, token_amount);
        env.events().publish(
            (Symbol::new(&env, "collateral_locked"), property_id),
            (borrower, token_amount),
        );
    }

    pub fn issue_mortgage(
        env: Env,
        property_id: u64,
        requested_usdc: u128,
        build_escrow: Address,
    ) {
        let admin = Self::get_admin(env.clone());
        admin.require_auth();

        let registry_addr = Self::get_property_registry(env.clone());
        let registry_client = property_registry_contract::Client::new(&env, &registry_addr);
        let property = registry_client.get_property(&property_id);

        let collateral: u128 = env
            .storage()
            .persistent()
            .get(&DataKey::Collateral(property_id))
            .expect("no collateral locked");

        // Verify LTV (Loan-To-Value) does not exceed 70%
        // Max loan = 70% of valuation. Property valuation is in property.usdc_value.
        // We assume 1 PROP token represents a share of the property.
        // For simplicity, we check: requested_usdc <= (property.usdc_value * 70) / 100
        let max_loan = (property.usdc_value * 70) / 100;
        if requested_usdc > max_loan {
            panic!("requested amount exceeds 70% LTV limit");
        }

        let usdc_token = Self::get_usdc_token(env.clone());
        let usdc_client = token::Client::new(&env, &usdc_token);

        // Transfer USDC directly to the BuildEscrow contract
        usdc_client.transfer(&env.current_contract_address(), &build_escrow, &(requested_usdc as i128));

        // Create the loan record
        let loan = LoanInfo {
            borrower: property.trustee.clone(), // The borrower/trustee representing the build
            principal: requested_usdc,
            interest_rate_bps: 800, // 8% fixed interest rate
            amount_repaid: 0,
            collateral_amount: collateral,
            status: LoanStatus::Active,
            property_id,
        };

        env.storage().persistent().set(&DataKey::Loan(property_id), &loan);

        // Update property status via registry client to Mortgaged (status = 3)
        registry_client.update_status(&property_id, &property_registry_contract::PropertyStatus::Mortgaged);

        log!(&env, "Mortgage issued for Property ID {}: {} USDC", property_id, requested_usdc);
        env.events().publish(
            (Symbol::new(&env, "mortgage_issued"), property_id),
            (build_escrow, requested_usdc),
        );
    }

    pub fn repay(env: Env, property_id: u64, usdc_amount: u128) {
        let mut loan: LoanInfo = env
            .storage()
            .persistent()
            .get(&DataKey::Loan(property_id))
            .expect("loan not found");

        if loan.status != LoanStatus::Active {
            panic!("loan is not active");
        }

        let payer = loan.borrower.clone();
        payer.require_auth();

        let usdc_token = Self::get_usdc_token(env.clone());
        let usdc_client = token::Client::new(&env, &usdc_token);

        // Transfer USDC from payer to this contract
        usdc_client.transfer(&payer, &env.current_contract_address(), &(usdc_amount as i128));

        loan.amount_repaid += usdc_amount;

        // Simple calculation: Total to repay = principal + 8% interest
        let total_due = loan.principal + (loan.principal * 8) / 100;

        if loan.amount_repaid >= total_due {
            loan.status = LoanStatus::Repaid;

            // Unlock and return collateral (PROP tokens) to the borrower
            let registry_addr = Self::get_property_registry(env.clone());
            let registry_client = property_registry_contract::Client::new(&env, &registry_addr);
            let property = registry_client.get_property(&property_id);
            let prop_token_addr = property.token_address.expect("property not tokenized");
            let prop_token_client = token::Client::new(&env, &prop_token_addr);

            prop_token_client.transfer(
                &env.current_contract_address(),
                &loan.borrower,
                &(loan.collateral_amount as i128),
            );

            // Update property status to Repaid
            registry_client.update_status(&property_id, &property_registry_contract::PropertyStatus::Repaid);

            log!(&env, "Loan fully repaid for Property ID: {}", property_id);
        }

        env.storage().persistent().set(&DataKey::Loan(property_id), &loan);

        env.events().publish(
            (Symbol::new(&env, "repayment_received"), property_id),
            usdc_amount,
        );
    }

    pub fn trigger_default(env: Env, property_id: u64) {
        let admin = Self::get_admin(env.clone());
        admin.require_auth();

        let mut loan: LoanInfo = env
            .storage()
            .persistent()
            .get(&DataKey::Loan(property_id))
            .expect("loan not found");

        if loan.status != LoanStatus::Active {
            panic!("loan is not active");
        }

        loan.status = LoanStatus::Defaulted;
        env.storage().persistent().set(&DataKey::Loan(property_id), &loan);

        // Update property status to Defaulted
        let registry_addr = Self::get_property_registry(env.clone());
        let registry_client = property_registry_contract::Client::new(&env, &registry_addr);
        registry_client.update_status(&property_id, &property_registry_contract::PropertyStatus::Defaulted);

        log!(&env, "Loan defaulted for Property ID: {}", property_id);
        env.events().publish(
            (Symbol::new(&env, "loan_defaulted"), property_id),
            property_id,
        );
    }

    pub fn liquidate(env: Env, property_id: u64, liquidator: Address) {
        liquidator.require_auth();

        let loan: LoanInfo = env
            .storage()
            .persistent()
            .get(&DataKey::Loan(property_id))
            .expect("loan not found");

        if loan.status != LoanStatus::Defaulted {
            panic!("loan is not in defaulted status");
        }

        let registry_addr = Self::get_property_registry(env.clone());
        let registry_client = property_registry_contract::Client::new(&env, &registry_addr);
        let property = registry_client.get_property(&property_id);
        let prop_token_addr = property.token_address.expect("property not tokenized");

        let prop_token_client = token::Client::new(&env, &prop_token_addr);
        let usdc_token = Self::get_usdc_token(env.clone());
        let usdc_client = token::Client::new(&env, &usdc_token);

        // Liquidation price is set to the remaining outstanding principal
        let remaining_debt = loan.principal - loan.amount_repaid;

        // Transfer USDC from liquidator to this contract
        usdc_client.transfer(&liquidator, &env.current_contract_address(), &(remaining_debt as i128));

        // Transfer the locked PROP tokens to the liquidator
        prop_token_client.transfer(
            &env.current_contract_address(),
            &liquidator,
            &(loan.collateral_amount as i128),
        );

        // Remove the loan record or mark it as settled
        env.storage().persistent().remove(&DataKey::Loan(property_id));
        env.storage().persistent().remove(&DataKey::Collateral(property_id));

        log!(&env, "Property ID {} liquidated by {:?}", property_id, liquidator);
        env.events().publish(
            (Symbol::new(&env, "property_liquidated"), property_id),
            (liquidator, remaining_debt),
        );
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
