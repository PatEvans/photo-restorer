import fs from 'fs/promises';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash-image-preview';
if (!API_KEY) {
  console.error('GEMINI_API_KEY missing in .env');
  process.exit(1);
}

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error('Usage: node scripts/test-restore.mjs <image_path>');
    process.exit(1);
  }

  const abs = path.resolve(process.cwd(), filePath);
  const buf = await fs.readFile(abs);
  const b64 = buf.toString('base64');
  const mimeType = 'image/jpeg';

  const modelPath = MODEL.startsWith('models/') ? MODEL : `models/${MODEL}`;

  // Try Images API first
  try {
    const imgEndpoint = 'https://generativelanguage.googleapis.com/v1beta/images:generate';
    const bodyA = { model: modelPath, prompt: 'Restore and colorize this photo', image: { mimeType, data: b64 } };
    const ra = await fetch(`${imgEndpoint}?key=${API_KEY}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(bodyA) });
    const ta = await ra.text();
    if (ra.ok) {
      const ja = JSON.parse(ta);
      const images = ja?.images || [];
      const first = images[0];
      const imgB64 = first?.data;
      const imgMime = first?.mimeType || 'image/jpeg';
      if (imgB64) {
        const outDir = path.resolve(process.cwd(), 'tmp');
        await fs.mkdir(outDir, { recursive: true });
        const outPath = path.join(outDir, 'out.jpg');
        await fs.writeFile(outPath, Buffer.from(imgB64, 'base64'));
        console.log('Wrote image to', outPath, '(via images:generate)');
        return;
      }
    } else {
      console.log('images:generate HTTP', ra.status, ta.slice(0, 1200));
    }
  } catch (e) {
    console.log('images:generate error', e?.message);
  }

  // Fall back to models:generateContent with responseModalities
  const endpointB = `https://generativelanguage.googleapis.com/v1beta/${modelPath}:generateContent`;
  const bodyB = {
    contents: [{ role: 'user', parts: [{ text: 'Restore and colorize this photo' }, { inlineData: { mimeType, data: b64 } }] }],
    responseModalities: ['IMAGE'],
    generationConfig: { temperature: 0.1, maxOutputTokens: 1 },
  };
  const rb = await fetch(`${endpointB}?key=${API_KEY}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(bodyB) });
  const tb = await rb.text();
  if (!rb.ok) {
    console.error('models:generateContent HTTP', rb.status, tb.slice(0, 1200));
    process.exit(2);
  }
  const jb = JSON.parse(tb);
  const parts = jb?.candidates?.[0]?.content?.parts || [];
  const imagePart = parts.find(p => p.inline_data || p.inlineData);
  const inline = imagePart?.inline_data || imagePart?.inlineData;
  if (!inline?.data) {
    console.log('No image returned. Model:', MODEL);
    console.log(JSON.stringify(jb, null, 2).slice(0, 2000));
    process.exit(4);
  }
  const outDir = path.resolve(process.cwd(), 'tmp');
  await fs.mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, 'out.jpg');
  await fs.writeFile(outPath, Buffer.from(inline.data, 'base64'));
  console.log('Wrote image to', outPath, '(via models:generateContent)');
}

main().catch((e) => {
  console.error(e);
  process.exit(10);
});
