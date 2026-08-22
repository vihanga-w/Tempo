import { generateKeyPairSync, randomBytes } from 'crypto';
import { join } from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { sign, verify } from "jsonwebtoken";
import { DataStore, UserDocType } from './db';

export interface TempoTokenType {
    id: string;
    username: string;
    /**
     * Revocation counter for this user, compared against the stored value on
     * every verify. Rotating the stored value invalidates every token issued
     * before it — the only way to revoke a JWT, which is otherwise valid until
     * it expires (and these carry no expiry).
     */
    tokenVersion: string;
}

export class Token {
    private secret: string;
    public publicKey: string;
    private tokenVersionCache: {[key: string]: string} = {};
    private db: DataStore

    constructor(db: DataStore) {
        this.db = db;

        if (!this._doesKeypairExist())
            this._generateKeypair();

        this.secret = readFileSync(join("keys", ".private.key")).toString("utf8");
        this.publicKey = readFileSync(join("keys", ".public.key.pem")).toString("utf8");
    }

    public setUserTokenVersion(userId: string, tokenVersion: string) {
        this.tokenVersionCache[userId] = tokenVersion;
    }

    public generateSignedToken(data: TempoTokenType) {
        return sign(data, this.secret, {
            issuer: "urn:tempomusic"
        });
    }

    public verifySignedToken(token: string) {
        return new Promise<TempoTokenType | undefined>((resolve) => {
            verify(token, this.secret, {
                issuer: "urn:tempomusic"
            }, async (err, dec) => {
                // Anything thrown in here would otherwise leave this promise
                // unsettled, so the request that is awaiting it hangs forever
                // rather than failing — which is far harder to diagnose than a
                // rejected login.
                try {
                if (err)
                    return resolve(undefined);

                if (!dec || typeof dec !== "object")
                    return resolve(undefined);

                const t = dec as TempoTokenType;

                let current: string | undefined = this.tokenVersionCache[t.id];

                if (!current) {
                    // Absent is a normal state (user has never signed in, or the
                    // version was cleared), so treat it as "reject", not an error
                    current = (await this.db.get<UserDocType["meta"]["tokenVersion"]>("users", t.id + "/meta/tokenVersion", false, true) ?? undefined);
                }

                if (!current) {
                    console.error("No token version found for user " + t.id);
                    return resolve(undefined);
                }

                if (t.tokenVersion !== current) {
                    console.error("Token version mismatch for user " + t.id + " (token was issued before the most recent revocation)");
                    return resolve(undefined);
                }

                resolve(t);
                } catch (ex) {
                    console.error("Token verification failed unexpectedly for user, error:", ex);

                    resolve(undefined);
                }
            });
        })
    }

    private _doesKeypairExist() {
        const pubExists = existsSync("./keys/.public.key.pem");
        const secExists = existsSync("./keys/.private.key");
        const phrExists = existsSync("./keys/.p");

        return (phrExists && secExists && pubExists);
    }

    private _generateKeypair() {
        if (!existsSync("./keys"))
            mkdirSync("./keys/");

        const passphrase = randomBytes(16).toString("hex");

        const { publicKey, privateKey } = generateKeyPairSync('rsa', {
            modulusLength: 4096,
            publicKeyEncoding: {
                type: 'spki',
                format: 'pem'
            },
            privateKeyEncoding: {
                type: 'pkcs8',
                format: 'pem',
                cipher: 'aes-256-cbc',
                passphrase
            }
        });

        writeFileSync(join('keys', '.private.key'), privateKey);
        writeFileSync(join('keys', '.public.key.pem'), publicKey);
        writeFileSync(join('keys', '.p'), passphrase);

        console.log("Generated a new JWT signing keypair");
    }
}