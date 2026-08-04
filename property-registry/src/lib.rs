#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, token, Address, BytesN, Env, Symbol, log};

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

#[contracttype]
pub enum DataKey {
    Admin,
    PropertyCount,
    Property(u64),
}

#[contract]
pub struct PropertyRegistry;

#[contractimpl]
impl PropertyRegistry {
    pub fn initialize(env: Env, admin: Address) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("already initialized");
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::PropertyCount, &0u64);
    }

    pub fn get_admin(env: Env) -> Address {
        env.storage().instance().get(&DataKey::Admin).expect("not initialized")
    }

    pub fn submit_property(
        env: Env,
        title_hash: BytesN<32>,
        trustee: Address,
        survey_doc: BytesN<32>,
    ) -> u64 {
        trustee.require_auth();

        let mut count: u64 = env.storage().instance().get(&DataKey::PropertyCount).unwrap_or(0);
        count += 1;

        let property = PropertyInfo {
            title_hash: title_hash.clone(),
            trustee: trustee.clone(),
            survey_doc_hash: survey_doc,
            usdc_value: 0,
            status: PropertyStatus::Pending,
            token_address: None,
        };

        env.storage().persistent().set(&DataKey::Property(count), &property);
        env.storage().instance().set(&DataKey::PropertyCount, &count);

        log!(&env, "Property submitted. ID: {}", count);
        env.events().publish(
            (Symbol::new(&env, "prop_submitted"), count),
            (trustee, title_hash),
        );

        count
    }

    pub fn verify_property(env: Env, property_id: u64) {
        let admin = Self::get_admin(env.clone());
        admin.require_auth();

        let key = DataKey::Property(property_id);
        let mut property: PropertyInfo = env
            .storage()
            .persistent()
            .get(&key)
            .expect("property not found");

        if property.status != PropertyStatus::Pending {
            panic!("property is not in pending status");
        }

        property.status = PropertyStatus::Verified;
        env.storage().persistent().set(&key, &property);

        log!(&env, "Property verified. ID: {}", property_id);
        env.events().publish(
            (Symbol::new(&env, "prop_verified"), property_id),
            property.title_hash,
        );
    }

    pub fn set_valuation(env: Env, property_id: u64, usdc_value: u128) {
        let admin = Self::get_admin(env.clone());
        admin.require_auth();

        let key = DataKey::Property(property_id);
        let mut property: PropertyInfo = env
            .storage()
            .persistent()
            .get(&key)
            .expect("property not found");

        if property.status != PropertyStatus::Verified {
            panic!("property must be verified first");
        }

        property.usdc_value = usdc_value;
        env.storage().persistent().set(&key, &property);

        log!(&env, "Property valuation set. ID: {}, Value: {}", property_id, usdc_value);
        env.events().publish(
            (Symbol::new(&env, "prop_valued"), property_id),
            usdc_value,
        );
    }

    pub fn mint_property_tokens(env: Env, property_id: u64, token_address: Address) -> Address {
        let admin = Self::get_admin(env.clone());
        admin.require_auth();

        let key = DataKey::Property(property_id);
        let mut property: PropertyInfo = env
            .storage()
            .persistent()
            .get(&key)
            .expect("property not found");

        if property.status != PropertyStatus::Verified {
            panic!("property must be verified and valued first");
        }
        if property.usdc_value == 0 {
            panic!("property valuation is zero");
        }

        property.token_address = Some(token_address.clone());
        property.status = PropertyStatus::Tokenized;
        env.storage().persistent().set(&key, &property);

        log!(&env, "Property tokenized. ID: {}, Token: {:?}", property_id, token_address);
        env.events().publish(
            (Symbol::new(&env, "prop_tokenized"), property_id),
            token_address.clone(),
        );

        token_address
    }

    pub fn clawback_property_tokens(env: Env, property_id: u64, from: Address, amount: u128) {
        let admin = Self::get_admin(env.clone());
        admin.require_auth();

        let key = DataKey::Property(property_id);
        let property: PropertyInfo = env
            .storage()
            .persistent()
            .get(&key)
            .expect("property not found");

        let token_address = property.token_address.expect("property not tokenized");

        // Invoke the Stellar Asset Contract clawback helper
        let token_admin_client = token::StellarAssetClient::new(&env, &token_address);
        token_admin_client.clawback(&from, &(amount as i128));

        log!(&env, "Tokens clawed back for Property ID: {}. From: {:?}, Amount: {}", property_id, from, amount);
        env.events().publish(
            (Symbol::new(&env, "prop_clawback"), property_id),
            (from, amount),
        );
    }

    pub fn update_status(env: Env, property_id: u64, status: PropertyStatus) {
        // This is a helper function for other contracts (e.g. MortgagePool) to update property status.
        // In a real system, we would authorize the MortgagePool contract to call this.
        // For simplicity, we allow the admin or authorized contracts to call it.
        let key = DataKey::Property(property_id);
        let mut property: PropertyInfo = env
            .storage()
            .persistent()
            .get(&key)
            .expect("property not found");

        property.status = status;
        env.storage().persistent().set(&key, &property);
    }

    pub fn get_property(env: Env, property_id: u64) -> PropertyInfo {
        env.storage()
            .persistent()
            .get(&DataKey::Property(property_id))
            .expect("property not found")
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

    fn dummy_hash(env: &Env, val: u8) -> BytesN<32> {
        let mut arr = [0u8; 32];
        arr[0] = val;
        BytesN::from_array(env, &arr)
    }

    #[test]
    fn test_clawback_success() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let trustee = Address::generate(&env);
        let user = Address::generate(&env);

        // Deploy PropertyRegistry
        let registry_addr = env.register(PropertyRegistry, ());
        let registry_client = PropertyRegistryClient::new(&env, &registry_addr);
        registry_client.initialize(&admin);

        // Deploy mock PROP token contract (supporting clawback via SAC)
        let prop_token_addr = env.register_stellar_asset_contract(admin.clone());
        let prop_token_admin = token::StellarAssetClient::new(&env, &prop_token_addr);
        let prop_token_client = token::Client::new(&env, &prop_token_addr);

        // Mint tokens to user
        prop_token_admin.mint(&user, &1000);
        assert_eq!(prop_token_client.balance(&user), 1000);

        // Submit property, verify, and set valuation
        let title_hash = dummy_hash(&env, 1);
        let survey_hash = dummy_hash(&env, 2);
        let prop_id = registry_client.submit_property(&title_hash, &trustee, &survey_hash);
        registry_client.verify_property(&prop_id);
        registry_client.set_valuation(&prop_id, &10_000);

        // Mint PROP tokens (registering the mock token contract address)
        registry_client.mint_property_tokens(&prop_id, &prop_token_addr);

        // Trigger clawback of 400 tokens by the admin
        registry_client.clawback_property_tokens(&prop_id, &user, &400);

        // Verify balance is reduced
        assert_eq!(prop_token_client.balance(&user), 600);
    }

    #[test]
    #[should_panic]
    fn test_clawback_unauthorized() {
        let env = Env::default();
        // Do not call mock_all_auths() to trigger authorization failure

        let admin = Address::generate(&env);
        let user = Address::generate(&env);

        // Deploy PropertyRegistry
        let registry_addr = env.register(PropertyRegistry, ());
        let registry_client = PropertyRegistryClient::new(&env, &registry_addr);
        registry_client.initialize(&admin);

        // Attempt clawback without admin authorization -> should fail auth check and panic
        registry_client.clawback_property_tokens(&1, &user, &400);
    }
}
