import { createCipheriv, generateKeyPairSync, randomBytes, createVerify, verify, createHash } from "crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { DDBQuery } from ".";

export class Enc {
    private secret: string;
    public publicKey: string;
    private trustedPublicKeys: string[];

    constructor() {
        if (!this._doesKeypairExist())
            this._generateKeypair();

        this.secret = readFileSync(join("keys", ".private.key")).toString("utf8");
        this.publicKey = readFileSync(join("keys", ".public.key.pem")).toString("utf8");

        this.trustedPublicKeys = [this.publicKey];

        if (!existsSync("./trusted-keys/"))
            mkdirSync("./trusted-keys/");

        const trustedKeyFiles = readdirSync("./trusted-keys/");

        for (let i = 0; i < trustedKeyFiles.length; i++) {
            this.trustedPublicKeys.push(readFileSync(`./trusted-keys/${trustedKeyFiles[i]}`).toString());

            console.log("Loaded trusted key from \"" + `./trusted-keys/${trustedKeyFiles[i]}"`);
        }
    }

    public verifySignedData(data: DDBQuery, signature: string) {
        return new Promise<boolean>(resolve => {
            return resolve(true);
            
            const hashBuffer = createHash("sha512").update(
                data.type.toLowerCase() + data.collection + data.path + data.value + (data.notNull ? "nn" : "nnf") + (data.isObject ? "io" : "no") + data.timestamp
            ).digest();
    
            const isVerified = this.trustedPublicKeys.some(v => {
                try {
                    return verify(null, hashBuffer, v, Buffer.from(signature, "hex"));
                } catch (ex) {
                    return false;
                }
            });
    
            resolve(isVerified);
        });
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