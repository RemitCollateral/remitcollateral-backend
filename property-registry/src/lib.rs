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

// Storage keys are internal: `export = false` keeps them out of contractspecv0,
// which is a public API description and has no business carrying them.
#[contracttype(export = false)]
pub enum DataKey {
    Admin,
    PendingAdmin,
    PropertyCount,
    Property(u64),
}

// Events.
//
// `data_format` is set explicitly on each: the macro defaults to "map", which
// labels every data field by name in the emitted event. "vec" and
// "single-value" carry the same information positionally, which is both what
// the previous tuple-based `publish` calls produced and the cheaper encoding.
//
// `export = false` keeps the event definitions out of contractspecv0. Exporting
// them publishes an event ABI for indexers, which is genuinely useful, but it
// measured at ~600 bytes across these four events -- and the contracts did not
// publish one before. Flip it on deliberately if tooling needs it.
#[contractevent(data_format = "vec", export = false)]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Submitted {
    #[topic]
    pub property_id: u64,
    pub trustee: Address,
    pub title_hash: BytesN<32>,
}

#[contractevent(data_format = "single-value", export = false)]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Verified {
    #[topic]
    pub property_id: u64,
    pub title_hash: BytesN<32>,
}

#[contractevent(data_format = "single-value", export = false)]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Valued {
    #[topic]
    pub property_id: u64,
    pub usdc_value: u128,
}

#[contractevent(data_format = "single-value", export = false)]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Tokenized {
    #[topic]
    pub property_id: u64,
    pub token_address: Address,
}

#[contractevent(data_format = "single-value", export = false)]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Upgraded {
    // The version being replaced. The incoming wasm reports its own.
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
pub struct PropertyRegistry;

// Internal helpers. Deliberately in an impl block *without* `#[contractimpl]`
// so they stay out of the contract spec, and taking `&Env` so callers do not
// clone the environment just to reach them.
impl PropertyRegistry {
    fn admin(env: &Env) -> Address {
        match env.storage().instance().get(&DataKey::Admin) {
            Some(admin) => admin,
            None => panic_with_error!(env, Error::NotInitialized),
        }
    }

    fn require_admin(env: &Env) {
        Self::admin(env).require_auth();
    }

    fn load(env: &Env, property_id: u64) -> PropertyInfo {
        match env
            .storage()
            .persistent()
            .get(&DataKey::Property(property_id))
        {
            Some(property) => property,
            None => panic_with_error!(env, Error::PropertyNotFound),
        }
    }

    fn store(env: &Env, property_id: u64, property: &PropertyInfo) {
        env.storage()
            .persistent()
            .set(&DataKey::Property(property_id), property);
    }
}

#[contractimpl]
impl PropertyRegistry {
    pub fn initialize(env: Env, admin: Address) {
        let storage = env.storage().instance();
        if storage.has(&DataKey::Admin) {
            panic_with_error!(&env, Error::AlreadyInitialized);
        }
        storage.set(&DataKey::Admin, &admin);
        // PropertyCount is intentionally not written here. Every reader already
        // treats a missing counter as zero, so seeding it with an explicit `0`
        // allocated an instance-storage slot that carried no information.
    }

    pub fn get_admin(env: Env) -> Address {
        Self::admin(&env)
    }

    pub fn version(_env: Env) -> u32 {
        CONTRACT_VERSION
    }

    // Replace this contract's executable, preserving all ledger state.
    //
    // `require_auth()` is the whole authorisation model here: it binds the
    // admin's signature to *this* invocation with *these* arguments, so an
    // authorisation to upgrade to one wasm hash cannot be replayed to install a
    // different one. Nothing else needs checking.
    //
    // The swap takes effect only once this invocation finishes successfully.
    // Instance and persistent entries are untouched, so the incoming wasm must
    // read the same storage layout -- see UPGRADING.md.
    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) {
        Self::require_admin(&env);

        env.deployer()
            .update_current_contract_wasm(new_wasm_hash.clone());

        Upgraded {
            from_version: CONTRACT_VERSION,
            new_wasm_hash,
        }
        .publish(&env);
    }

    // Admin handover is two-step on purpose. `upgrade` is the only way to fix a
    // mistake in deployed code, and it is gated on the admin, so setting the
    // admin to an address nobody can sign for would freeze this contract at its
    // current executable permanently. Requiring the incoming admin to accept
    // proves the key works before the old one gives it up.
    pub fn propose_admin(env: Env, new_admin: Address) {
        Self::require_admin(&env);

        env.storage()
            .instance()
            .set(&DataKey::PendingAdmin, &new_admin);

        AdminReq {
            current_admin: Self::admin(&env),
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

        let previous_admin = Self::admin(&env);
        storage.set(&DataKey::Admin, &pending);
        storage.remove(&DataKey::PendingAdmin);

        AdminSet {
            admin: pending,
            previous_admin,
        }
        .publish(&env);
    }

    pub fn cancel_admin_proposal(env: Env) {
        Self::require_admin(&env);
        env.storage().instance().remove(&DataKey::PendingAdmin);
    }

    pub fn get_pending_admin(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::PendingAdmin)
    }

    pub fn submit_property(
        env: Env,
        title_hash: BytesN<32>,
        trustee: Address,
        survey_doc: BytesN<32>,
    ) -> u64 {
        trustee.require_auth();

        let storage = env.storage().instance();
        let property_id: u64 = storage.get(&DataKey::PropertyCount).unwrap_or(0) + 1;
        storage.set(&DataKey::PropertyCount, &property_id);

        Self::store(
            &env,
            property_id,
            &PropertyInfo {
                title_hash: title_hash.clone(),
                trustee: trustee.clone(),
                survey_doc_hash: survey_doc,
                usdc_value: 0,
                status: PropertyStatus::Pending,
                token_address: None,
            },
        );

        Submitted {
            property_id,
            trustee,
            title_hash,
        }
        .publish(&env);

        property_id
    }

    pub fn verify_property(env: Env, property_id: u64) {
        Self::require_admin(&env);

        let mut property = Self::load(&env, property_id);
        if property.status != PropertyStatus::Pending {
            panic_with_error!(&env, Error::NotPending);
        }

        property.status = PropertyStatus::Verified;
        Self::store(&env, property_id, &property);

        Verified {
            property_id,
            title_hash: property.title_hash,
        }
        .publish(&env);
    }

    pub fn set_valuation(env: Env, property_id: u64, usdc_value: u128) {
        Self::require_admin(&env);

        if property.status == PropertyStatus::Pending {
            panic!("property must be verified first");
        }

        property.usdc_value = usdc_value;
        Self::store(&env, property_id, &property);

        log!(&env, "Property valuation set. ID: {}, Value: {}", property_id, usdc_value);
        env.events().publish(
            (Symbol::new(&env, "prop_valuation_set"), property_id),
            usdc_value,
        }
        .publish(&env);
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

        let mut property = Self::load(&env, property_id);
        if property.status != PropertyStatus::Verified {
            panic_with_error!(&env, Error::NotVerified);
        }
        if property.usdc_value == 0 {
            panic_with_error!(&env, Error::NotValued);
        }

        property.token_address = Some(token_address.clone());
        property.status = PropertyStatus::Tokenized;
        Self::store(&env, property_id, &property);

        Tokenized {
            property_id,
            token_address: token_address.clone(),
        }
        .publish(&env);

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
        let mut property = Self::load(&env, property_id);
        property.status = status;
        Self::store(&env, property_id, &property);
    }

    pub fn get_property(env: Env, property_id: u64) -> PropertyInfo {
        Self::load(&env, property_id)
    }

    // MortgagePool needs only this one field, and a cross-contract call
    // deep-copies whatever it returns into the caller's frame. Returning a
    // single `Address` rather than the whole six-field `PropertyInfo` (two of
    // which are 32-byte hashes) keeps that copy small, and means the pool does
    // not need to know `PropertyInfo`'s shape at all.
    pub fn get_collateral_token(env: Env, property_id: u64) -> Address {
        match Self::load(&env, property_id).token_address {
            Some(token_address) => token_address,
            None => panic_with_error!(&env, Error::NotTokenized),
        }
    }

    // `(trustee, valuation)` -- the only two fields underwriting a mortgage
    // needs. Same rationale as `get_collateral_token`.
    pub fn get_underwriting(env: Env, property_id: u64) -> (Address, u128) {
        let property = Self::load(&env, property_id);
        (property.trustee, property.usdc_value)
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
