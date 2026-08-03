#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, token, Address, Env, log};

// ============================================================================
// STORAGE TYPES & KEYS
// ============================================================================

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MilestoneInfo {
    pub amount: u128,
    pub released: bool,
}

#[contracttype]
pub enum DataKey {
    Admin,
    Trustee,
    UsdcToken,
    Milestone(u32),
    Approval(u32, Address),
}

// ============================================================================
// CONTRACT IMPLEMENTATION
// ============================================================================

#[contract]
pub struct BuildEscrow;

#[contractimpl]
impl BuildEscrow {
    /// Initialize the escrow contract with roles and the token address.
    pub fn initialize(env: Env, admin: Address, trustee: Address, usdc_token: Address) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("already initialized");
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Trustee, &trustee);
        env.storage().instance().set(&DataKey::UsdcToken, &usdc_token);
    }

    pub fn get_admin(env: Env) -> Address {
        env.storage().instance().get(&DataKey::Admin).expect("not initialized")
    }

    pub fn get_trustee(env: Env) -> Address {
        env.storage().instance().get(&DataKey::Trustee).expect("not initialized")
    }

    pub fn get_usdc_token(env: Env) -> Address {
        env.storage().instance().get(&DataKey::UsdcToken).expect("not initialized")
    }

    /// Add a new milestone target (admin only).
    pub fn add_milestone(env: Env, milestone_id: u32, amount: u128) {
        let admin = Self::get_admin(env.clone());
        admin.require_auth();

        let key = DataKey::Milestone(milestone_id);
        if env.storage().persistent().has(&key) {
            panic!("milestone already exists");
        }

        let milestone = MilestoneInfo {
            amount,
            released: false,
        };
        env.storage().persistent().set(&key, &milestone);

        log!(&env, "Milestone added: ID {}, amount {}", milestone_id, amount);
    }

    /// Approve milestone for disbursement.
    /// Either the trustee or compliance officer (admin) can sign-off.
    pub fn approve_milestone(env: Env, signer: Address, milestone_id: u32) {
        signer.require_auth();

        let admin = Self::get_admin(env.clone());
        let trustee = Self::get_trustee(env.clone());

        if signer != admin && signer != trustee {
            panic!("not authorized signer");
        }

        let milestone_key = DataKey::Milestone(milestone_id);
        let milestone: MilestoneInfo = env
            .storage()
            .persistent()
            .get(&milestone_key)
            .expect("milestone not found");

        if milestone.released {
            panic!("milestone already released");
        }

        let approval_key = DataKey::Approval(milestone_id, signer.clone());
        env.storage().persistent().set(&approval_key, &true);

        log!(&env, "Milestone ID {} approved by {:?}", milestone_id, signer);
    }

    /// Release milestone funds to the trustee if both trustee and admin have approved.
    pub fn release_milestone(env: Env, milestone_id: u32) {
        let milestone_key = DataKey::Milestone(milestone_id);
        let mut milestone: MilestoneInfo = env
            .storage()
            .persistent()
            .get(&milestone_key)
            .expect("milestone not found");

        if milestone.released {
            panic!("milestone already released");
        }

        let admin = Self::get_admin(env.clone());
        let trustee = Self::get_trustee(env.clone());

        let admin_approved = env
            .storage()
            .persistent()
            .get(&DataKey::Approval(milestone_id, admin.clone()))
            .unwrap_or(false);

        let trustee_approved = env
            .storage()
            .persistent()
            .get(&DataKey::Approval(milestone_id, trustee.clone()))
            .unwrap_or(false);

        if !admin_approved || !trustee_approved {
            panic!("missing required approvals");
        }

        // Perform token transfer
        let usdc_token = Self::get_usdc_token(env.clone());
        let usdc_client = token::Client::new(&env, &usdc_token);
        
        // Transfer to the trustee
        usdc_client.transfer(
            &env.current_contract_address(),
            &trustee,
            &(milestone.amount as i128),
        );

        milestone.released = true;
        env.storage().persistent().set(&milestone_key, &milestone);

        log!(&env, "Milestone ID {} released. Trustee received {} USDC", milestone_id, milestone.amount);
    }

    pub fn get_milestone(env: Env, milestone_id: u32) -> MilestoneInfo {
        env.storage()
            .persistent()
            .get(&DataKey::Milestone(milestone_id))
            .expect("milestone not found")
    }

    pub fn is_approved(env: Env, milestone_id: u32, signer: Address) -> bool {
        env.storage()
            .persistent()
            .get(&DataKey::Approval(milestone_id, signer))
            .unwrap_or(false)
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

    #[test]
    fn test_escrow_success() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let trustee = Address::generate(&env);
        
        // Register token
        let usdc_address = env.register_stellar_asset_contract(admin.clone());
        let usdc_client = token::Client::new(&env, &usdc_address);
        let usdc_admin_client = token::StellarAssetClient::new(&env, &usdc_address);

        // Register escrow contract
        let escrow_id = env.register(BuildEscrow, ());
        let escrow_client = BuildEscrowClient::new(&env, &escrow_id);

        // Initialize
        escrow_client.initialize(&admin, &trustee, &usdc_address);

        // Add milestone
        escrow_client.add_milestone(&1, &1000);

        // Mint tokens to escrow contract
        usdc_admin_client.mint(&escrow_id, &1000);

        // Verify initial state
        let milestone = escrow_client.get_milestone(&1);
        assert_eq!(milestone.amount, 1000);
        assert!(!milestone.released);

        // Trustee approves
        escrow_client.approve_milestone(&trustee, &1);
        assert!(escrow_client.is_approved(&1, &trustee));
        assert!(!escrow_client.is_approved(&1, &admin));

        // Admin approves
        escrow_client.approve_milestone(&admin, &1);
        assert!(escrow_client.is_approved(&1, &admin));

        // Release milestone
        escrow_client.release_milestone(&1);

        // Check release status and balance
        let milestone = escrow_client.get_milestone(&1);
        assert!(milestone.released);
        assert_eq!(usdc_client.balance(&trustee), 1000);
        assert_eq!(usdc_client.balance(&escrow_id), 0);
    }

    #[test]
    #[should_panic(expected = "missing required approvals")]
    fn test_release_fails_with_only_trustee_approval() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let trustee = Address::generate(&env);
        
        let usdc_address = env.register_stellar_asset_contract(admin.clone());
        let usdc_admin_client = token::StellarAssetClient::new(&env, &usdc_address);

        let escrow_id = env.register(BuildEscrow, ());
        let escrow_client = BuildEscrowClient::new(&env, &escrow_id);

        escrow_client.initialize(&admin, &trustee, &usdc_address);
        escrow_client.add_milestone(&1, &1000);
        usdc_admin_client.mint(&escrow_id, &1000);

        // Trustee approves only
        escrow_client.approve_milestone(&trustee, &1);

        // Try to release - should panic
        escrow_client.release_milestone(&1);
    }

    #[test]
    #[should_panic(expected = "missing required approvals")]
    fn test_release_fails_with_only_admin_approval() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let trustee = Address::generate(&env);
        
        let usdc_address = env.register_stellar_asset_contract(admin.clone());
        let usdc_admin_client = token::StellarAssetClient::new(&env, &usdc_address);

        let escrow_id = env.register(BuildEscrow, ());
        let escrow_client = BuildEscrowClient::new(&env, &escrow_id);

        escrow_client.initialize(&admin, &trustee, &usdc_address);
        escrow_client.add_milestone(&1, &1000);
        usdc_admin_client.mint(&escrow_id, &1000);

        // Admin approves only
        escrow_client.approve_milestone(&admin, &1);

        // Try to release - should panic
        escrow_client.release_milestone(&1);
    }

    #[test]
    #[should_panic(expected = "not authorized signer")]
    fn test_approve_fails_for_unauthorized_signer() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let trustee = Address::generate(&env);
        let attacker = Address::generate(&env);
        
        let usdc_address = env.register_stellar_asset_contract(admin.clone());

        let escrow_id = env.register(BuildEscrow, ());
        let escrow_client = BuildEscrowClient::new(&env, &escrow_id);

        escrow_client.initialize(&admin, &trustee, &usdc_address);
        escrow_client.add_milestone(&1, &1000);

        // Attacker tries to approve - should panic
        escrow_client.approve_milestone(&attacker, &1);
    }

    #[test]
    #[should_panic(expected = "milestone already released")]
    fn test_approve_fails_if_already_released() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let trustee = Address::generate(&env);
        
        let usdc_address = env.register_stellar_asset_contract(admin.clone());
        let usdc_admin_client = token::StellarAssetClient::new(&env, &usdc_address);

        let escrow_id = env.register(BuildEscrow, ());
        let escrow_client = BuildEscrowClient::new(&env, &escrow_id);

        escrow_client.initialize(&admin, &trustee, &usdc_address);
        escrow_client.add_milestone(&1, &1000);
        usdc_admin_client.mint(&escrow_id, &1000);

        escrow_client.approve_milestone(&trustee, &1);
        escrow_client.approve_milestone(&admin, &1);
        escrow_client.release_milestone(&1);

        // Try to approve again - should panic
        escrow_client.approve_milestone(&trustee, &1);
    }
}
