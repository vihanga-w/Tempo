/**
 * The request headers the browser is allowed to send us.
 *
 * This list is load-bearing in a way that is easy to miss. A browser will not
 * send a request carrying a header the preflight did not name, and it fails
 * closed and silently from our side: we answer the OPTIONS, the real request
 * never arrives, and there is nothing in the log but an OPTIONS with no verb
 * behind it. The app, meanwhile, sits on a reply that is never coming.
 *
 * So adding a header to a request in the app is only half the change. The other
 * half is here, and forgetting it does not break loudly -- it hangs.
 */
export const ALLOWED_REQUEST_HEADERS = [
    "Access-Control-Allow-Headers",
    "Origin",
    "Accept",
    "X-Requested-With",
    "Content-Type",
    "Access-Control-Request-Method",
    "Access-Control-Request-Headers",
    "x-api-token",
    "x-tempo-client",
];

/** The header value itself, in the form the preflight expects. */
export const allowedRequestHeaders = () => ALLOWED_REQUEST_HEADERS.join(", ");
