#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, token, Address, Env, Symbol, log};

// Interface to call the PropertyRegistry contract
mod property_registry_contract {
    soroban_sdk::contractimport!(
        file = "../target/wasm32v1-none/release/property_registry.wasm"
    );
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
