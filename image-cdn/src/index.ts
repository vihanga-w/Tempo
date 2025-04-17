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

app.get("/scdn/:imageId", async (req, res) => {
    const imageId = req.params.imageId;

    if (existsSync("./cache/" + imageId + ".webp")) {
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

        // Move file from ./temp/${processId}.webp --> ./cache/${imageId}.webp
        try {
            renameSync(`./temp/${processId}.webp`, `./cache/${imageId}.webp`);
            console.log(`File moved to cache: ./cache/${imageId}.webp`);

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