import dns from "node:dns";
import net from "node:net";

/**
 * Some hosts have a broken IPv6 route, which makes Node's fetch fail with ETIMEDOUT while curl
 * (which falls back faster) works. Call this once at process start when SLUICE_IPV4_FIRST=1.
 */
export function preferIpv4(attemptTimeoutMs = 3000): void {
  dns.setDefaultResultOrder("ipv4first");
  net.setDefaultAutoSelectFamily(true);
  net.setDefaultAutoSelectFamilyAttemptTimeout(attemptTimeoutMs);
}
