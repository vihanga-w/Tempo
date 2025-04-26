import { createCipheriv, generateKeyPairSync, randomBytes, createVerify, verify, createHash, sign } from "crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { DDBQuery } from ".";

export class Enc {
    private tag: string;
    private secret: string;
    public publicKey: string;
    private trustedPublicKeys: string[];

    constructor(tag?: string) {
        if (!this._doesKeypairExist())
            this._generateKeypair();

        this.tag = tag ?? "";
        this.secret = readFileSync(join("keys", `.private${this.tag}.key`)).toString("utf8");
        this.publicKey = readFileSync(join("keys", `.private${this.tag}.key.pem`)).toString("utf8");

        this.trustedPublicKeys = [this.publicKey];

        if (!existsSync(`./trusted-${this.tag ? this.tag + "-" : ""}keys/`))
            mkdirSync(`./trusted-${this.tag ? this.tag + "-" : ""}keys/`);

        const trustedKeyFiles = readdirSync(`./trusted-${this.tag ? this.tag + "-" : ""}keys/`);

        for (let i = 0; i < trustedKeyFiles.length; i++) {
            this.trustedPublicKeys.push(readFileSync(`./trusted-${this.tag ? this.tag + "-" : ""}keys/${trustedKeyFiles[i]}`).toString());

            console.log("Loaded trusted key from \"" + `./trusted-${this.tag ? this.tag + "-" : ""}keys/${trustedKeyFiles[i]}"`);
        }
    }

    public verifySignedData(data: DDBQuery, signature: string) {
        return new Promise<boolean>(resolve => {
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

    public signRaftMessage(data: any): string {
        const hash = createHash("sha512").update(JSON.stringify(data)).digest();
        return sign(null, hash, this.secret).toString("hex");
    }
    
    public async verifyRaftMessage(data: any, signature: string): Promise<boolean> {
        const hash = createHash("sha512").update(JSON.stringify(data)).digest();
    
        return this.trustedPublicKeys.some(pubKey => {
            try {
                return verify(null, hash, pubKey, Buffer.from(signature, "hex"));
            } catch {
                return false;
            }
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

        writeFileSync(join('keys', `.private${this.tag}.key`), privateKey);
        writeFileSync(join('keys', `.private${this.tag}.key.pem`), publicKey);
        writeFileSync(join('keys', `.p${this.tag}`), passphrase);

        console.log("Generated a new JWT signing keypair");
    }
}