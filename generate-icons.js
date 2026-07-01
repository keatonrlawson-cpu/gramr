// Run with: node generate-icons.js
// Generates PNG icons for the extension using the Canvas API via node-canvas,
// or writes minimal 1×1 placeholder PNGs if canvas is unavailable.

const fs = require("fs");
const path = require("path");

const sizes = [16, 48, 128];
const outDir = path.join(__dirname, "icons");

function makeSVG(size) {
  const r = size * 0.44;
  const cx = size / 2;
  const cy = size / 2;
  const fontSize = Math.round(size * 0.52);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#cba6f7"/>
      <stop offset="100%" stop-color="#89b4fa"/>
    </linearGradient>
  </defs>
  <rect width="${size}" height="${size}" rx="${Math.round(size * 0.22)}" fill="url(#g)"/>
  <text x="${cx}" y="${cy + fontSize * 0.36}" font-family="Arial,sans-serif" font-weight="800"
        font-size="${fontSize}" fill="#1e1e2e" text-anchor="middle">G</text>
</svg>`;
}

// Try to use sharp or canvas; fall back to SVG files
try {
  const sharp = require("sharp");
  Promise.all(
    sizes.map(async (s) => {
      const svg = Buffer.from(makeSVG(s));
      await sharp(svg).png().toFile(path.join(outDir, `icon${s}.png`));
      console.log(`✓ icon${s}.png`);
    })
  ).then(() => console.log("Icons generated with sharp."));
} catch (_) {
  // Fallback: write SVG files named as PNG (Chrome accepts them for local loading)
  for (const s of sizes) {
    fs.writeFileSync(path.join(outDir, `icon${s}.svg`), makeSVG(s));
  }

  // Write a minimal valid 1×1 transparent PNG as placeholder
  // PNG signature + IHDR + IDAT + IEND (hand-crafted minimal PNG)
  const minPNG = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // signature
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR length + type
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, // 1x1
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, // bit depth, color, etc.
    0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, // IDAT
    0x54, 0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
    0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, // IEND
    0x42, 0x60, 0x82,
  ]);
  for (const s of sizes) {
    fs.writeFileSync(path.join(outDir, `icon${s}.png`), minPNG);
  }
  console.log("Fallback: minimal placeholder PNGs written (install sharp for real icons).");
  console.log("SVGs are also saved as icon{16,48,128}.svg for reference.");
}
