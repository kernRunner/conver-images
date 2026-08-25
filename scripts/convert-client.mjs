import fs from "node:fs/promises";
import path from "node:path";

const [file, outputDir = "./converted"] = process.argv.slice(2);
if (!file) {
  console.error("Usage: npm run convert -- <image-file> [output-dir]");
  process.exit(2);
}
const apiKey = process.env.CONVERTER_API_KEY;
if (!apiKey) {
  console.error("CONVERTER_API_KEY is required");
  process.exit(2);
}
const endpoint = process.env.CONVERTER_URL || "http://127.0.0.1:3000/v1/convert";
const formats = process.env.CONVERTER_FORMATS || "webp";
const ext = path.extname(file).slice(1).toLowerCase();
const mime = ({ jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", avif: "image/avif" })[ext];
if (!mime) throw new Error("unsupported input extension");

const body = await fs.readFile(file);
const response = await fetch(endpoint, {
  method: "POST",
  headers: {
    "Content-Type": mime,
    "Content-Length": String(body.length),
    "X-API-Key": apiKey,
    "X-Filename": path.basename(file),
    "X-Output-Formats": formats,
  },
  body,
});
const responseBody = Buffer.from(await response.arrayBuffer());
if (!response.ok) {
  console.error(responseBody.toString("utf8"));
  process.exit(1);
}

const contentType = response.headers.get("content-type") || "";
const match = /boundary=([^;]+)/i.exec(contentType);
if (!match) throw new Error("response has no multipart boundary");
const boundary = match[1].replace(/^"|"$/g, "");
const marker = Buffer.from(`--${boundary}`);
const nextMarker = Buffer.from(`\r\n--${boundary}`);
const headerBreak = Buffer.from("\r\n\r\n");

await fs.mkdir(outputDir, { recursive: true });
let cursor = 0;
let saved = 0;
while (true) {
  const start = responseBody.indexOf(marker, cursor);
  if (start < 0) break;
  let partStart = start + marker.length;
  if (responseBody.subarray(partStart, partStart + 2).toString() === "--") break;
  if (responseBody.subarray(partStart, partStart + 2).toString() === "\r\n") partStart += 2;

  const headersEnd = responseBody.indexOf(headerBreak, partStart);
  if (headersEnd < 0) break;
  const headersText = responseBody.subarray(partStart, headersEnd).toString("utf8");
  const headers = Object.fromEntries(headersText.split("\r\n").map((line) => {
    const i = line.indexOf(":");
    return [line.slice(0, i).toLowerCase(), line.slice(i + 1).trim()];
  }));
  const bodyStart = headersEnd + headerBreak.length;
  const end = responseBody.indexOf(nextMarker, bodyStart);
  if (end < 0) break;
  const partBody = responseBody.subarray(bodyStart, end);

  if ((headers["content-type"] || "").startsWith("application/json")) {
    const metaPath = path.join(outputDir, "metadata.json");
    await fs.writeFile(metaPath, partBody);
    console.log(`saved ${metaPath}`);
  } else {
    const disposition = headers["content-disposition"] || "";
    const filenameMatch = /filename="([A-Za-z0-9._-]+)"/.exec(disposition);
    if (!filenameMatch) throw new Error("binary response part has no safe filename");
    const target = path.join(outputDir, filenameMatch[1]);
    await fs.writeFile(target, partBody);
    console.log(`saved ${target} (${partBody.length} bytes)`);
    saved += 1;
  }
  cursor = end + 2;
}

if (saved === 0) throw new Error("no image variants found in response");
console.log(`done: ${saved} variant(s)`);
