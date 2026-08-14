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
const SEED_MANIFEST = path.join(ROOT, 'public', 'raccoons.json');
const BLESSINGS_DIR = process.env.BLESSINGS_DIR ?? '/data/blessings';

const ALLOWED_ANIMALS = [
  'raccoon', 'possum', 'opossum', 'trash panda', 'badger', 'skunk',
  'seagull', 'pigeon', 'guinea pig', 'ferret',
];

// randomized creative seeds, injected per-run so consecutive days diverge
const MOODS = [
  'motivational', 'demotivational', 'unbothered', 'aspirational', 'feral',
  'delusionally-confident', 'cozy-apocalyptic', 'wistful', 'menacingly-supportive',
  'victorious-against-nothing',
];
const STYLES = [
  'deep-fried jpeg meme format, artifacts and all',
  'gritty flash-photo at night, direct harsh flash',
  'low-poly early-3D render like a PS1 cutscene',
  'dreamy vaporwave sunset double-exposure over a landscape',
  'pink Barbie-cam aesthetic with glitter lens flares',
  'scanned 2000s PowerPoint slide with clip-art energy',
  'soft-focus inspirational office poster, airbrushed',
  'grainy VHS still with tracking lines',
];
const PLACEMENTS = [
  'text arched across the top',
  'text stacked in the bottom-left corner',
  'text split between top and bottom like a classic meme',
  'text running diagonally across the middle',
  'each word in a different place around the subject',
  'text crammed small in one corner like an afterthought',
];
const DECOR = [
  'scattered pixel hearts',
  'glitter star stickers in the corners',
  'sparkle lens flares everywhere',
  'a single rainbow arcing through',
  'no stickers or decorations at all, just the photo and text',
  'tiny comic-sans doodles in the margins',
];

const pick = arr => arr[Math.floor(Math.random() * arr.length)];
const pickN = (arr, n) => [...arr].sort(() => Math.random() - 0.5).slice(0, n);

const MemeConcept = z.object({
  found_existing: z.boolean().describe('true if a real existing meme was found on the web'),
  source_url: z.string().nullable().describe('URL of the found meme, null if invented'),
  animal: z.string().describe('the trash animal featured. NEVER a rat.'),
  caption: z.string().describe('the (de)motivational text, lowercase, sincere-but-unhinged'),
  mood: z.enum(MOODS),
  image_description: z.string().describe('scene description for image generation if invented'),
});

const scout = new Agent({
  name: 'Trash Meme Scout',
  model: 'gpt-5',
  tools: [webSearchTool()],
  outputType: MemeConcept,
  instructions: `You curate a "daily trash blessing" website: one (de)motivational
meme per day featuring a trash animal (raccoon, possum, guinea pig, seagull, etc).
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

  const entriesOf = d => d.raccoons ?? d.racoons ?? []; // legacy misspelled key
  const seed = await readJson(SEED_MANIFEST, {});
  const manifestPath = path.join(BLESSINGS_DIR, 'blessings.json');
  const blessings = { raccoons: entriesOf(await readJson(manifestPath, {})) };
  const used = [...entriesOf(seed), ...blessings.raccoons].map(r => r.caption);

  const recentAnimals = [...blessings.raccoons].slice(-5).map(r => r.animal);
  const creative = {
    mood: pick(MOODS),
    animals: pickN(ALLOWED_ANIMALS.filter(a => !recentAnimals.includes(a)), 3),
  };

  const result = await run(
    scout,
    `Find or invent today's trash blessing.

Today's creative seed (lean into it, unless the muse strikes otherwise):
- mood: ${creative.mood}
- candidate animals: ${creative.animals.join(', ')}
- recently featured (do NOT repeat these): ${recentAnimals.join(', ') || 'none yet'}

Already-used captions:\n- ${used.join('\n- ')}`,
  );
  const concept = result.finalOutput;
  console.log('concept:', concept);

  const id = concept.caption
    .toLowerCase().replace(/[^a-z0-9 ]/g, '').trim()
    .split(/\s+/).slice(0, 4).join('-');

  const style = pick(STYLES);
  const placement = pick(PLACEMENTS);
  const decor = pick(DECOR);
  console.log('image seed:', { style, placement, decor });

  const openai = new OpenAI();
  const img = await openai.images.generate({
    model: 'gpt-image-1',
    size: '1024x1024',
    prompt: `An early-2000s internet meme. Visual style: ${style}.
A ${concept.animal} (${concept.image_description}).
The text "${concept.caption}" overlaid in glittery WordArt with drop shadows,
${placement}. Decoration: ${decor}.
Sincere and unhinged. The text must be spelled exactly as given, and must be
fully readable and uncropped.`,
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
  blessings.raccoons.push(entry);
  await writeFile(manifestPath, JSON.stringify(blessings, null, 2) + '\n');
  console.log(`blessed: ${file} — "${concept.caption}"`);
  return entry;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runDailyBlessing().catch(err => { console.error(err); process.exit(1); });
}
