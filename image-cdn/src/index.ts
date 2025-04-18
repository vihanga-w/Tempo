import imagemin from 'imagemin';
import imageminWebp from 'imagemin-webp';
import { DownloaderHelper } from 'node-downloader-helper';
import express, { Response } from "express";
import cors from "cors";
import { existsSync, mkdirSync, renameSync, unlinkSync } from "fs";
import { randomBytes } from 'crypto';
// import sharp from 'sharp';
import im from 'imagemagick';

const cwd = process.cwd();
const app = express();

app.use(cors());

const memoryCache = new Map<string, { data: Buffer, expiry: number }>();

// Garbage collection loop to remove expired cache entries
setInterval(() => {
    const now = Date.now();
    for (const [key, value] of memoryCache.entries()) {
        if (value.expiry <= now) {
            memoryCache.delete(key);
            console.log(`Removed expired cache for imageId: ${key}`);
        }
    }
}, 60 * 1000); // Run every 1 minute

async function serveFromCache(imageId: string, res: Response, resize?: {
    width: number;
    height: number;
}) {
    const newImgId = (resize ? `${imageId}-${resize.width}x${resize.height}` : imageId);

    // Image has not been previously requested in this size
    if (resize && memoryCache.has(imageId) && (memoryCache.get(imageId)?.expiry ?? 0) > Date.now() && !memoryCache.has(newImgId)) {
        // const resizedImg = await sharp(memoryCache.get(imageId)?.data)
        // .resize(resize.width, resize.height)
        // .toBuffer();
        const resizedImg = await new Promise<Buffer>((resolve) => {
            const data = memoryCache.get(imageId)?.data;

            if (!data)
                return resolve(Buffer.alloc(0));

            im.resize({
                srcData: data.toString('binary'),
                width: resize.width,
                height: resize.height,
                filter: "MagicKernelSharp2021"
            }, (err, stdout) => {
                if (err) {
                    console.error('Error resizing image:', err);
                    return resolve(Buffer.alloc(0));
                }

                resolve(Buffer.from(stdout, 'binary'));
            });
        });

        memoryCache.set(newImgId, { data: resizedImg, expiry: Date.now() + 3600 * 1000 });
    }
    
    const cachedImage = memoryCache.get(newImgId);

    if (cachedImage && cachedImage.expiry > Date.now()) {
        res.setHeader('Content-Type', 'image/webp');
        res.setHeader('Cache-Control', 'public, max-age=31536000'); // Cache for 1 year

        res.send(cachedImage.data);

        return true;
    }

    return false;
}

app.get("/ping", (_, res) => {
    res.status(200).send("pong");
});

app.get("/scdn/:imageId", async (req, res) => {
    const imageId = req.params.imageId;

    const sizeRaw = req.query["s"] as string | undefined;

    let width: number | undefined;
    let height: number | undefined;

    if (sizeRaw && sizeRaw.split("x").length == 2) {
        width = parseInt(sizeRaw.split("x")[0]);
        height = parseInt(sizeRaw.split("x")[1]);
    }

    if (width && isNaN(width) || height && isNaN(height)) {
        width = undefined;
        height = undefined;
    }

    const resize = ((width && height) ? {
        width,
        height
    } : undefined);

    if (await serveFromCache(imageId, res, resize))
        return;

    if (existsSync("./cache/" + imageId + ".webp")) {
        const fileData = await import('fs/promises').then(fs => fs.readFile("./cache/" + imageId + ".webp"));
        memoryCache.set(imageId, { data: fileData, expiry: Date.now() + 3600 * 1000 });
        
        serveFromCache(imageId, res, resize);

        return;
    }

    const spotifyCdnPath = `https://i.scdn.co/image/${imageId}`;

    const processId = randomBytes(6).toString("hex");

    const dl = new DownloaderHelper(spotifyCdnPath, "./temp/", {
        fileName: processId,
    });

    dl.on('end', async () => {
        console.log('Download completed from:', spotifyCdnPath, `[${processId}]`);

        await imagemin(['./temp/' + processId], {
            destination: './temp/',
            plugins: [
                imageminWebp({quality: 75})
            ],
        });

        console.log("Optimised image from:", spotifyCdnPath, `[${processId}.webp]`);

        try {
            const filePath = `./temp/${processId}.webp`;
            const fileData = await import('fs/promises').then(fs => fs.readFile(filePath));

            // Store in memory cache
            memoryCache.set(imageId, { data: fileData, expiry: Date.now() + 3600 * 1000 });

            serveFromCache(imageId, res, resize);

            // Move file to cache
            renameSync(filePath, `./cache/${imageId}.webp`);
            console.log(`File moved to cache: ./cache/${imageId}.webp`);

            unlinkSync(`./temp/${processId}`);
        } catch (err) {
            console.error('Error moving file to cache:', err);
        }
    });
    dl.on('error', (err) => console.log('Download failed from:', spotifyCdnPath, "error:", err));
    dl.start().catch(err => console.error(err));
});

if (!existsSync("./cache/"))
    mkdirSync("./cache/");

if (!existsSync("./temp/"))
    mkdirSync("./temp/");

app.listen(2283, () => {
    console.log("Server running on port 2283");
});