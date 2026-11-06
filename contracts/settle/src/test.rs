#![cfg(test)]
extern crate std;

use super::*;
use soroban_sdk::{
    contract, contractimpl,
    testutils::{Address as _, Ledger, MockAuth, MockAuthInvoke},
    token::{StellarAssetClient, TokenClient},
    Address, Env, IntoVal, Val, Vec,
};

/// A token that lies: the recipient is credited 90% of what `transfer` says. The contract must trust its own
/// balance measurement, not the amount it asked to move.
#[contracttype]
#[derive(Clone)]
enum SkimKey {
    Bal(Address),
}

#[contract]
struct SkimToken;

#[contractimpl]
impl SkimToken {
    pub fn mint(env: Env, to: Address, amount: i128) {
        env.storage().persistent().set(&SkimKey::Bal(to), &amount);
    }
    pub fn balance(env: Env, id: Address) -> i128 {
        env.storage().persistent().get(&SkimKey::Bal(id)).unwrap_or(0)
    }
    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
        from.require_auth();
        let f: i128 = Self::balance(env.clone(), from.clone());
        let t: i128 = Self::balance(env.clone(), to.clone());
        env.storage().persistent().set(&SkimKey::Bal(from), &(f - amount));
        env.storage().persistent().set(&SkimKey::Bal(to), &(t + amount * 9 / 10));
    }
}

struct Setup {
    env: Env,
    settle: Address,
    user: Address,
    solver: Address,
    token_in: Address,
    token_out: Address,
}

fn setup() -> Setup {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);
    let admin = Address::generate(&env);
    let token_in = env.register_stellar_asset_contract_v2(admin.clone()).address();
    let token_out = env.register_stellar_asset_contract_v2(admin).address();
    let settle = env.register(Settle, ());
    let user = Address::generate(&env);
    let solver = Address::generate(&env);
    StellarAssetClient::new(&env, &token_in).mint(&user, &1_000);
    StellarAssetClient::new(&env, &token_out).mint(&solver, &1_000);
    Setup { env, settle, user, solver, token_in, token_out }
}

fn order(s: &Setup) -> Order {
    Order {
        user: s.user.clone(),
        token_in: s.token_in.clone(),
        amount_in: 100,
        token_out: s.token_out.clone(),
        min_out: 90,
        deadline: 2_000,
        create_trustline: false,
    }
}

/// Fill with exactly the authorizations a real signer and solver would produce, no more.
/// `signed` is what the user signed; `submitted` is what the solver passes to `fill`.
/// `signed_transfer` is the input transfer amount the user's tree authorizes.
fn fill(
    s: &Setup,
    signed: &Order,
    signed_transfer: i128,
    submitted: &Order,
    solver: &Address,
    amount_out: i128,
    user_signs: bool,
) -> bool {
    let env = &s.env;
    let signed_args: Vec<Val> = (signed.clone(),).into_val(env);
    let transfer_args: Vec<Val> = (s.user.clone(), s.settle.clone(), signed_transfer).into_val(env);
    let fill_args: Vec<Val> = (submitted.clone(), solver.clone(), amount_out).into_val(env);
    let pay_args: Vec<Val> = (solver.clone(), s.user.clone(), amount_out).into_val(env);
    let user_sub = [MockAuthInvoke { contract: &s.token_in, fn_name: "transfer", args: transfer_args, sub_invokes: &[] }];
    let solver_sub = [MockAuthInvoke { contract: &s.token_out, fn_name: "transfer", args: pay_args, sub_invokes: &[] }];
    let user_auth = MockAuth {
        address: &s.user,
        invoke: &MockAuthInvoke { contract: &s.settle, fn_name: "fill", args: signed_args, sub_invokes: &user_sub },
    };
    let solver_auth = MockAuth {
        address: solver,
        invoke: &MockAuthInvoke { contract: &s.settle, fn_name: "fill", args: fill_args, sub_invokes: &solver_sub },
    };
    if user_signs {
        env.mock_auths(&[user_auth, solver_auth]);
    } else {
        env.mock_auths(&[solver_auth]);
    }
    SettleClient::new(env, &s.settle).try_fill(submitted, solver, &amount_out).is_ok()
}

fn bal(s: &Setup, token: &Address, who: &Address) -> i128 {
    TokenClient::new(&s.env, token).balance(who)
}

#[test]
fn fills_atomically_and_the_contract_keeps_nothing() {
    let s = setup();
    let o = order(&s);
    assert!(fill(&s, &o, 100, &o, &s.solver, 95, true));
    assert_eq!(bal(&s, &s.token_in, &s.user), 900);
    assert_eq!(bal(&s, &s.token_out, &s.user), 95);
    assert_eq!(bal(&s, &s.token_in, &s.solver), 100);
    assert_eq!(bal(&s, &s.token_out, &s.solver), 905);
    assert_eq!(bal(&s, &s.token_in, &s.settle), 0);
    assert_eq!(bal(&s, &s.token_out, &s.settle), 0);
}

#[test]
fn the_user_signature_does_not_name_the_solver_so_any_solver_can_fill() {
    let s = setup();
    let other = Address::generate(&s.env);
    StellarAssetClient::new(&s.env, &s.token_out).mint(&other, &1_000);
    let o = order(&s);
    // Same user-signed tree as the test above; only the solver differs.
    assert!(fill(&s, &o, 100, &o, &other, 91, true));
    assert_eq!(bal(&s, &s.token_out, &s.user), 91);
    assert_eq!(bal(&s, &s.token_in, &other), 100);
}

#[test]
fn a_solver_cannot_fill_without_the_user_signature() {
    let s = setup();
    let o = order(&s);
    assert!(!fill(&s, &o, 100, &o, &s.solver, 95, false));
    assert_eq!(bal(&s, &s.token_in, &s.user), 1_000);
}

#[test]
fn a_solver_cannot_change_the_order_the_user_signed() {
    let s = setup();
    let signed = order(&s);
    let mut bigger = signed.clone();
    bigger.amount_in = 200;
    assert!(!fill(&s, &signed, 100, &bigger, &s.solver, 95, true), "larger amount_in than signed");
    let mut cheaper = signed.clone();
    cheaper.min_out = 1;
    assert!(!fill(&s, &signed, 100, &cheaper, &s.solver, 1, true), "lower min_out than signed");
    assert_eq!(bal(&s, &s.token_in, &s.user), 1_000);
}

#[test]
fn the_input_transfer_the_user_authorized_must_match_the_order() {
    let s = setup();
    let o = order(&s);
    // The user's tree authorizes moving 50, the order says 100.
    assert!(!fill(&s, &o, 50, &o, &s.solver, 95, true));
    assert_eq!(bal(&s, &s.token_in, &s.user), 1_000);
}

#[test]
fn paying_less_than_min_out_is_rejected_before_anything_moves() {
    let s = setup();
    let o = order(&s);
    assert!(!fill(&s, &o, 100, &o, &s.solver, 89, true));
    assert_eq!(bal(&s, &s.token_in, &s.user), 1_000);
}

#[test]
fn a_token_that_credits_less_than_it_says_is_caught_by_the_measured_balance() {
    let s = setup();
    let skim = s.env.register(SkimToken, ());
    SkimTokenClient::new(&s.env, &skim).mint(&s.solver, &1_000);
    let mut o = order(&s);
    o.token_out = skim.clone();
    let s2 = Setup { env: s.env.clone(), settle: s.settle.clone(), user: s.user.clone(), solver: s.solver.clone(), token_in: s.token_in.clone(), token_out: skim.clone() };
    // The solver "pays" 95 but the user is credited 85, which is below min_out 90.
    assert!(!fill(&s2, &o, 100, &o, &s.solver, 95, true));
    assert_eq!(bal(&s, &s.token_in, &s.user), 1_000, "whole transaction rolled back");
    // Paying 100 gets the user 90, exactly min_out, so it fills and the user is credited the measured amount.
    assert!(fill(&s2, &o, 100, &o, &s.solver, 100, true));
    assert_eq!(SkimTokenClient::new(&s.env, &skim).balance(&s.user), 90);
}

#[test]
fn an_expired_order_cannot_be_filled() {
    let s = setup();
    let o = order(&s);
    s.env.ledger().set_timestamp(2_001);
    assert!(!fill(&s, &o, 100, &o, &s.solver, 95, true));
    assert_eq!(bal(&s, &s.token_in, &s.user), 1_000);
}

#[test]
fn the_user_cannot_be_their_own_solver_and_tokens_must_differ() {
    let s = setup();
    let o = order(&s);
    assert!(!fill(&s, &o, 100, &o, &s.user.clone(), 95, true));
    let mut same = o.clone();
    same.token_out = same.token_in.clone();
    assert!(!fill(&s, &same, 100, &same, &s.solver, 95, true));
}
