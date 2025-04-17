import imagemin from 'imagemin';
import imageminWebp from 'imagemin-webp';
import { DownloaderHelper } from 'node-downloader-helper';
import express from "express";
import cors from "cors";
import { existsSync, mkdirSync, renameSync, unlinkSync } from "fs";
import { randomBytes } from 'crypto';

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

app.get("/scdn/:imageId", async (req, res) => {
    const imageId = req.params.imageId;

    // Check in-memory cache
    const cachedImage = memoryCache.get(imageId);
    if (cachedImage && cachedImage.expiry > Date.now()) {
        res.setHeader('Content-Type', 'image/webp');
        res.setHeader('Cache-Control', 'public, max-age=604800'); // Cache for 1 week
        res.send(cachedImage.data);
        return;
    }

    if (existsSync("./cache/" + imageId + ".webp")) {
        const fileData = await import('fs/promises').then(fs => fs.readFile("./cache/" + imageId + ".webp"));
        memoryCache.set(imageId, { data: fileData, expiry: Date.now() + 15 * 60 * 1000 });
        res.setHeader('Cache-Control', 'public, max-age=604800'); // Cache for 1 week
        res.sendFile(cwd + "/cache/" + imageId + ".webp");
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
                imageminWebp({quality: 32})
            ],
        });

        console.log("Optimised image from:", spotifyCdnPath, `[${processId}.webp]`);

        try {
            const filePath = `./temp/${processId}.webp`;
            const fileData = await import('fs/promises').then(fs => fs.readFile(filePath));

            // Store in memory cache
            memoryCache.set(imageId, { data: fileData, expiry: Date.now() + 15 * 60 * 1000 });

            // Move file to cache
            renameSync(filePath, `./cache/${imageId}.webp`);
            console.log(`File moved to cache: ./cache/${imageId}.webp`);

            res.setHeader('Cache-Control', 'public, max-age=604800'); // Cache for 1 week
            res.sendFile(cwd + "/cache/" + imageId + ".webp");

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