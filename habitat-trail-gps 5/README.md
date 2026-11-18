# Habitat Trail: Photo Map

Take a photo of a plant or animal, AI identifies it, and you pin it to a real map of La Cañada Flintridge with a short note.

## Run it

You need Node 18 or newer and a Claude API key (from console.anthropic.com).

```
ANTHROPIC_API_KEY=your-key ADMIN_KEY=pick-a-secret npm start
```

Then open http://localhost:3000. Phones only share location over **https** (or localhost), so the hosted version must use https.

The API key stays on the server. Never put it in `index.html`.

## Live camera (phone AI + Claude)

On the Photo ID tab, **Live camera** opens the phone camera.

- **Phone AI:** Google's free AIY Nature Explorer models (plants, birds, insects, trained on iNaturalist photos) run on the phone itself through TensorFlow Lite for the web. Names pop up while the camera moves, about 25 checks a second on a laptop. No internet or AI cost per check.
- **Claude:** asked only when the player taps **See everything** or the round button. Claude confirms the species (it gets the phone's guess as a hint), then fills in the facts, rarity and Dex card. Claude also covers what the phone models don't know, like mammals and reptiles.
- **Without the model files,** live camera falls back to asking Claude when the camera is held still (`CLAUDE_LIVE_MODEL`, default `claude-haiku-5-5`, at most every 2.5 seconds and 60 checks per session).
- Frames are never saved. The camera turns off when closed or when the player leaves the app. Needs https (or localhost).

### Getting the phone AI models (one time, about 5 minutes)

Download on a computer, then put the files in `public/models/` with these exact names:

1. Go to **kaggle.com/models/google/aiy** (free Kaggle account needed).
2. For each of **vision-classifier-plants-v1**, **vision-classifier-birds-v1** and **vision-classifier-insects-v1**, choose the **TensorFlow Lite** version and click **Download**. Unzip it and rename the `.tflite` file to `plants.tflite`, `birds.tflite` or `insects.tflite`.
3. Download the 3 name lists:
   - https://www.gstatic.com/aihub/tfhub/labelmaps/aiy_plants_V1_labelmap.csv
   - https://www.gstatic.com/aihub/tfhub/labelmaps/aiy_birds_V1_labelmap.csv
   - https://www.gstatic.com/aihub/tfhub/labelmaps/aiy_insects_V1_labelmap.csv
4. Upload all 6 files to `public/models/` in GitHub.

Read the license and "intended use" notes on each Kaggle model page before a public launch. The engine files in `public/vendor/` are TensorFlow.js 4.9.0 and tfjs-tflite 0.0.1-alpha.10 (Apache 2.0).

## Files

- `public/index.html`: the app (map, Photo ID, Dex). Change `HOME` at the top of the script for another town.
- `public/scanner.js`: the phone AI scanner.
- `public/models/`: the phone AI model files (you add these).
- `public/vendor/`: TensorFlow engine files.
- `public/species.js`: the Dex list of 582 Southern California species (one line each: group|common name|scientific name|rarity C, U, R or L). Add a line to add a species. A plant or animal that is not on the list gets added to the player's Dex by the AI.
- `server.js`: photo ID through Claude, and storage for shared pins. Uses `data/pins.json`; swap in the main app's database when merging.

## Safety rules (done on the server, so they can't be skipped)

- **Neighborhood blur:** the exact spot is never saved. Pins snap to the middle of a ~500 m area (`FUZZ_METERS`).
- **Protected species:** endangered and threatened species are blurred to ~2 km (`PROTECTED_FUZZ_METERS`).
- **1-hour delay:** other players see a pin 60 minutes after it's posted (`PIN_DELAY_MINUTES`), so a pin never shows where a kid is right now.
- **No people:** the AI rejects photos of people, so only plant and animal photos can be posted.
- **Notes:** 90 characters max; links, phone numbers, emails and street addresses are blocked.
- **Reports:** a pin is hidden automatically after 3 reports.
- **Limits:** 10 pins per player; rate limits on photos and posts.
- **Grown-up OK:** in Explorer (kids) mode a grown-up must tick a box before posting.

## Moderating

- See all pins, including reported ones: `GET /api/admin/pins?key=ADMIN_KEY`
- Remove a pin: `DELETE /api/pins/<id>?admin=ADMIN_KEY`

## API

| Method | Path | What it does |
|---|---|---|
| POST | `/api/identify` | `{image: "data:image/jpeg;base64,..."}` returns `{ok:false}` or the species info |
| GET | `/api/pins?me=<player id>` | Visible pins, plus your own pending ones |
| POST | `/api/pins` | Post a pin: `{me, nick, name, kind, protected, note, img, lat, lng}` |
| POST | `/api/pins/<id>/report` | Report a pin |
| DELETE | `/api/pins/<id>?me=<player id>` | Remove your own pin |

Map views: Satellite uses Esri World Imagery, Terrain uses OpenTopoMap; each shows its credit on the map. These free tile services are fine for testing. For a public launch, check each provider's usage terms or use a map provider with a plan. For a public launch with lots of players, use a tile provider with a plan, per the OpenStreetMap tile usage policy.
