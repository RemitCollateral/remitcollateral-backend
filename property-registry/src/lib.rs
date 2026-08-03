#![no_std]
use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error, Address,
    BytesN, Env,
};

// Integer error codes instead of string panics. `panic!("property not found")`
// puts the message in linear memory and pulls in `core::fmt` plumbing that
// survives LTO; a `contracterror` variant is a single u32 the host surfaces to
// the caller directly, so it is both smaller and more useful off-chain.
//
// Note these are `//` and not `///` on purpose: rustdoc comments on public
// contract items are written verbatim into the wasm's `contractspecv0` section,
// so prose here is prose you pay to upload. Rationale goes in plain comments,
// and doc comments stay short enough to earn their bytes.
#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    PropertyNotFound = 3,
    NotPending = 4,
    NotVerified = 5,
    NotValued = 6,
    NotTokenized = 7,
}

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

        let mut property = Self::load(&env, property_id);
        if property.status != PropertyStatus::Verified {
            panic_with_error!(&env, Error::NotVerified);
        }

        property.usdc_value = usdc_value;
        Self::store(&env, property_id, &property);

        Valued {
            property_id,
            usdc_value,
        }
        .publish(&env);
    }

    pub fn mint_property_tokens(env: Env, property_id: u64) -> Address {
        Self::require_admin(&env);

        let mut property = Self::load(&env, property_id);
        if property.status != PropertyStatus::Verified {
            panic_with_error!(&env, Error::NotVerified);
        }
        if property.usdc_value == 0 {
            panic_with_error!(&env, Error::NotValued);
        }

        // In a production contract this would deploy a real token contract (SAC
        // or custom). The current contract address stands in for that so the
        // downstream flow can be exercised end to end.
        let token_address = env.current_contract_address();

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

    // Lets sibling contracts (MortgagePool) advance a property's lifecycle
    // state.
    //
    // NOTE: unauthenticated, unchanged from the original implementation. That
    // is a real gap -- any account can move a property to Repaid or Defaulted
    // -- but closing it means giving the registry a notion of which contract is
    // allowed to call it, which is a behavioural change well outside a
    // performance pass. Left as-is on purpose.
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

#[cfg(test)]
mod test;
