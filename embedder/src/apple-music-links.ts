import { Mutex } from "async-mutex";

import type { AppleMusicLink } from "./linked-accounts";

/**
 * Where Apple Music links are kept: a collection of their own, keyed by Tempo id.
 *
 * Not on the account document. The account is written back whole in several
 * places from a copy read before a network wait — a Spotify token refresh,
 * a sign-in — and anything changed on it meanwhile is undone. A new token
 * undone that way is used again after Apple has refused it; where reading had
 * got to, undone, reads the same plays twice. The account is also logged whole
 * when a session fails to start, and a token must never reach a log.
 *
 * Every change goes through `update`, one at a time per account, against the
 * link as it is at that moment. So the reader marking a refused token cannot
 * land on a new one the app has just sent, and a refresh cannot recreate a
 * link the listener removed while it was out asking Apple.
 */
export interface AppleMusicLinkPersistence {
    get(tempoId: string): Promise<AppleMusicLink | null>;
    set(tempoId: string, link: AppleMusicLink): Promise<boolean>;
    remove(tempoId: string): Promise<boolean>;
}

export class AppleMusicLinkStore {
    /** Every link read, and null for an account known to have none. */
    private cache = new Map<string, AppleMusicLink | null>();
    private locks = new Map<string, Mutex>();

    constructor(private persistence: AppleMusicLinkPersistence) { }

    private lock(tempoId: string) {
        let lock = this.locks.get(tempoId);

        if (!lock) {
            lock = new Mutex();
            this.locks.set(tempoId, lock);
        }

        return lock;
    }

    private async read(tempoId: string) {
        if (this.cache.has(tempoId))
            return this.cache.get(tempoId) ?? undefined;

        const link = await this.persistence.get(tempoId);

        this.cache.set(tempoId, link ?? null);

        return link ?? undefined;
    }

    /** The account's link, if it has one. */
    async get(tempoId: string): Promise<AppleMusicLink | undefined> {
        return this.lock(tempoId).runExclusive(() => this.read(tempoId));
    }

    /**
     * Changes the account's link: `change` is given the link as it is now and
     * returns what it should become, undefined to remove it, or the same link
     * to leave it alone. Answers with the link as it ends up.
     *
     * Nothing is kept unless it was stored.
     */
    async update(tempoId: string, change: (current: AppleMusicLink | undefined) => AppleMusicLink | undefined): Promise<AppleMusicLink | undefined> {
        return this.lock(tempoId).runExclusive(async () => {
            const current = await this.read(tempoId);
            const next = change(current);

            if (next === current)
                return current;

            const stored = (next
                ? await this.persistence.set(tempoId, next)
                : await this.persistence.remove(tempoId));

            if (!stored)
                throw new Error("The Apple Music link could not be stored");

            this.cache.set(tempoId, next ?? null);

            return next;
        });
    }
}
