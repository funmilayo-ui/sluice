#![no_std]
//! Sluice settlement: a user-signed order that any solver can fill, atomically, in one Soroban transaction.
//!
//! Why it exists. A Soroban transaction holds a single operation, so a route that needs Classic liquidity
//! (SDEX, Classic pools) cannot share a transaction with a Soroban leg (CAP-0073, CAP-0077), and no host
//! function reaches the Classic DEX. But every asset movement the USER sees can happen on the Soroban side:
//! the Stellar Asset Contract moves Classic assets too. Only the hedge needs Classic liquidity, and the
//! solver carries that, with its own inventory, outside this transaction. From the user's side the whole
//! route is one atomic invocation: input leaves, at least `min_out` arrives, or nothing happens.
//!
//! What the user signs (a Soroban auth entry, not a transaction):
//!   fill(order)                                     root, bound to the exact `order`, not to the solver
//!     [token_out.trust(user)]                       only when `order.create_trustline`
//!     token_in.transfer(user, <this contract>, amount_in)
//! The solver, the amount it pays and the transaction fee are the solver's business. Because the signed tree
//! fixes the contract, the order and the exact input transfer, a solver cannot take more than `amount_in`,
//! cannot redirect it, and cannot be paid unless the user's own balance of `token_out` grew by `min_out`.
//!
//! Non-custodial: input passes through this contract for the length of one invocation and is forwarded to the
//! solver in the same call. The contract keeps no balance and holds no admin key. Replay is prevented by the
//! nonce in the user's auth entry; staleness by `deadline` and the entry's own expiration ledger.

use soroban_sdk::{
    contract, contractclient, contracterror, contractevent, contractimpl, contracttype, token, vec,
    Address, Env, IntoVal,
};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    BadAmount = 1,
    SameToken = 2,
    Expired = 3,
    BadSolver = 4,
    BelowMinOut = 5,
}

/// What the user signs. Everything that matters to the user is in here, so the user's signature covers it.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Order {
    pub user: Address,
    pub token_in: Address,
    pub amount_in: i128,
    pub token_out: Address,
    /// The user's `token_out` balance must grow by at least this much. Measured, never taken from a return value.
    pub min_out: i128,
    /// Ledger close time (unix seconds) after which the order cannot be filled.
    pub deadline: u64,
    /// Create the user's `token_out` trustline inside this transaction (CAP-0073). Classic assets only.
    pub create_trustline: bool,
}

/// CAP-0073: `trust` on a Stellar Asset Contract creates an unlimited trustline for a G-account, requires
/// that account's authorization when it actually creates one, and is a no-op if one exists.
#[contractclient(name = "SacTrustClient")]
#[allow(dead_code)]
pub trait SacTrust {
    fn trust(env: Env, addr: Address);
}

#[contractevent]
pub struct Filled {
    #[topic]
    pub user: Address,
    #[topic]
    pub solver: Address,
    pub token_in: Address,
    pub token_out: Address,
    pub amount_in: i128,
    pub amount_out: i128,
}

#[contract]
pub struct Settle;

#[contractimpl]
impl Settle {
    /// Fill `order` as `solver`, paying the user `amount_out` of `token_out` in exchange for `amount_in` of
    /// `token_in`. Returns the amount the user's balance actually grew by.
    pub fn fill(env: Env, order: Order, solver: Address, amount_out: i128) -> Result<i128, Error> {
        if order.amount_in <= 0 || order.min_out <= 0 || amount_out < order.min_out {
            return Err(Error::BadAmount);
        }
        if order.token_in == order.token_out {
            return Err(Error::SameToken);
        }
        if env.ledger().timestamp() > order.deadline {
            return Err(Error::Expired);
        }
        let this = env.current_contract_address();
        if solver == order.user || solver == this {
            return Err(Error::BadSolver);
        }

        // The user's signature binds the order only. `solver` and `amount_out` are deliberately outside it,
        // so any solver can fill and the user need not know who, or how much above `min_out`, in advance.
        order
            .user
            .require_auth_for_args(vec![&env, order.clone().into_val(&env)]);
        solver.require_auth();

        if order.create_trustline {
            SacTrustClient::new(&env, &order.token_out).trust(&order.user);
        }

        let out = token::Client::new(&env, &order.token_out);
        let before = out.balance(&order.user);

        let tin = token::Client::new(&env, &order.token_in);
        tin.transfer(&order.user, &this, &order.amount_in);
        tin.transfer(&this, &solver, &order.amount_in);

        out.transfer(&solver, &order.user, &amount_out);

        let delta = out.balance(&order.user) - before;
        if delta < order.min_out {
            return Err(Error::BelowMinOut);
        }
        Filled {
            user: order.user,
            solver,
            token_in: order.token_in,
            token_out: order.token_out,
            amount_in: order.amount_in,
            amount_out: delta,
        }
        .publish(&env);
        Ok(delta)
    }
}

#[cfg(test)]
mod test;
