import { createCipheriv, generateKeyPairSync, randomBytes, createVerify, verify, createHash, sign, createPrivateKey, KeyObject } from "crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import stringify from "fast-json-stable-stringify";
import { DDBQuery } from ".";

export class Enc {
    private tag: string;
    private secret: KeyObject;
    public publicKey: string;
    private trustedPublicKeys: string[];

    private baseDir = "/tempodb/keys";

    constructor(tag?: string) {
        this.tag = tag ?? "";
    
        if (!existsSync(this.baseDir)) {
            mkdirSync(this.baseDir, { recursive: true });
        }
    
        if (!this._doesKeypairExist()) {
            console.log(`No keypair found for tag ${this.tag}. Generating...`);
            this._generateKeypair();
        }
    
        if (!this._doesKeypairExist()) {
            throw new Error(`Keypair generation failed for tag ${this.tag}`);
        }

        this.secret = createPrivateKey({
            key: readFileSync(join("/tempodb", "keys", `.private${this.tag}.key`)).toString("utf8"),
            type: 'pkcs8',
            format: 'pem',
            passphrase: readFileSync(join("/tempodb", "keys", `.p${this.tag}`)).toString("utf8"),
        });
    
        this.publicKey = readFileSync(join(this.baseDir, `.public${this.tag}.key.pem`), "utf8");

        console.log(`Loaded keypair for tag ${this.tag}`);
        console.log(`Public key: ${this.publicKey}`);
    
        this.trustedPublicKeys = [this.publicKey];
    
        const trustedFolder = `./trusted-keys/`;
    
        if (!existsSync(trustedFolder)) {
            mkdirSync(trustedFolder, { recursive: true });
        }
    
        const trustedKeyFiles = readdirSync(trustedFolder);
    
        for (const file of trustedKeyFiles) {
            const trustedKey = readFileSync(join(trustedFolder, file), "utf8");
            this.trustedPublicKeys.push(trustedKey);
            console.log(`Loaded trusted key from "${trustedFolder}${file}"`);
        }
    }    

    public verifySignedData(data: DDBQuery, signature: string) {
        return new Promise<boolean>((resolve) => {
            const hashBuffer = createHash("sha512").update(
                data.type.toLowerCase() +
                data.collection +
                data.path +
                data.value +
                (data.notNull ? "nn" : "nnf") +
                (data.isObject ? "io" : "no") +
                data.timestamp
            ).digest();

            const isVerified = this.trustedPublicKeys.some((pubKey) => {
                try {
                    return verify(null, hashBuffer, pubKey, Buffer.from(signature, "hex"));
                } catch {
                    return false;
                }
            });

            resolve(isVerified);
        });
    }

    public signRaftMessage(data: any): string {
        const sd = stringify(data);

        console.log("Signing raft message:", sd);

        const hash = createHash("sha512").update(sd).digest();

        return sign(null, hash, this.secret).toString("hex");
    }

    public async verifyRaftMessage(data: any, signature: string): Promise<boolean> {
        const sd = stringify(data);

        console.log("Verifying raft message:", sd);

        const hash = createHash("sha512").update(sd).digest();

        return this.trustedPublicKeys.some((pubKey) => {
            console.log("Verifying with public key:", pubKey);
            try {
                return verify(null, hash, pubKey, Buffer.from(signature, "hex"));
            } catch (ex) {
                console.error("Failed to verify raft message signature:", ex);

                return false;
            }
        });
    }

    private _doesKeypairExist() {
        console.log(join(this.baseDir, `.private${this.tag}.key`))
        console.log(join(this.baseDir, `.public${this.tag}.key.pem`))
        console.log(join(this.baseDir, `.p${this.tag}`))
        return (
            existsSync(join(this.baseDir, `.private${this.tag}.key`)) &&
            existsSync(join(this.baseDir, `.public${this.tag}.key.pem`)) &&
            existsSync(join(this.baseDir, `.p${this.tag}`))
        );
    }

    private _generateKeypair(): void {
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

        writeFileSync(join(this.baseDir, `.private${this.tag}.key`), privateKey);
        writeFileSync(join(this.baseDir, `.public${this.tag}.key.pem`), publicKey);
        writeFileSync(join(this.baseDir, `.p${this.tag}`), passphrase);

        console.log(`Generated a new JWT signing keypair${this.tag ? ` (tag: ${this.tag})` : ""}`);
    }
}