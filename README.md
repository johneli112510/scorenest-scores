# ScoreNest

A Soundslice-style interactive sheet music app — notation synced to real recordings, with practice tools, an editor and AI transcription — that runs as a **Cloudflare Worker** (static assets + API), with every file stored in **Cloudflare R2**.

## Features

**Recordings synced with the notation (like Soundslice)**
- Attach recordings to any score: upload MP3 / M4A / WAV / OGG, or MP4 / WebM video (up to 95 MB), or paste a YouTube link. You can attach several per score, e.g. full choir, soprano guide, or a live video
- **Sync tool:** play the recording and tap **T** at the start of each bar. You can undo, restart from any bar, or mark the end (for a steady tempo, a start tap plus "Mark end" is enough)
- During playback the cursor and the highlighted notes follow the recording, including repeats. Video and YouTube play above the score

**Practice tools**
- Click any note to jump to that moment in the recording or the computer playback
- Shift+click a second note to **loop** that passage (L turns looping on and off)
- **Slow down** from 25% to 150% without changing the pitch. Use [ and ] to step the speed
- Computer playback with a **parts mixer** (solo or mute Soprano, Alto, Tenor, Bass…) and a **metronome** with a one-bar count-in
- **On-screen keyboard** lights up the notes as they play
- Space plays and pauses
- Share links open the same player with the synced recordings, so students and choir members can practise from one link


**Library**
- Grid or list view with live score previews, search, and sorting (last modified, created, title, composer)
- Folders, Starred, Recent, Shared and Trash (restore or delete forever)
- Rename, duplicate, move to a folder, download
- Drag and drop files anywhere on the library to import them

**AI transcription (PDF / photo → editable score)**
- Upload a PDF or a photo (PNG, JPG, WebP) and Claude reads each page and writes it out as editable notation (ABC)
- You watch it happen: the notation text and the rendered score update live while each page is read
- Multi-page PDFs (up to 30 pages per run, with a page range you choose). Tall pages are split in half so small notes stay readable
- The original file is kept with the score. The **Original** tab shows it next to the editor so you can check the result
- **Re-transcribe** at any time. The previous version stays in the history
- PDFs can also just be stored and viewed, then transcribed later
- MusicXML scores can be converted to editable scores the same way

**Editor**
- Live notation as you type, with clear messages when the notation has errors
- Edit on the score: click a note, then use ↑/↓ (or drag) to change pitch, A–G to set the pitch, 1–6 to set the duration, Delete to make a rest, and + / − for sharp / flat
- Palette: note values, rests, accidentals, octave up/down, bar lines, repeats, ties, slurs, triplets, fermata, accents, dynamics, crescendo, chord symbols, lyrics, and text
- On-screen piano (with sound) and **MIDI keyboard input** (Chrome / Edge)
- Transpose by half steps (key signature, notes and chord symbols all change)
- Templates: melody, lead sheet, piano, SATB choir, SATB + piano
- Autosave. Ctrl/⌘+S saves a named version. Version history with preview and restore (a version is also kept automatically every 15 minutes)
- Export: ABC, MIDI, WAV audio, SVG, Print / save as PDF, original file

**Also**
- MusicXML (.musicxml / .xml / .mxl) viewer
- PDF and image viewer (the whole piece in one scroll, with page numbers)
- **Share links:** a read-only public page where anyone can view, play and transpose
- Optional password sign-in
- Works on phones and tablets, and can be added to the home screen

## Project layout

```
public/                 static front end (no build step)
  index.html
  css/app.css
  js/app.js             router, library, import, new score
  js/score.js           editor, viewers, public share page
  js/player.js          practice player: recordings, sync, loop, speed, mixer, keyboard
  js/transcribe.js      PDF/image → AI transcription (streams live)
  js/abc.js             notation helpers + templates
  js/lib.js, share.js   helpers
src/worker.js           Worker entry: /api/* → API, everything else → public/
functions/api/[[route]].js   the whole REST API
wrangler.toml           R2 binding + settings
test/                   API tests with an in-memory R2 (npm test)
```

### How files are stored in R2 (bucket `scorenest-scores`, binding `SCORES`)

| Key | What |
|---|---|
| `meta/{id}` | score details (title, composer, folder, starred, shared…) |
| `scores/{id}/content` | the score (ABC or MusicXML) |
| `scores/{id}/source` | the original PDF / image |
| `scores/{id}/thumb.svg` | library preview |
| `scores/{id}/v/{time}` | saved versions (the newest 50 are kept) |
| `scores/{id}/recordings.json` | recordings list + sync points |
| `scores/{id}/rec/{rid}` | uploaded audio / video (streamed with seeking support) |
| `folders.json` | folders |

## Deploy: GitHub → Cloudflare Worker (recommended)

1. **Put the code on GitHub.** Upload everything in this folder to a repo, including the `src/` folder.
2. **Create the R2 bucket.** Go to **R2 Object Storage → Create bucket** and name it `scorenest-scores`.
3. **Create the Worker.** Go to **Workers & Pages → Create → Import a repository** and pick the repo. Keep the default deploy command (`npx wrangler deploy`).
   The `name` in `wrangler.toml` (currently `scorenest-scores`) must match the Worker's name in Cloudflare. If you named the Worker differently, change that line.
4. **Add secrets.** Go to **Settings → Variables and Secrets → Add**, choose type *Secret*, and add `APP_PASSWORD`, `SESSION_SECRET` and `ANTHROPIC_API_KEY`.
5. Open `https://<worker-name>.<your-subdomain>.workers.dev`. Every push to GitHub redeploys automatically.

The R2 binding (`SCORES`) and the static files (`public/`) are set up by `wrangler.toml`. You don't need to configure them in the dashboard.

## Deploy with the command line instead

```bash
npm install
npx wrangler login
npm run create-bucket
npx wrangler secret put APP_PASSWORD
npx wrangler secret put SESSION_SECRET
npx wrangler secret put ANTHROPIC_API_KEY
npm run deploy
```

## Run locally

```bash
cp .dev.vars.example .dev.vars   # fill in your values
npm install
npm run dev                      # http://localhost:8787 (uses a local R2 simulator)
npm test                         # API + notation helper tests
```

## Notes

- AI transcription uses the Claude API, which is billed to your Anthropic account per page. Clean, straight, high-contrast scans give the best results. Always check the result against the Original tab. Dense piano or orchestral scores will need more corrections than choir or lead-sheet music.
- The model is set by `CLAUDE_MODEL` in `wrangler.toml`.
- The notation engine (abcjs), the MusicXML renderer (OpenSheetMusicDisplay) and the PDF renderer (pdf.js) load from the jsDelivr CDN, so there is no build step.
