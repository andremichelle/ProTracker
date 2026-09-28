/* Old 15 instrument SoundTracker modules -> 31 instrument M.K. layout (lossless),
 * the same thing ProTracker does when it loads one. */
export function isProTracker(d) {
    if (d.length < 1084) return false;
    const tag = String.fromCharCode(d[1080], d[1081], d[1082], d[1083]);
    return ["M.K.", "M!K!", "FLT4", "4CHN"].includes(tag);
}

/* 15 instrument SoundTracker module -> 31 instrument M.K. layout (lossless), for the ProTracker replayer. */
export function pad15to31(d) {
    if (isProTracker(d) || d.length < 600) return { data: d, converted: false };
    let npat = 0;
    for (let i = 0; i < 128; i++) npat = Math.max(npat, d[472 + i]);
    npat++;
    const rest = d.subarray(600);
    const out = new Uint8Array(20 + 31 * 30 + 2 + 128 + 4 + rest.length);
    out.set(d.subarray(0, 20), 0);
    for (let i = 0; i < 15; i++) {
        const h = 20 + 30 * i, o = 20 + 30 * i;
        out.set(d.subarray(h, h + 30), o);
        let rs = ((d[h + 26] << 8) | d[h + 27]) >> 1, rl = (d[h + 28] << 8) | d[h + 29];   // repeat: bytes -> words
        if (rl <= 1) { rs = 0; rl = 1; }
        out[o + 24] = 0; out[o + 26] = rs >> 8; out[o + 27] = rs & 255; out[o + 28] = rl >> 8; out[o + 29] = rl & 255;
    }
    for (let i = 15; i < 31; i++) { out[20 + 30 * i + 29] = 1; }
    out[950] = d[470]; out[951] = 127;
    out.set(d.subarray(472, 600), 952);
    out.set([77, 46, 75, 46], 1080);            // "M.K."
    out.set(rest, 1084);
    return { data: out, converted: true, npat };
}
