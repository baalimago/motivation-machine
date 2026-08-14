// Daily trash-blessing agent.
// 1) Scouts the web for a fresh (de)motivational trash-animal meme concept.
// 2) If nothing usable is found, invents one and renders it with gpt-image-1
//    in glorious early-2000s PowerPoint style.
// 3) Writes image + updated blessings.json into BLESSINGS_DIR — on Edge that
//    is the mounted volume, so the site picks it up instantly.
// Invoked in-process by POST /api/trigger-blessing (Edge job, daily) or
// standalone via `npm run agent`.

import { Agent, run, webSearchTool } from '@openai/agents';
import OpenAI from 'openai';
import { z } from 'zod';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SEED_MANIFEST = path.join(ROOT, 'public', 'racoons.json');
const BLESSINGS_DIR = process.env.BLESSINGS_DIR ?? '/data/blessings';

const ALLOWED_ANIMALS = [
  'racoon', 'possum', 'opossum', 'trash panda', 'badger', 'skunk',
  'seagull', 'pigeon', 'guinea pig', 'ferret',
];

const MemeConcept = z.object({
  found_existing: z.boolean().describe('true if a real existing meme was found on the web'),
  source_url: z.string().nullable().describe('URL of the found meme, null if invented'),
  animal: z.string().describe('the trash animal featured. NEVER a rat.'),
  caption: z.string().describe('the (de)motivational text, lowercase, sincere-but-unhinged'),
  mood: z.enum(['motivational', 'demotivational', 'unbothered', 'aspirational', 'feral']),
  image_description: z.string().describe('scene description for image generation if invented'),
});

const scout = new Agent({
  name: 'Trash Meme Scout',
  model: 'gpt-5',
  tools: [webSearchTool()],
  outputType: MemeConcept,
  instructions: `You curate a "daily trash blessing" website: one (de)motivational
meme per day featuring a trash animal (racoon, possum, guinea pig, seagull, etc).
STRICTLY NO RATS.

Search the web for a fresh motivational/demotivational trash-animal meme in the
early-2000s glitter-WordArt style (like "the horrors persist but so do i" or
"there is no trash cannot, there is only trash CAN"). Avoid captions already in
this list of used captions (provided in the prompt).

If you find a great existing one, report it with its source_url.
If nothing good turns up, INVENT one: pick an animal from ${ALLOWED_ANIMALS.join(', ')},
write a caption that is sincere, slightly unhinged, lowercase, and either
weirdly encouraging or devastatingly honest. Describe a photo scene for it.`,
});

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return fallback; }
}

export async function runDailyBlessing() {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not set');

  const seed = await readJson(SEED_MANIFEST, { racoons: [] });
  const manifestPath = path.join(BLESSINGS_DIR, 'blessings.json');
  const blessings = await readJson(manifestPath, { racoons: [] });
  const used = [...seed.racoons, ...blessings.racoons].map(r => r.caption);

  const result = await run(
    scout,
    `Find or invent today's trash blessing. Already-used captions:\n- ${used.join('\n- ')}`,
  );
  const concept = result.finalOutput;
  console.log('concept:', concept);

  const id = concept.caption
    .toLowerCase().replace(/[^a-z0-9 ]/g, '').trim()
    .split(/\s+/).slice(0, 4).join('-');

  const openai = new OpenAI();
  const img = await openai.images.generate({
    model: 'gpt-image-1',
    size: '1024x1024',
    prompt: `A meme in authentic early-2000s PowerPoint / glitter-graphics style:
a photo of a ${concept.animal} (${concept.image_description}), with the text
"${concept.caption}" overlaid in sparkly rainbow WordArt with drop shadows,
slightly deep-fried jpeg quality, sincere and unhinged. The text must be
spelled exactly as given.`,
  });

  const file = `${id}.png`;
  await mkdir(BLESSINGS_DIR, { recursive: true });
  await writeFile(path.join(BLESSINGS_DIR, file), Buffer.from(img.data[0].b64_json, 'base64'));

  const entry = {
    id,
    image: `blessings/${file}`,
    caption: concept.caption,
    animal: concept.animal,
    mood: concept.mood,
    source: concept.found_existing ? concept.source_url : 'generated',
    added: new Date().toISOString().slice(0, 10),
  };
  blessings.racoons.push(entry);
  await writeFile(manifestPath, JSON.stringify(blessings, null, 2) + '\n');
  console.log(`blessed: ${file} — "${concept.caption}"`);
  return entry;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runDailyBlessing().catch(err => { console.error(err); process.exit(1); });
}
