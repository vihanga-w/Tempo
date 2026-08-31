/**
 * Whether an endpoint is safe to send a credential to.
 *
 * Its own module so there is exactly one definition of the rule. It is needed
 * both at boot, to tell an operator their configuration will not be used, and at
 * the moment a request carrying a bearer token is built — and env.ts cannot
 * import it from the caller without a cycle.
 *
 * Loopback over http is allowed. A local proxy is a real development setup and
 * the traffic never leaves the machine; refusing it would only push people
 * toward disabling the check outright.
 */

const LOOPBACK = ["localhost", "127.0.0.1", "[::1]", "::1"];

export function isSecureEndpoint(url: string): boolean {
    try {
        const parsed = new URL(url);

        if (parsed.protocol === "https:")
            return true;

        return (parsed.protocol === "http:" && LOOPBACK.includes(parsed.hostname));
    } catch {
        // An unparseable URL is not a safe one
        return false;
    }
}
