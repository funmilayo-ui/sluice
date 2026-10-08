#![no_std]
//! Sluice atomic router (Soroban-only path).
//!
//! Scope: executes a chain of swaps on allowlisted Soroswap-style router contracts inside ONE
//! invocation, so the whole chain is atomic. Classic (SDEX / Classic pool) liquidity is NOT
//! reachable from a contract, so cross-layer routes are handled off-chain as separate transactions.
//!
//! Design choices:
//! - Non-custodial: the user is the `to` of every leg, so funds never rest in this contract and
//!   the user's auth tree (recorded by simulation) covers every token transfer.
//! - The contract never trusts a venue's return value. It measures the user's balance delta of each
//!   leg's output token and feeds that into the next leg, then enforces `min_out` on the final delta.
//! - Venues must be allowlisted by the admin.
//!
//! Venue kinds implemented (each signature checked against the on-chain interface with
//! `stellar contract info interface` on 2026-10-08):
//! - Soroswap-style router `swap_exact_tokens_for_tokens`
//! - Phoenix pool `swap` (a pool contract, not a router; `venue` is the pool address, `path` is [offer, ask])
//! - Comet pool `swap_exact_amount_in` (same: `venue` is the pool, `path` is [in, out])
//! Aquarius is NOT routed through this contract: its router is called directly with `swap_chained`, using the
//! `swap_chain_xdr` from its API. Calling Phoenix/Comet pools directly as the user needs no prior approval.

use soroban_sdk::{
    contract, contractclient, contracterror, contractevent, contractimpl, contracttype, token,
    Address, Env, Vec,
};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    VenueNotAllowed = 3,
    EmptyRoute = 4,
    BadPath = 5,
    BadAmount = 6,
    SlippageExceeded = 7,
    RouteTooLong = 8,
    Expired = 9,
}

const MAX_LEGS: u32 = 4;

#[contracttype]
#[derive(Clone)]
enum Key {
    Admin,
    Venue(Address),
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum VenueKind {
    /// `venue` is a Soroswap-style router; `path` may have more than two tokens.
    Soroswap,
    /// `venue` is a Phoenix pool; `path` must be exactly [offer asset, ask asset].
    Phoenix,
    /// `venue` is a Comet pool; `path` must be exactly [token in, token out].
    Comet,
}

/// One swap on one venue. `path` is the venue's token path; first = input, last = output.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Leg {
    pub kind: VenueKind,
    pub path: Vec<Address>,
    pub venue: Address,
}

/// Largest price Comet accepts; the real guard is the final min_out on measured balance change.
const COMET_MAX_PRICE: i128 = 18_446_744_073_709_551_615;

#[contractclient(name = "SoroswapRouterClient")]
#[allow(dead_code)]
pub trait SoroswapRouter {
    fn swap_exact_tokens_for_tokens(
        env: Env,
        amount_in: i128,
        amount_out_min: i128,
        path: Vec<Address>,
        to: Address,
        deadline: u64,
    ) -> Vec<i128>;
}

#[contractclient(name = "PhoenixPoolClient")]
#[allow(dead_code)]
pub trait PhoenixPool {
    fn swap(
        env: Env,
        sender: Address,
        offer_asset: Address,
        offer_amount: i128,
        ask_asset_min_amount: Option<i128>,
        max_spread_bps: Option<i64>,
        deadline: Option<u64>,
        max_allowed_fee_bps: Option<i64>,
    ) -> i128;
}

#[contractclient(name = "CometPoolClient")]
#[allow(dead_code)]
pub trait CometPool {
    fn swap_exact_amount_in(
        env: Env,
        token_in: Address,
        token_amount_in: i128,
        token_out: Address,
        min_amount_out: i128,
        max_price: i128,
        user: Address,
    ) -> (i128, i128);
}

#[contractevent]
pub struct Swapped {
    #[topic]
    pub user: Address,
    pub token_in: Address,
    pub token_out: Address,
    pub amount_in: i128,
    pub amount_out: i128,
    pub legs: u32,
}

#[contract]
pub struct SluiceRouter;

#[contractimpl]
impl SluiceRouter {
    pub fn init(env: Env, admin: Address) -> Result<(), Error> {
        if env.storage().instance().has(&Key::Admin) {
            return Err(Error::AlreadyInitialized);
        }
        env.storage().instance().set(&Key::Admin, &admin);
        Ok(())
    }

    pub fn set_venue(env: Env, venue: Address, allowed: bool) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&Key::Admin)
            .ok_or(Error::NotInitialized)?;
        admin.require_auth();
        if allowed {
            env.storage().persistent().set(&Key::Venue(venue), &true);
        } else {
            env.storage().persistent().remove(&Key::Venue(venue));
        }
        Ok(())
    }

    pub fn is_venue(env: Env, venue: Address) -> bool {
        env.storage().persistent().has(&Key::Venue(venue))
    }

    /// Execute `legs` for `user`. Leg i+1 spends exactly what leg i delivered. Reverts unless the
    /// user's balance of the final token grows by at least `min_out`. Returns the realised output.
    pub fn swap_exact_in(
        env: Env,
        user: Address,
        legs: Vec<Leg>,
        amount_in: i128,
        min_out: i128,
        deadline: u64,
    ) -> Result<i128, Error> {
        user.require_auth();
        if amount_in <= 0 || min_out < 0 {
            return Err(Error::BadAmount);
        }
        if legs.is_empty() {
            return Err(Error::EmptyRoute);
        }
        if legs.len() > MAX_LEGS {
            return Err(Error::RouteTooLong);
        }
        if env.ledger().timestamp() > deadline {
            return Err(Error::Expired);
        }

        let first = legs.get_unchecked(0);
        let token_in = first.path.get(0).ok_or(Error::BadPath)?;
        let mut spend = amount_in;
        let mut prev_out: Option<Address> = None;
        let mut final_token = token_in.clone();
        let mut realised: i128 = 0;

        for i in 0..legs.len() {
            let leg = legs.get_unchecked(i);
            if !Self::is_venue(env.clone(), leg.venue.clone()) {
                return Err(Error::VenueNotAllowed);
            }
            if leg.path.len() < 2 {
                return Err(Error::BadPath);
            }
            // Pool venues swap exactly one pair.
            if leg.kind != VenueKind::Soroswap && leg.path.len() != 2 {
                return Err(Error::BadPath);
            }
            let leg_in = leg.path.get_unchecked(0);
            let leg_out = leg.path.get_unchecked(leg.path.len() - 1);
            if let Some(p) = &prev_out {
                if *p != leg_in {
                    return Err(Error::BadPath);
                }
            }

            let out_token = token::Client::new(&env, &leg_out);
            let before = out_token.balance(&user);
            // amount_out_min = 0 per leg: the binding check is the final min_out on measured delta.
            match leg.kind {
                VenueKind::Soroswap => {
                    SoroswapRouterClient::new(&env, &leg.venue).swap_exact_tokens_for_tokens(
                        &spend,
                        &0,
                        &leg.path,
                        &user,
                        &deadline,
                    );
                }
                VenueKind::Phoenix => {
                    PhoenixPoolClient::new(&env, &leg.venue).swap(
                        &user, &leg_in, &spend, &None, &None, &None, &None,
                    );
                }
                VenueKind::Comet => {
                    CometPoolClient::new(&env, &leg.venue).swap_exact_amount_in(
                        &leg_in,
                        &spend,
                        &leg_out,
                        &1,
                        &COMET_MAX_PRICE,
                        &user,
                    );
                }
            }
            realised = out_token.balance(&user) - before;
            if realised <= 0 {
                return Err(Error::SlippageExceeded);
            }
            spend = realised;
            prev_out = Some(leg_out.clone());
            final_token = leg_out;
        }

        if realised < min_out {
            return Err(Error::SlippageExceeded);
        }
        Swapped {
            user,
            token_in,
            token_out: final_token,
            amount_in,
            amount_out: realised,
            legs: legs.len(),
        }
        .publish(&env);
        Ok(realised)
    }
}

#[cfg(test)]
mod test;
