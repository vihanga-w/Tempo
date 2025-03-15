/// <reference path="types/spotify-methods.d.ts" />

export async function refreshSpotifyToken({
    clientId,
    clientSecret,
    refreshToken,
}: Readonly<{
    clientId: string;
    clientSecret: string;
    refreshToken: string;
}>) {
    const req = await fetch("https://accounts.spotify.com/api/token", {
        method: "POST",
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Authorization': `Basic ${Buffer.from(clientId + ":" + clientSecret).toString("base64")}`,
        },
        body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: clientId
        }),
    });

    if (req.status !== 200)
        throw new Error("Invalid response from Spotify API, code: " + req.status.toString());

    const res = await req.json() as {
        "access_token": string;
        "refresh_token"?: string;
        "expires_in": number;
        "scope": string;
        "token_type": string;
    };
    
    return res;
}

export async function getMyCurrentPlayingTrack({
    authToken,
    additionalTypes,
}: {
    authToken: string;
    additionalTypes?: ("track" | "episode")[];
}): Promise<SpotifyApi.CurrentlyPlayingResponse> {
    const req = await fetch("https://api.spotify.com/v1/me/player/currently-playing" + (additionalTypes ? "?additional_types=" + additionalTypes.join(",") : ""), {
        method: "GET",
        headers: {
            "Authorization": `Bearer ${authToken}`,
        },
    });

    if (req.status !== 200) {
        console.log(req.status)
        throw {
            headers: req.headers,
        };
    }

    const res = (await req.json()) as SpotifyApi.CurrentlyPlayingResponse;
    
    return res;
}