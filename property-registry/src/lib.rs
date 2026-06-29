#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, Address, BytesN, Env, Symbol, log};

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

    pub fn mint_property_tokens(env: Env, property_id: u64) -> Address {
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

        // In a production contract, we would deploy a new token contract (e.g. SAC or custom token).
        // Here, we generate a mock contract address for demonstration / testing purposes.
        // We can use the current contract address and property_id to generate a deterministic address.
        let token_address = env.current_contract_address(); 

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
