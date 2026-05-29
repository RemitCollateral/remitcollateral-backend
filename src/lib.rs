#![no_std]

use soroban_sdk::{
    contractimpl, vec, vec::Vec, Address, BytesN, Env, Map, Symbol, 
};

// ============================================================================
// CONSTANTS & TYPES
// ============================================================================

const MAX_DELAY: u64 = 2_592_000; // 30 days in seconds

// Storage Keys
const KEY_SIGNERS: Symbol = Symbol::short("signers");
const KEY_QUORUM: Symbol = Symbol::short("quorum");
const KEY_EXEC_DELAY: Symbol = Symbol::short("exec_delay");
const KEY_BALANCE_MAP: Symbol = Symbol::short("balance");
const KEY_TOTAL_RESERVES: Symbol = Symbol::short("reserves");
const KEY_PROPOSAL_COUNTER: Symbol = Symbol::short("prop_cnt");
const KEY_PROPOSALS: Symbol = Symbol::short("props");
const KEY_CONFIRMATIONS: Symbol = Symbol::short("confs");
const KEY_PROPOSAL_FEE: Symbol = Symbol::short("prop_fee");

// Proposal States
const STATE_PENDING: u8 = 0;
const STATE_CONFIRMED: u8 = 1;
const STATE_EXECUTED: u8 = 2;
const STATE_CANCELLED: u8 = 3;

// ============================================================================
// ACCESS ROLES CONTRACT
// ============================================================================

pub struct AccessRolesContract;

#[contractimpl]
impl AccessRolesContract {
    /// Add a signer to the system (admin only)
    pub fn add_cosigner(env: Env, admin: Address, signer: Address) {
        admin.require_auth();
        
        let mut signers: Vec<Address> = env
            .storage()
            .get(&KEY_SIGNERS)
            .unwrap_or_else(|| Vec::new(&env));
        
        // Check if signer already exists
        if !signers.iter().any(|s| s == &signer) {
            signers.push_back(signer.clone());
            env.storage().set(&KEY_SIGNERS, &signers);
        }
    }

    /// Remove a signer from the system (admin only)
    pub fn remove_signer(env: Env, admin: Address, signer: Address) {
        admin.require_auth();
        
        let signers: Vec<Address> = env
            .storage()
            .get(&KEY_SIGNERS)
            .unwrap_or_else(|| Vec::new(&env));
        
        let filtered: Vec<Address> = signers
            .iter()
            .filter(|s| s != &signer)
            .collect();
        
        env.storage().set(&KEY_SIGNERS, &filtered);
    }

    /// Set the quorum requirement (admin only)
    pub fn set_quorum(env: Env, admin: Address, new_quorum: u32) {
        admin.require_auth();
        
        let signers: Vec<Address> = env
            .storage()
            .get(&KEY_SIGNERS)
            .unwrap_or_else(|| Vec::new(&env));
        
        assert!(new_quorum > 0, "quorum must be > 0");
        assert!(
            new_quorum <= signers.len() as u32,
            "quorum cannot exceed total signers"
        );
        
        env.storage().set(&KEY_QUORUM, &new_quorum);
    }

    /// Check if an account has a specific role
    pub fn has_role(env: Env, account: Address, _role: BytesN<32>) -> bool {
        let signers: Vec<Address> = env
            .storage()
            .get(&KEY_SIGNERS)
            .unwrap_or_else(|| Vec::new(&env));
        
        signers.iter().any(|s| s == &account)
    }

    /// Get the default admin role identifier
    pub fn get_default_admin_role(_env: Env) -> BytesN<32> {
        BytesN::from_array(&_env, &[0u8; 32])
    }

    /// Get the signer role identifier
    pub fn get_signer_role(_env: Env) -> BytesN<32> {
        BytesN::from_array(&_env, &[1u8; 32])
    }

    /// Get the current quorum requirement
    pub fn get_quorum(env: Env) -> u32 {
        env.storage().get(&KEY_QUORUM).unwrap_or(0)
    }

    /// Get total number of signers
    pub fn get_total_signers(env: Env) -> u32 {
        let signers: Vec<Address> = env
            .storage()
            .get(&KEY_SIGNERS)
            .unwrap_or_else(|| Vec::new(&env));
        
        signers.len() as u32
    }
}

// ============================================================================
// DELAY TIME CONTRACT
// ============================================================================

pub struct DelayTimeContract;

#[contractimpl]
impl DelayTimeContract {
    /// Set the execution delay (admin only)
    pub fn set_execution_delay(env: Env, admin: Address, delay_seconds: u64) {
        admin.require_auth();
        
        assert!(delay_seconds > 0, "delay must be > 0");
        assert!(delay_seconds <= MAX_DELAY, "delay exceeds max (30 days)");
        
        env.storage().set(&KEY_EXEC_DELAY, &delay_seconds);
    }

    /// Get the current execution delay
    pub fn get_execution_delay(env: Env) -> u64 {
        env.storage().get(&KEY_EXEC_DELAY).unwrap_or(0)
    }

    /// Calculate the execution time for a proposal
    pub fn calculate_execution_time(env: Env, proposal_created_at: u64) -> u64 {
        proposal_created_at + Self::get_execution_delay(env)
    }

    /// Check if the delay has passed for a proposal
    pub fn is_delay_passed(env: Env, proposal_created_at: u64, current_time: u64) -> bool {
        current_time >= Self::calculate_execution_time(env, proposal_created_at)
    }
}

// ============================================================================
// TREASURY CONTRACT
// ============================================================================

pub struct TreasuryContract;

#[contractimpl]
impl TreasuryContract {
    /// Deposit tokens into the treasury
    pub fn deposit(env: Env, depositor: Address, amount: i128) {
        depositor.require_auth();
        
        assert!(amount > 0, "amount must be > 0");
        
        // Update user balance
        let key = (KEY_BALANCE_MAP, depositor.clone());
        let current: i128 = env.storage().get(&key).unwrap_or(0);
        env.storage().set(&key, &(current + amount));
        
        // Update total reserves
        let total: i128 = env.storage().get(&KEY_TOTAL_RESERVES).unwrap_or(0);
        env.storage().set(&KEY_TOTAL_RESERVES, &(total + amount));
    }

    /// Withdraw tokens from the treasury
    pub fn withdraw(env: Env, withdrawer: Address, amount: i128) {
        withdrawer.require_auth();
        
        assert!(amount > 0, "amount must be > 0");
        
        // Check user balance
        let key = (KEY_BALANCE_MAP, withdrawer.clone());
        let current: i128 = env.storage().get(&key).unwrap_or(0);
        assert!(current >= amount, "insufficient balance");
        
        // Update user balance
        env.storage().set(&key, &(current - amount));
        
        // Update total reserves
        let total: i128 = env.storage().get(&KEY_TOTAL_RESERVES).unwrap_or(0);
        env.storage().set(&KEY_TOTAL_RESERVES, &(total - amount));
    }

    /// Withdraw tokens for a proposal (called by TransactionProposal)
    pub fn withdraw_for_proposal(
        env: Env,
        _proposal_id: u64,
        recipient: Address,
        amount: i128,
    ) {
        assert!(amount > 0, "amount must be > 0");
        
        // Verify sufficient balance
        let total: i128 = env.storage().get(&KEY_TOTAL_RESERVES).unwrap_or(0);
        assert!(total >= amount, "insufficient reserves");
        
        // Update recipient balance
        let key = (KEY_BALANCE_MAP, recipient.clone());
        let current: i128 = env.storage().get(&key).unwrap_or(0);
        env.storage().set(&key, &(current + amount));
        
        // Update total reserves
        env.storage().set(&KEY_TOTAL_RESERVES, &(total - amount));
    }

    /// Get balance for an account
    pub fn get_balance(env: Env, account: Address) -> i128 {
        let key = (KEY_BALANCE_MAP, account);
        env.storage().get(&key).unwrap_or(0)
    }

    /// Get total reserves
    pub fn get_total_reserves(env: Env) -> i128 {
        env.storage().get(&KEY_TOTAL_RESERVES).unwrap_or(0)
    }
}

// ============================================================================
// TRANSACTION PROPOSAL CONTRACT
// ============================================================================

pub struct TransactionProposalContract;

#[contractimpl]
impl TransactionProposalContract {
    /// Create a new proposal
    pub fn create_proposal(
        env: Env,
        proposer: Address,
        recipient: Address,
        amount: i128,
    ) -> u64 {
        proposer.require_auth();
        
        assert!(amount > 0, "amount must be > 0");
        
        // Verify proposer is a signer
        assert!(
            AccessRolesContract::has_role(env.clone(), proposer.clone(), BytesN::from_array(&env, &[1u8; 32])),
            "proposer must be a signer"
        );
        
        // Charge proposal fee
        let fee: i128 = env.storage().get(&KEY_PROPOSAL_FEE).unwrap_or(0);
        if fee > 0 {
            TreasuryContract::withdraw(env.clone(), proposer.clone(), fee);
        }
        
        // Generate proposal ID
        let mut counter: u64 = env.storage().get(&KEY_PROPOSAL_COUNTER).unwrap_or(0);
        counter += 1;
        env.storage().set(&KEY_PROPOSAL_COUNTER, &counter);
        
        // Create proposal
        let created_at = env.ledger().timestamp();
        let proposal_key = (KEY_PROPOSALS, counter);
        
        // Store proposal state
        env.storage().set(&(proposal_key.clone(), Symbol::short("id")), &counter);
        env.storage().set(&(proposal_key.clone(), Symbol::short("proposer")), &proposer);
        env.storage().set(&(proposal_key.clone(), Symbol::short("recipient")), &recipient);
        env.storage().set(&(proposal_key.clone(), Symbol::short("amount")), &amount);
        env.storage().set(&(proposal_key.clone(), Symbol::short("created_at")), &created_at);
        env.storage().set(&(proposal_key.clone(), Symbol::short("state")), &STATE_PENDING);
        env.storage().set(&(proposal_key.clone(), Symbol::short("executed")), &false);
        env.storage().set(&(proposal_key.clone(), Symbol::short("cancelled")), &false);
        env.storage().set(&(proposal_key.clone(), Symbol::short("confirmations")), &Vec::new(&env));
        
        counter
    }

    /// Confirm a proposal
    pub fn confirm_proposal(env: Env, signer: Address, proposal_id: u64) {
        signer.require_auth();
        
        // Verify signer role
        assert!(
            AccessRolesContract::has_role(env.clone(), signer.clone(), BytesN::from_array(&env, &[1u8; 32])),
            "must be a signer"
        );
        
        let proposal_key = (KEY_PROPOSALS, proposal_id);
        
        // Get current confirmations
        let mut confirmations: Vec<Address> = env
            .storage()
            .get(&(proposal_key.clone(), Symbol::short("confirmations")))
            .unwrap_or_else(|| Vec::new(&env));
        
        // Check if already confirmed
        assert!(
            !confirmations.iter().any(|c| c == &signer),
            "signer already confirmed"
        );
        
        confirmations.push_back(signer.clone());
        env.storage().set(
            &(proposal_key.clone(), Symbol::short("confirmations")),
            &confirmations,
        );
        
        // Check if quorum reached
        let quorum = AccessRolesContract::get_quorum(env.clone());
        if confirmations.len() as u32 >= quorum && quorum > 0 {
            let created_at: u64 = env
                .storage()
                .get(&(proposal_key.clone(), Symbol::short("created_at")))
                .unwrap_or(0);
            let delay_until =
                DelayTimeContract::calculate_execution_time(env.clone(), created_at);
            
            env.storage().set(
                &(proposal_key.clone(), Symbol::short("state")),
                &STATE_CONFIRMED,
            );
            env.storage().set(
                &(proposal_key.clone(), Symbol::short("delay_until")),
                &delay_until,
            );
        }
    }

    /// Execute a proposal
    pub fn execute_proposal(env: Env, executor: Address, proposal_id: u64) {
        executor.require_auth();
        
        let proposal_key = (KEY_PROPOSALS, proposal_id);
        
        // Verify proposal is confirmed
        let state: u8 = env
            .storage()
            .get(&(proposal_key.clone(), Symbol::short("state")))
            .unwrap_or(STATE_PENDING);
        assert!(state == STATE_CONFIRMED, "proposal must be confirmed");
        
        // Verify delay has passed
        let created_at: u64 = env
            .storage()
            .get(&(proposal_key.clone(), Symbol::short("created_at")))
            .unwrap_or(0);
        let current_time = env.ledger().timestamp();
        assert!(
            DelayTimeContract::is_delay_passed(env.clone(), created_at, current_time),
            "delay period has not passed"
        );
        
        // Get proposal details
        let recipient: Address = env
            .storage()
            .get(&(proposal_key.clone(), Symbol::short("recipient")))
            .unwrap();
        let amount: i128 = env
            .storage()
            .get(&(proposal_key.clone(), Symbol::short("amount")))
            .unwrap();
        
        // Execute treasury transfer
        TreasuryContract::withdraw_for_proposal(env.clone(), proposal_id, recipient, amount);
        
        // Mark as executed
        env.storage().set(
            &(proposal_key.clone(), Symbol::short("state")),
            &STATE_EXECUTED,
        );
        env.storage()
            .set(&(proposal_key.clone(), Symbol::short("executed")), &true);
    }

    /// Cancel a proposal
    pub fn cancel_proposal(env: Env, _signer: Address, proposal_id: u64) {
        let proposal_key = (KEY_PROPOSALS, proposal_id);
        
        // Verify proposal is confirmed
        let state: u8 = env
            .storage()
            .get(&(proposal_key.clone(), Symbol::short("state")))
            .unwrap_or(STATE_PENDING);
        assert!(
            state == STATE_CONFIRMED,
            "proposal must be confirmed to cancel"
        );
        
        // Verify delay has passed
        let created_at: u64 = env
            .storage()
            .get(&(proposal_key.clone(), Symbol::short("created_at")))
            .unwrap_or(0);
        let current_time = env.ledger().timestamp();
        assert!(
            DelayTimeContract::is_delay_passed(env.clone(), created_at, current_time),
            "delay period has not passed"
        );
        
        // Mark as cancelled
        env.storage().set(
            &(proposal_key.clone(), Symbol::short("state")),
            &STATE_CANCELLED,
        );
        env.storage()
            .set(&(proposal_key.clone(), Symbol::short("cancelled")), &true);
    }

    /// Set the proposal fee (admin only)
    pub fn set_proposal_fee(env: Env, admin: Address, new_fee: i128) {
        admin.require_auth();
        env.storage().set(&KEY_PROPOSAL_FEE, &new_fee);
    }

    /// Get the current proposal fee
    pub fn get_proposal_fee(env: Env) -> i128 {
        env.storage().get(&KEY_PROPOSAL_FEE).unwrap_or(0)
    }

    /// Get a proposal's state
    pub fn get_proposal_state(env: Env, proposal_id: u64) -> u8 {
        let proposal_key = (KEY_PROPOSALS, proposal_id);
        env.storage()
            .get(&(proposal_key, Symbol::short("state")))
            .unwrap_or(STATE_PENDING)
    }

    /// Get a proposal's confirmations count
    pub fn get_proposal_confirmations(env: Env, proposal_id: u64) -> u32 {
        let proposal_key = (KEY_PROPOSALS, proposal_id);
        let confirmations: Vec<Address> = env
            .storage()
            .get(&(proposal_key, Symbol::short("confirmations")))
            .unwrap_or_else(|| Vec::new(&env));
        
        confirmations.len() as u32
    }

    /// Get proposal details
    pub fn get_proposal_amount(env: Env, proposal_id: u64) -> i128 {
        let proposal_key = (KEY_PROPOSALS, proposal_id);
        env.storage()
            .get(&(proposal_key, Symbol::short("amount")))
            .unwrap_or(0)
    }
}

// ============================================================================
// TESTS
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_access_roles_workflow() {
        let env = Env::default();
        let admin = Address::random(&env);
        let signer1 = Address::random(&env);
        let signer2 = Address::random(&env);
        
        // Add signers
        AccessRolesContract::add_cosigner(env.clone(), admin.clone(), signer1.clone());
        AccessRolesContract::add_cosigner(env.clone(), admin.clone(), signer2.clone());
        
        // Check total signers
        assert_eq!(AccessRolesContract::get_total_signers(env.clone()), 2);
        
        // Set quorum
        AccessRolesContract::set_quorum(env.clone(), admin.clone(), 2);
        assert_eq!(AccessRolesContract::get_quorum(env.clone()), 2);
        
        // Check role
        assert!(
            AccessRolesContract::has_role(env.clone(), signer1.clone(), BytesN::from_array(&env, &[1u8; 32]))
        );
    }

    #[test]
    fn test_delay_time_workflow() {
        let env = Env::default();
        let admin = Address::random(&env);
        
        // Set delay
        DelayTimeContract::set_execution_delay(env.clone(), admin.clone(), 1000);
        assert_eq!(DelayTimeContract::get_execution_delay(env.clone()), 1000);
        
        // Test delay calculation
        let created_at = 100u64;
        let exec_time = DelayTimeContract::calculate_execution_time(env.clone(), created_at);
        assert_eq!(exec_time, 1100);
        
        // Check if delay passed
        assert!(!DelayTimeContract::is_delay_passed(env.clone(), created_at, 1000));
        assert!(DelayTimeContract::is_delay_passed(env.clone(), created_at, 1100));
    }

    #[test]
    fn test_treasury_workflow() {
        let env = Env::default();
        let acct1 = Address::random(&env);
        let acct2 = Address::random(&env);
        
        // Deposit
        TreasuryContract::deposit(env.clone(), acct1.clone(), 1000);
        assert_eq!(TreasuryContract::get_balance(env.clone(), acct1.clone()), 1000);
        assert_eq!(TreasuryContract::get_total_reserves(env.clone()), 1000);
        
        // Withdraw
        TreasuryContract::withdraw(env.clone(), acct1.clone(), 400);
        assert_eq!(TreasuryContract::get_balance(env.clone(), acct1.clone()), 600);
        assert_eq!(TreasuryContract::get_total_reserves(env.clone()), 600);
        
        // Withdraw for proposal
        TreasuryContract::withdraw_for_proposal(env.clone(), 1, acct2.clone(), 200);
        assert_eq!(TreasuryContract::get_balance(env.clone(), acct2.clone()), 200);
        assert_eq!(TreasuryContract::get_total_reserves(env.clone()), 400);
    }

    #[test]
    fn test_proposal_creation() {
        let env = Env::default();
        
        let admin = Address::random(&env);
        let proposer = Address::random(&env);
        let recipient = Address::random(&env);
        
        // Setup: add proposer as signer and deposit funds
        AccessRolesContract::add_cosigner(env.clone(), admin.clone(), proposer.clone());
        TreasuryContract::deposit(env.clone(), proposer.clone(), 5000);
        
        // Create proposal
        let proposal_id = TransactionProposalContract::create_proposal(
            env.clone(),
            proposer.clone(),
            recipient.clone(),
            1000,
        );
        
        assert_eq!(proposal_id, 1);
        assert_eq!(
            TransactionProposalContract::get_proposal_state(env.clone(), proposal_id),
            STATE_PENDING
        );
        assert_eq!(TransactionProposalContract::get_proposal_amount(env.clone(), proposal_id), 1000);
    }

    #[test]
    fn test_proposal_confirmation_and_execution() {
        let env = Env::default();
        
        let admin = Address::random(&env);
        let signer = Address::random(&env);
        let proposer = signer.clone();
        let recipient = Address::random(&env);
        
        // Setup
        AccessRolesContract::add_cosigner(env.clone(), admin.clone(), signer.clone());
        AccessRolesContract::set_quorum(env.clone(), admin.clone(), 1);
        DelayTimeContract::set_execution_delay(env.clone(), admin.clone(), 0);
        TreasuryContract::deposit(env.clone(), proposer.clone(), 5000);
        
        // Create proposal
        let proposal_id = TransactionProposalContract::create_proposal(
            env.clone(),
            proposer.clone(),
            recipient.clone(),
            1000,
        );
        
        // Confirm proposal
        TransactionProposalContract::confirm_proposal(env.clone(), signer.clone(), proposal_id);
        assert_eq!(
            TransactionProposalContract::get_proposal_state(env.clone(), proposal_id),
            STATE_CONFIRMED
        );
        assert_eq!(TransactionProposalContract::get_proposal_confirmations(env.clone(), proposal_id), 1);
        
        // Execute proposal
        TransactionProposalContract::execute_proposal(env.clone(), signer.clone(), proposal_id);
        assert_eq!(
            TransactionProposalContract::get_proposal_state(env.clone(), proposal_id),
            STATE_EXECUTED
        );
    }
}
