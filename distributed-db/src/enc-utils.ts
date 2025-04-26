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
        if (!existsSync("./keys"))
            mkdirSync("./keys/");
        
        this.tag = tag ?? "";
    
        if (!this._doesKeypairExist())
            this._generateKeypair();
    
        this.secret = readFileSync(join("/tempodb/keys", `.private${this.tag}.key`)).toString("utf8");
        this.publicKey = readFileSync(join("/tempodb/keys", `.public${this.tag}.key.pem`)).toString("utf8");
    
        this.trustedPublicKeys = [this.publicKey];
    
        const trustedFolder = `/tempodb/trusted-${this.tag ? this.tag + "-" : ""}keys/`;
    
        if (!existsSync(trustedFolder))
            mkdirSync(trustedFolder, { recursive: true });
    
        const trustedKeyFiles = readdirSync(trustedFolder);
    
        for (const file of trustedKeyFiles) {
            const trustedKey = readFileSync(join(trustedFolder, file)).toString();
            this.trustedPublicKeys.push(trustedKey);
            console.log(`Loaded trusted key from "${trustedFolder}${file}"`);
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
        const pubExists = existsSync(`/tempodb/keys/.public${this.tag}.key.pem`);
        const secExists = existsSync(`/tempodb/keys/.private${this.tag}.key`);
        const phrExists = existsSync(`/tempodb/keys/.p${this.tag}`);

        return (phrExists && secExists && pubExists);
    }

    private _generateKeypair(): void {
        if (!existsSync("/tempodb/keys"))
            mkdirSync("/tempodb/keys", { recursive: true });
    
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
    
        // Save everything directly to persistent volume
        writeFileSync(join('/tempodb/keys', `.private${this.tag}.key`), privateKey);
        writeFileSync(join('/tempodb/keys', `.public${this.tag}.key.pem`), publicKey);
        writeFileSync(join('/tempodb/keys', `.p${this.tag}`), passphrase);
    
        console.log(`Generated a new JWT signing keypair ${this.tag ? `(tag: ${this.tag})` : ''}`);
    }    
}