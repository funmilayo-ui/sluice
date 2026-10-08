#![cfg(test)]
extern crate std;

use super::*;
use soroban_sdk::{
    contract, contractimpl, contracttype,
    testutils::{Address as _, Ledger},
    token::{StellarAssetClient, TokenClient},
    vec, Address, Env, Vec,
};

/// Mock Soroswap-style router: pulls `amount_in` from `to`, pays `amount_in * rate / 10_000`
/// of the last path token from its own balance.
#[contracttype]
#[derive(Clone)]
enum MockKey {
    Rate,
    Out,
}

#[contract]
struct MockRouter;

#[contractimpl]
impl MockRouter {
    pub fn set_rate(env: Env, rate: i128) {
        env.storage().instance().set(&MockKey::Rate, &rate);
    }

    pub fn swap_exact_tokens_for_tokens(
        env: Env,
        amount_in: i128,
        _amount_out_min: i128,
        path: Vec<Address>,
        to: Address,
        _deadline: u64,
    ) -> Vec<i128> {
        to.require_auth();
        let rate: i128 = env.storage().instance().get(&MockKey::Rate).unwrap();
        let tin = TokenClient::new(&env, &path.get_unchecked(0));
        let tout = TokenClient::new(&env, &path.get_unchecked(path.len() - 1));
        let out = amount_in * rate / 10_000;
        tin.transfer(&to, &env.current_contract_address(), &amount_in);
        tout.transfer(&env.current_contract_address(), &to, &out);
        vec![&env, amount_in, out]
    }
}

/// Mock Phoenix pool with the real `swap` signature. Pays `amount * rate / 10_000` of the other token.
#[contract]
struct MockPhoenix;

#[contractimpl]
impl MockPhoenix {
    pub fn set_rate(env: Env, rate: i128) {
        env.storage().instance().set(&MockKey::Rate, &rate);
    }
    pub fn set_out(env: Env, out_token: Address) {
        env.storage().instance().set(&MockKey::Out, &out_token);
    }

    #[allow(clippy::too_many_arguments)]
    pub fn swap(
        env: Env,
        sender: Address,
        offer_asset: Address,
        offer_amount: i128,
        _ask_asset_min_amount: Option<i128>,
        _max_spread_bps: Option<i64>,
        _deadline: Option<u64>,
        _max_allowed_fee_bps: Option<i64>,
    ) -> i128 {
        sender.require_auth();
        let rate: i128 = env.storage().instance().get(&MockKey::Rate).unwrap();
        let out_token: Address = env.storage().instance().get(&MockKey::Out).unwrap();
        let out = offer_amount * rate / 10_000;
        TokenClient::new(&env, &offer_asset).transfer(&sender, &env.current_contract_address(), &offer_amount);
        TokenClient::new(&env, &out_token).transfer(&env.current_contract_address(), &sender, &out);
        out
    }
}

/// Mock Comet pool with the real `swap_exact_amount_in` signature.
#[contract]
struct MockComet;

#[contractimpl]
impl MockComet {
    pub fn set_rate(env: Env, rate: i128) {
        env.storage().instance().set(&MockKey::Rate, &rate);
    }

    pub fn swap_exact_amount_in(
        env: Env,
        token_in: Address,
        token_amount_in: i128,
        token_out: Address,
        min_amount_out: i128,
        _max_price: i128,
        user: Address,
    ) -> (i128, i128) {
        user.require_auth();
        let rate: i128 = env.storage().instance().get(&MockKey::Rate).unwrap();
        let out = token_amount_in * rate / 10_000;
        assert!(out >= min_amount_out, "min out");
        TokenClient::new(&env, &token_in).transfer(&user, &env.current_contract_address(), &token_amount_in);
        TokenClient::new(&env, &token_out).transfer(&env.current_contract_address(), &user, &out);
        (out, 0)
    }
}

struct Fixture {
    env: Env,
    router: SluiceRouterClient<'static>,
    user: Address,
    a: Address,
    b: Address,
    c: Address,
    v1: Address,
    v2: Address,
}

fn setup() -> Fixture {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);
    let admin = Address::generate(&env);
    let user = Address::generate(&env);

    let id = env.register(SluiceRouter, ());
    let router = SluiceRouterClient::new(&env, &id);
    router.init(&admin);

    let mk = |env: &Env| env.register_stellar_asset_contract_v2(admin.clone()).address();
    let (a, b, c) = (mk(&env), mk(&env), mk(&env));
    StellarAssetClient::new(&env, &a).mint(&user, &1_000_000);

    let v1 = env.register(MockRouter, ());
    let v2 = env.register(MockRouter, ());
    MockRouterClient::new(&env, &v1).set_rate(&20_000); // 2.0x
    MockRouterClient::new(&env, &v2).set_rate(&5_000); // 0.5x
    // Fund venues with output liquidity.
    StellarAssetClient::new(&env, &b).mint(&v1, &10_000_000);
    StellarAssetClient::new(&env, &c).mint(&v2, &10_000_000);

    router.set_venue(&v1, &true);
    router.set_venue(&v2, &true);
    Fixture { env, router, user, a, b, c, v1, v2 }
}

fn leg(f: &Fixture, venue: &Address, path: &[&Address]) -> Leg {
    let mut p = Vec::new(&f.env);
    for t in path {
        p.push_back((*t).clone());
    }
    Leg { kind: VenueKind::Soroswap, venue: venue.clone(), path: p }
}

fn leg_kind(f: &Fixture, kind: VenueKind, venue: &Address, path: &[&Address]) -> Leg {
    Leg { kind, ..leg(f, venue, path) }
}

#[test]
fn single_leg_swaps_and_reports_realised_output() {
    let f = setup();
    let legs = vec![&f.env, leg(&f, &f.v1, &[&f.a, &f.b])];
    let out = f.router.swap_exact_in(&f.user, &legs, &1_000, &2_000, &2_000);
    assert_eq!(out, 2_000);
    assert_eq!(TokenClient::new(&f.env, &f.a).balance(&f.user), 999_000);
    assert_eq!(TokenClient::new(&f.env, &f.b).balance(&f.user), 2_000);
    // Router holds nothing: non-custodial.
    assert_eq!(TokenClient::new(&f.env, &f.a).balance(&f.router.address), 0);
    assert_eq!(TokenClient::new(&f.env, &f.b).balance(&f.router.address), 0);
}

#[test]
fn two_legs_chain_on_measured_delta() {
    let f = setup();
    // a -2x-> b -0.5x-> c : 1_000 -> 2_000 -> 1_000
    let legs = vec![&f.env, leg(&f, &f.v1, &[&f.a, &f.b]), leg(&f, &f.v2, &[&f.b, &f.c])];
    let out = f.router.swap_exact_in(&f.user, &legs, &1_000, &1_000, &2_000);
    assert_eq!(out, 1_000);
    assert_eq!(TokenClient::new(&f.env, &f.c).balance(&f.user), 1_000);
    assert_eq!(TokenClient::new(&f.env, &f.b).balance(&f.user), 0);
}

#[test]
fn reverts_when_below_min_out_and_rolls_back_state() {
    let f = setup();
    let legs = vec![&f.env, leg(&f, &f.v1, &[&f.a, &f.b])];
    let r = f.router.try_swap_exact_in(&f.user, &legs, &1_000, &2_001, &2_000);
    assert_eq!(r, Err(Ok(Error::SlippageExceeded)));
    assert_eq!(TokenClient::new(&f.env, &f.a).balance(&f.user), 1_000_000);
}

#[test]
fn rejects_unlisted_venue() {
    let f = setup();
    let rogue = f.env.register(MockRouter, ());
    let legs = vec![&f.env, leg(&f, &rogue, &[&f.a, &f.b])];
    let r = f.router.try_swap_exact_in(&f.user, &legs, &1_000, &0, &2_000);
    assert_eq!(r, Err(Ok(Error::VenueNotAllowed)));
}

#[test]
fn rejects_discontinuous_path() {
    let f = setup();
    // leg 2 starts at a, but leg 1 ended at b
    let legs = vec![&f.env, leg(&f, &f.v1, &[&f.a, &f.b]), leg(&f, &f.v2, &[&f.a, &f.c])];
    let r = f.router.try_swap_exact_in(&f.user, &legs, &1_000, &0, &2_000);
    assert_eq!(r, Err(Ok(Error::BadPath)));
}

#[test]
fn rejects_expired_empty_and_bad_amounts() {
    let f = setup();
    let legs = vec![&f.env, leg(&f, &f.v1, &[&f.a, &f.b])];
    assert_eq!(f.router.try_swap_exact_in(&f.user, &legs, &1_000, &0, &999), Err(Ok(Error::Expired)));
    assert_eq!(
        f.router.try_swap_exact_in(&f.user, &Vec::new(&f.env), &1_000, &0, &2_000),
        Err(Ok(Error::EmptyRoute))
    );
    assert_eq!(f.router.try_swap_exact_in(&f.user, &legs, &0, &0, &2_000), Err(Ok(Error::BadAmount)));
}

#[test]
fn rejects_too_many_legs() {
    let f = setup();
    let l = leg(&f, &f.v1, &[&f.a, &f.b]);
    let legs = vec![&f.env, l.clone(), l.clone(), l.clone(), l.clone(), l];
    assert_eq!(f.router.try_swap_exact_in(&f.user, &legs, &1_000, &0, &2_000), Err(Ok(Error::RouteTooLong)));
}

#[test]
fn init_twice_fails_and_venue_can_be_removed() {
    let f = setup();
    assert_eq!(f.router.try_init(&Address::generate(&f.env)), Err(Ok(Error::AlreadyInitialized)));
    assert!(f.router.is_venue(&f.v1));
    f.router.set_venue(&f.v1, &false);
    assert!(!f.router.is_venue(&f.v1));
}

#[test]
fn phoenix_pool_leg_swaps_for_the_user_without_custody() {
    let f = setup();
    let ph = f.env.register(MockPhoenix, ());
    let client = MockPhoenixClient::new(&f.env, &ph);
    client.set_rate(&30_000); // 3x
    client.set_out(&f.b);
    StellarAssetClient::new(&f.env, &f.b).mint(&ph, &10_000_000);
    f.router.set_venue(&ph, &true);

    let legs = vec![&f.env, leg_kind(&f, VenueKind::Phoenix, &ph, &[&f.a, &f.b])];
    let out = f.router.swap_exact_in(&f.user, &legs, &1_000, &3_000, &2_000);
    assert_eq!(out, 3_000);
    assert_eq!(TokenClient::new(&f.env, &f.b).balance(&f.user), 3_000);
    assert_eq!(TokenClient::new(&f.env, &f.a).balance(&f.router.address), 0);
}

#[test]
fn comet_pool_leg_swaps_for_the_user() {
    let f = setup();
    let co = f.env.register(MockComet, ());
    MockCometClient::new(&f.env, &co).set_rate(&5_000); // 0.5x
    StellarAssetClient::new(&f.env, &f.b).mint(&co, &10_000_000);
    f.router.set_venue(&co, &true);

    let legs = vec![&f.env, leg_kind(&f, VenueKind::Comet, &co, &[&f.a, &f.b])];
    assert_eq!(f.router.swap_exact_in(&f.user, &legs, &1_000, &500, &2_000), 500);
}

#[test]
fn mixed_chain_across_three_venue_kinds_is_atomic() {
    let f = setup();
    // soroswap a->b (2x), phoenix b->c (0.5x), then comet c->a (2x): 1_000 -> 2_000 -> 1_000 -> 2_000
    let ph = f.env.register(MockPhoenix, ());
    let phc = MockPhoenixClient::new(&f.env, &ph);
    phc.set_rate(&5_000);
    phc.set_out(&f.c);
    StellarAssetClient::new(&f.env, &f.c).mint(&ph, &10_000_000);
    let co = f.env.register(MockComet, ());
    MockCometClient::new(&f.env, &co).set_rate(&20_000);
    StellarAssetClient::new(&f.env, &f.a).mint(&co, &10_000_000);
    f.router.set_venue(&ph, &true);
    f.router.set_venue(&co, &true);

    let legs = vec![
        &f.env,
        leg(&f, &f.v1, &[&f.a, &f.b]),
        leg_kind(&f, VenueKind::Phoenix, &ph, &[&f.b, &f.c]),
        leg_kind(&f, VenueKind::Comet, &co, &[&f.c, &f.a]),
    ];
    let out = f.router.swap_exact_in(&f.user, &legs, &1_000, &2_000, &2_000);
    assert_eq!(out, 2_000);
    // user started with 1_000_000 a, spent 1_000, received 2_000 back
    assert_eq!(TokenClient::new(&f.env, &f.a).balance(&f.user), 1_001_000);
    assert_eq!(TokenClient::new(&f.env, &f.b).balance(&f.user), 0);
    assert_eq!(TokenClient::new(&f.env, &f.c).balance(&f.user), 0);
}

#[test]
fn pool_venues_require_exactly_two_tokens() {
    let f = setup();
    let ph = f.env.register(MockPhoenix, ());
    f.router.set_venue(&ph, &true);
    let legs = vec![&f.env, leg_kind(&f, VenueKind::Phoenix, &ph, &[&f.a, &f.b, &f.c])];
    assert_eq!(f.router.try_swap_exact_in(&f.user, &legs, &1_000, &0, &2_000), Err(Ok(Error::BadPath)));
}

#[test]
fn a_failing_later_leg_rolls_back_the_earlier_leg() {
    let f = setup();
    // comet min_out assertion trips: rate 0 gives out 0 < min 1 (the contract passes min 1)
    let co = f.env.register(MockComet, ());
    MockCometClient::new(&f.env, &co).set_rate(&0);
    StellarAssetClient::new(&f.env, &f.c).mint(&co, &10_000_000);
    f.router.set_venue(&co, &true);
    let legs = vec![&f.env, leg(&f, &f.v1, &[&f.a, &f.b]), leg_kind(&f, VenueKind::Comet, &co, &[&f.b, &f.c])];
    assert!(f.router.try_swap_exact_in(&f.user, &legs, &1_000, &0, &2_000).is_err());
    assert_eq!(TokenClient::new(&f.env, &f.a).balance(&f.user), 1_000_000);
    assert_eq!(TokenClient::new(&f.env, &f.b).balance(&f.user), 0);
}
