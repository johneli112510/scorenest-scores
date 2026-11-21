# ScoreNest

A Flat.io-style sheet music web app that runs on **Cloudflare Pages + Pages Functions**, with every file stored in **Cloudflare R2**.

## Features

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
- Playback with a moving cursor, note highlighting, tempo control and looping
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
  js/transcribe.js      PDF/image → AI transcription (streams live)
  js/abc.js             notation helpers + templates
  js/lib.js, share.js   helpers
functions/api/[[route]].js   the whole REST API (Pages Function)
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
| `folders.json` | folders |

## Deploy: GitHub → Cloudflare (recommended)

1. **Put the code on GitHub.** Create a new repository (for example `scorenest`) and upload the contents of this folder. On github.com: *Add file → Upload files*, then drag in everything inside the folder. Or with git:
   ```bash
   git init && git add . && git commit -m "ScoreNest"
   git branch -M main
   git remote add origin https://github.com/<you>/scorenest.git
   git push -u origin main
   ```
2. **Create the R2 bucket.** In the Cloudflare dashboard, go to **R2 Object Storage → Create bucket** and name it `scorenest-scores`.
3. **Create the Pages project.** Go to **Workers & Pages → Create → Pages → Connect to Git** and pick the repo. Use these build settings:
   - Framework preset: **None**
   - Build command: *(leave empty)*
   - Build output directory: **`public`**
4. **Check the R2 binding.** `wrangler.toml` already declares it. To confirm, open **Settings → Bindings** for the project. You should see an R2 bucket with variable name **`SCORES`** pointing to `scorenest-scores`. If it isn't there, add it.
5. **Add secrets.** Go to **Settings → Variables and Secrets**, add these as type *Secret*, then redeploy:
   - `APP_PASSWORD`: the password for signing in. Without it, anyone with the URL can use the library.
   - `SESSION_SECRET`: any long random string.
   - `ANTHROPIC_API_KEY`: your key from console.anthropic.com. It turns on AI transcription.
6. Open `https://<project>.pages.dev`. From now on, every push to `main` redeploys automatically.

## Deploy with the command line instead

```bash
npm install
npx wrangler login
npm run create-bucket                       # creates scorenest-scores
npx wrangler pages project create scorenest --production-branch main
npx wrangler pages secret put APP_PASSWORD --project-name scorenest
npx wrangler pages secret put SESSION_SECRET --project-name scorenest
npx wrangler pages secret put ANTHROPIC_API_KEY --project-name scorenest
npm run deploy
```

## Run locally

```bash
cp .dev.vars.example .dev.vars   # fill in your values
npm install
npm run dev                      # http://localhost:8788 (uses a local R2 simulator)
npm test                         # API + notation helper tests
```

## Notes

- AI transcription uses the Claude API, which is billed to your Anthropic account per page. Clean, straight, high-contrast scans give the best results. Always check the result against the Original tab. Dense piano or orchestral scores will need more corrections than choir or lead-sheet music.
- The model is set by `CLAUDE_MODEL` in `wrangler.toml`.
- The notation engine (abcjs), the MusicXML renderer (OpenSheetMusicDisplay) and the PDF renderer (pdf.js) load from the jsDelivr CDN, so there is no build step.
