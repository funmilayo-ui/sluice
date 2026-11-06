/**
 * One account, one transaction sequence. An RPC node does not count a transaction it has accepted but not yet
 * closed in a ledger, so two sends in quick succession would both be built on the same sequence number and the
 * second would be refused (`txBadSeq`). This hands the account out one send at a time and remembers the last
 * sequence it used, so the next send builds on `max(chain, last)`.
 *
 * Fills and hedges signed by the same solver key MUST share one `Sequencer`.
 */
export class Sequencer {
  private last = 0n;
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private readSequence: () => Promise<bigint>) {}

  /**
   * Run `send` after every earlier call finished (whether it succeeded or not). `send` gets the account's current
   * sequence number (the transaction must use that plus one) and says whether the network accepted the transaction
   * (`accepted`, which advances the counter) or answered `txBadSeq` (`badSeq`, which forgets the counter).
   */
  run<T>(send: (accountSequence: bigint) => Promise<{ value: T; accepted: boolean; badSeq?: boolean }>): Promise<T> {
    const go = async (): Promise<T> => {
      const chainSeq = await this.readSequence();
      const base = chainSeq > this.last ? chainSeq : this.last;
      const r = await send(base);
      if (r.accepted) this.last = base + 1n;
      if (r.badSeq) this.last = 0n;
      return r.value;
    };
    const run = this.chain.then(go, go);
    this.chain = run.catch(() => undefined);
    return run;
  }
}
