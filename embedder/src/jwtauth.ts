import { generateKeyPairSync, randomBytes } from 'crypto';
import { join } from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { sign, verify } from "jsonwebtoken";
import { DataStore, UserDocType } from './db';

export interface TempoTokenType {
    id: string;
    username: string;
    ent: string;
}

export class Token {
    private secret: string;
    public publicKey: string;
    private entropyCache: {[key: string]: string} = {};
    private db: DataStore

    constructor(db: DataStore) {
        this.db = db;

        if (!this._doesKeypairExist())
            this._generateKeypair();

        this.secret = readFileSync(join("keys", ".private.key")).toString("utf8");
        this.publicKey = readFileSync(join("keys", ".public.key.pem")).toString("utf8");
    }

    public setUserEntropy(userId: string, entropy: string) {
        this.entropyCache[userId] = entropy;
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
                if (err)
                    return resolve(undefined);

                if (!dec || typeof dec !== "object")
                    return resolve(undefined);

                const t = dec as TempoTokenType;

                let ent: string | undefined = this.entropyCache[t.id];

                if (!ent) {
                    // Fetch from db
                    ent = (await this.db.get<UserDocType["meta"]["tokenEntropy"]>("users", t.id + "/meta/tokenEntropy", true) ?? undefined);
                }

                if (!ent) {
                    console.error("No entropy found for user " + t.id);
                    return resolve(undefined);
                }

                if (t.ent !== ent) {
                    console.error("Entropy mismatch for user " + t.id);
                    return resolve(undefined);
                }

                resolve(t);
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