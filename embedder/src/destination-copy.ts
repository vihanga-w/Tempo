/**
 * The sentence under a destination.
 *
 * The model does not choose anything. `destination.ts` has already picked the
 * country, found the bridge artist and computed which genres the two sides
 * share; all that is left is to say it in a way that sounds like a person wrote
 * it. So the prompt is handed those facts and told to phrase them, and the
 * output is checked against the same facts before it is used.
 *
 * That division matters. A model asked to *pick* a destination will happily
 * invent a scene that does not exist, and nobody reading the answer can tell.
 * A model asked to rewrite four known facts into one sentence can only really
 * fail by writing a bad sentence, which is a failure we can detect and discard.
 *
 * There is always a deterministic fallback, built from the same facts. A missing
 * key, a rate limit or a slow response costs the phrasing, never the feature.
 */

import { GROQ_API_KEY, GROQ_BASE_URL, GROQ_MODEL } from "./env";
import { isSecureEndpoint } from "./secure-url";
import type { Destination } from "./destination";

/** Long enough for two clauses, short enough to sit in a card on a phone. */
export const MAX_COPY_CHARS = 240;

export const GROQ_TIMEOUT_MS = 6000;

/**
 * Checked here as well as at boot, so the rule sits beside the request that
 * would leak the key rather than only in configuration, and a refusal degrades
 * to the template exactly like a missing key does.
 */
export { isSecureEndpoint } from "./secure-url";

const SYSTEM_PROMPT = [
    "You write one sentence for a music app that suggests a country to explore next.",
    "You are given facts. Use only those facts. Never invent an artist, a genre, a city, a statistic or a claim about anyone's listening.",
    "Write plainly and specifically, in British English, in the second person. No exclamation marks, no marketing language, no emoji, no markdown, no quotation marks.",
    "Do not greet the reader, do not name the app, and do not tell them to listen to anything.",
    "One sentence, at most 30 words.",
].join(" ");

/**
 * The template the feature runs on when there is no model.
 *
 * Written to be genuinely good rather than a placeholder, because most of the
 * time it may well be what people read.
 */
export function fallbackCopy(destination: Destination): string {
    const genres = destination.sharedGenres.slice(0, 2);
    const bridge = destination.bridge.name;

    if (genres.length >= 2)
        return `You already play ${bridge}, and ${destination.name} shares the ${genres[0]} and ${genres[1]} running through your rotation.`;

    if (genres.length === 1)
        return `You already play ${bridge}, and ${destination.name} shares the ${genres[0]} running through your rotation.`;

    if (destination.neverPlayed)
        return `You already play ${bridge}, and you have never played anything from ${destination.name}.`;

    return `You already play ${bridge}, and ${destination.name} is somewhere you have barely been.`;
}

function factSheet(destination: Destination): string {
    return [
        `Country: ${destination.name}`,
        `An artist they already listen to: ${destination.bridge.name}`,
        `Genres both share: ${destination.sharedGenres.join(", ") || "none recorded"}`,
        `Artists there they have never played: ${destination.fresh.map(f => f.name).join(", ")}`,
        destination.neverPlayed
            ? "They have never listened to an artist from this country."
            : "They have played a little from this country, but not enough to have been there.",
    ].join("\n");
}

/**
 * Whether a generated line is safe to show.
 *
 * The checks are all about the model saying something we did not give it. The
 * cheapest reliable signal is a digit: every fact here is a name or a genre, so
 * a number in the output is a statistic the model made up.
 */
export function isUsableCopy(text: string, destination: Destination): boolean {
    const trimmed = text.trim();

    if (trimmed.length === 0 || trimmed.length > MAX_COPY_CHARS)
        return false;

    // Invented figures -- "40% of your listening", "the 1970s scene"
    if (/\d/.test(trimmed))
        return false;

    if (/https?:\/\/|[*_`#|]|\n/.test(trimmed))
        return false;

    // Refusals and meta-commentary come back looking like prose
    if (/^(sure|certainly|here('s| is)|as an ai|i can|okay)\b/i.test(trimmed))
        return false;

    // It must actually be about the place it is under
    if (!trimmed.toLowerCase().includes(destination.name.toLowerCase()))
        return false;

    return true;
}

interface ChatResponse {
    choices?: { message?: { content?: string } }[];
}

/**
 * Ask Groq to phrase the destination, or fall back.
 *
 * Never throws and never returns an empty string: every path ends in copy.
 */
export async function writeDestinationCopy(
    destination: Destination,
    fetchImpl: typeof fetch = fetch,
): Promise<{ text: string; generated: boolean }> {
    const fallback = { text: fallbackCopy(destination), generated: false };

    if (!GROQ_API_KEY)
        return fallback;

    if (!isSecureEndpoint(GROQ_BASE_URL)) {
        console.error(
            "[passport] Refusing to send the Groq key to a cleartext endpoint:",
            GROQ_BASE_URL,
        );

        return fallback;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), GROQ_TIMEOUT_MS);

    try {
        const response = await fetchImpl(`${GROQ_BASE_URL}/chat/completions`, {
            method: "POST",
            signal: controller.signal,
            headers: {
                "Authorization": `Bearer ${GROQ_API_KEY}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                model: GROQ_MODEL,
                temperature: 0.6,
                /*
                 * gpt-oss is a reasoning model, and reasoning tokens come out of
                 * the same budget as the answer. A ceiling tight enough for one
                 * sentence can be spent entirely on thinking, returning empty
                 * content -- which looks exactly like a healthy fallback and
                 * would have meant the model never wrote a word in production.
                 * The budget is generous and the effort low; the answer is one
                 * sentence either way, and it is validated before it is used.
                 */
                reasoning_effort: "low",
                max_completion_tokens: 512,
                messages: [
                    { role: "system", content: SYSTEM_PROMPT },
                    { role: "user", content: factSheet(destination) },
                ],
            }),
        });

        if (!response.ok) {
            console.warn("[passport] Groq refused the copy request:", response.status);

            return fallback;
        }

        const body = await response.json() as ChatResponse;
        const text = (body.choices?.[0]?.message?.content ?? "").trim();

        if (!isUsableCopy(text, destination)) {
            console.warn("[passport] Discarded generated copy for", destination.countryCode);

            return fallback;
        }

        return { text, generated: true };
    } catch (ex) {
        console.warn("[passport] Could not reach Groq, using the template:", ex);

        return fallback;
    } finally {
        clearTimeout(timeout);
    }
}
