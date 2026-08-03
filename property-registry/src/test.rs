#![cfg(test)]

use soroban_sdk::{testutils::Address as _, Address, BytesN, Env, Error as HostError, InvokeError};

use crate::{Error, PropertyRegistry, PropertyRegistryClient, PropertyStatus};

/// These entry points panic rather than returning `Result`, so the generated
/// `try_*` clients hand back a raw host error. Unwrap it down to the contract
/// error code the assertions actually care about.
fn err_of<T>(result: Result<T, Result<HostError, InvokeError>>) -> HostError {
    result.err().expect("call was expected to fail").unwrap()
}

struct Fixture {
    env: Env,
    client: PropertyRegistryClient<'static>,
    contract_id: Address,
    admin: Address,
    trustee: Address,
}

fn setup() -> Fixture {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(PropertyRegistry, ());
    let client = PropertyRegistryClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let trustee = Address::generate(&env);
    client.initialize(&admin);

    Fixture {
        env,
        client,
        contract_id,
        admin,
        trustee,
    }
}

fn hash(env: &Env, byte: u8) -> BytesN<32> {
    BytesN::from_array(env, &[byte; 32])
}

impl Fixture {
    fn submit(&self) -> u64 {
        self.client
            .submit_property(&hash(&self.env, 1), &self.trustee, &hash(&self.env, 2))
    }
}

#[test]
fn initialize_records_admin() {
    let f = setup();
    assert_eq!(f.client.get_admin(), f.admin);
}

#[test]
fn initialize_is_one_shot() {
    let f = setup();
    let other = Address::generate(&f.env);
    assert_eq!(
        err_of(f.client.try_initialize(&other)),
        Error::AlreadyInitialized.into()
    );
}

/// The counter is no longer seeded during `initialize`; ids must still start at
/// 1 and increment.
#[test]
fn ids_start_at_one_without_a_seeded_counter() {
    let f = setup();
    assert_eq!(f.submit(), 1);
    assert_eq!(f.submit(), 2);
    assert_eq!(f.submit(), 3);
}

#[test]
fn submitted_property_is_pending_and_unvalued() {
    let f = setup();
    let id = f.submit();

    let property = f.client.get_property(&id);
    assert_eq!(property.status, PropertyStatus::Pending);
    assert_eq!(property.usdc_value, 0);
    assert_eq!(property.token_address, None);
    assert_eq!(property.trustee, f.trustee);
    assert_eq!(property.title_hash, hash(&f.env, 1));
    assert_eq!(property.survey_doc_hash, hash(&f.env, 2));
}

#[test]
fn full_lifecycle_to_tokenized() {
    let f = setup();
    let id = f.submit();

    f.client.verify_property(&id);
    assert_eq!(f.client.get_property(&id).status, PropertyStatus::Verified);

    f.client.set_valuation(&id, &1_000_000);
    assert_eq!(f.client.get_property(&id).usdc_value, 1_000_000);

    let token = f.client.mint_property_tokens(&id);
    let property = f.client.get_property(&id);
    assert_eq!(property.status, PropertyStatus::Tokenized);
    assert_eq!(property.token_address, Some(token));
}

#[test]
fn narrow_accessors_agree_with_get_property() {
    let f = setup();
    let id = f.submit();
    f.client.verify_property(&id);
    f.client.set_valuation(&id, &750_000);
    f.client.mint_property_tokens(&id);

    let property = f.client.get_property(&id);
    assert_eq!(
        f.client.get_collateral_token(&id),
        property.token_address.unwrap()
    );
    assert_eq!(
        f.client.get_underwriting(&id),
        (property.trustee, property.usdc_value)
    );
}

#[test]
fn missing_property_reports_not_found() {
    let f = setup();
    for err in [
        err_of(f.client.try_get_property(&99)),
        err_of(f.client.try_get_underwriting(&99)),
        err_of(f.client.try_get_collateral_token(&99)),
        err_of(f.client.try_verify_property(&99)),
    ] {
        assert_eq!(err, Error::PropertyNotFound.into());
    }
}

#[test]
fn verify_rejects_non_pending() {
    let f = setup();
    let id = f.submit();
    f.client.verify_property(&id);

    assert_eq!(
        err_of(f.client.try_verify_property(&id)),
        Error::NotPending.into()
    );
}

#[test]
fn valuation_requires_verification() {
    let f = setup();
    let id = f.submit();

    assert_eq!(
        err_of(f.client.try_set_valuation(&id, &10)),
        Error::NotVerified.into()
    );
}

#[test]
fn minting_requires_verification_then_valuation() {
    let f = setup();
    let id = f.submit();

    assert_eq!(
        err_of(f.client.try_mint_property_tokens(&id)),
        Error::NotVerified.into()
    );

    f.client.verify_property(&id);
    assert_eq!(
        err_of(f.client.try_mint_property_tokens(&id)),
        Error::NotValued.into()
    );
}

#[test]
fn collateral_token_requires_tokenization() {
    let f = setup();
    let id = f.submit();

    assert_eq!(
        err_of(f.client.try_get_collateral_token(&id)),
        Error::NotTokenized.into()
    );
}

#[test]
fn update_status_preserves_the_other_fields() {
    let f = setup();
    let id = f.submit();
    f.client.verify_property(&id);
    f.client.set_valuation(&id, &500);

    let before = f.client.get_property(&id);
    f.client.update_status(&id, &PropertyStatus::Mortgaged);
    let after = f.client.get_property(&id);

    assert_eq!(after.status, PropertyStatus::Mortgaged);
    assert_eq!(after.usdc_value, before.usdc_value);
    assert_eq!(after.trustee, before.trustee);
    assert_eq!(after.title_hash, before.title_hash);
    assert_eq!(after.survey_doc_hash, before.survey_doc_hash);
}

#[test]
fn admin_lookup_fails_before_initialization() {
    let env = Env::default();
    let client = PropertyRegistryClient::new(&env, &env.register(PropertyRegistry, ()));

    assert_eq!(err_of(client.try_get_admin()), Error::NotInitialized.into());
}

/// Event topics and payload shapes are the observable interface indexers key
/// off. Both changed here -- topics were shortened to fit `symbol_short!`'s
/// nine-character limit, and the payloads now come from `#[contractevent]`
/// types -- so pin them.
#[test]
fn events_carry_the_expected_topics_and_payloads() {
    use soroban_sdk::{symbol_short, testutils::Events as _, vec, IntoVal};

    let f = setup();

    let id = f.submit();
    assert_eq!(
        f.env.events().all(),
        vec![
            &f.env,
            (
                f.contract_id.clone(),
                vec![
                    &f.env,
                    symbol_short!("submitted").into_val(&f.env),
                    id.into_val(&f.env)
                ],
                // data_format = "vec": the two non-topic fields, positionally.
                (f.trustee.clone(), hash(&f.env, 1)).into_val(&f.env),
            ),
        ]
    );

    f.client.verify_property(&id);
    assert_eq!(
        f.env.events().all(),
        vec![
            &f.env,
            (
                f.contract_id.clone(),
                vec![
                    &f.env,
                    symbol_short!("verified").into_val(&f.env),
                    id.into_val(&f.env)
                ],
                // data_format = "single-value": the lone field, unwrapped.
                hash(&f.env, 1).into_val(&f.env),
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
    assert_eq!(f.client.version(), crate::CONTRACT_VERSION);
}

/// `upgrade` is admin-gated through `require_auth`, which binds the signature to
/// this invocation and its arguments. With auth mocked off, a call that carries
/// no admin authorisation must fail.
#[test]
fn upgrade_requires_admin_authorization() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(PropertyRegistry, ());
    let client = PropertyRegistryClient::new(&env, &contract_id);
    client.initialize(&Address::generate(&env));

    env.set_auths(&[]);
    assert!(client
        .try_upgrade(&BytesN::from_array(&env, &[9u8; 32]))
        .is_err());
}

#[test]
fn admin_handover_requires_both_sides() {
    let f = setup();
    let next = Address::generate(&f.env);

    assert_eq!(f.client.get_pending_admin(), None);

    f.client.propose_admin(&next);
    assert_eq!(f.client.get_pending_admin(), Some(next.clone()));
    // Proposing does not hand over anything on its own.
    assert_eq!(f.client.get_admin(), f.admin);

    f.client.accept_admin();
    assert_eq!(f.client.get_admin(), next);
    assert_eq!(f.client.get_pending_admin(), None);
}

#[test]
fn accepting_without_a_proposal_fails() {
    let f = setup();
    assert_eq!(
        err_of(f.client.try_accept_admin()),
        Error::NoPendingAdmin.into()
    );
}

#[test]
fn a_proposal_can_be_cancelled() {
    let f = setup();
    f.client.propose_admin(&Address::generate(&f.env));

    f.client.cancel_admin_proposal();

    assert_eq!(f.client.get_pending_admin(), None);
    assert_eq!(
        err_of(f.client.try_accept_admin()),
        Error::NoPendingAdmin.into()
    );
}

/// The point of the two-step flow: only the proposed address can complete it,
/// so an admin cannot be handed to a key that turns out to be unusable.
#[test]
fn only_the_proposed_address_can_accept() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(PropertyRegistry, ());
    let client = PropertyRegistryClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);
    client.propose_admin(&Address::generate(&env));

    env.set_auths(&[]);
    assert!(client.try_accept_admin().is_err());
    assert_eq!(client.get_admin(), admin);
}

/// After a handover the old admin is powerless and the new one is in control.
#[test]
fn handover_moves_upgrade_rights() {
    let f = setup();
    let next = Address::generate(&f.env);
    f.client.propose_admin(&next);
    f.client.accept_admin();

    // `setup` mocks all auths, so authorisation is not what is under test here;
    // what matters is that the stored admin is the one the guard now reads.
    assert_eq!(f.client.get_admin(), next);
    f.client.verify_property(&f.submit());
}
