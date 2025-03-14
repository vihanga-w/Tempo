import { generateKeyPairSync, randomBytes } from 'crypto';
import { join } from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { sign, verify } from "jsonwebtoken";

export interface TempoTokenType {
    id: string;
    username: string;
}

export class Token {
    private secret: string;
    public publicKey: string;

    constructor() {
        if (!this._doesKeypairExist())
            this._generateKeypair();

        this.secret = readFileSync(join("keys", ".private.key")).toString("utf8");
        this.publicKey = readFileSync(join("keys", ".public.key.pem")).toString("utf8");
    }

    public generateSignedToken(data: TempoTokenType) {
        return sign(data, this.secret, {
            issuer: "urn:tempomusic"
        });
    }

    public verifySignedToken(token: string) {
        return new Promise<TempoTokenType | undefined>(resolve => {
            const valid = verify(token, this.secret, {
                issuer: "urn:tempomusic"
            }, (err, dec) => {
                if (err)
                    return resolve(undefined);

                resolve(dec as TempoTokenType);
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