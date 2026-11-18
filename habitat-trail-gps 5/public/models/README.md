# Phone AI models go here

Put these 6 files in this folder (names must match exactly):

| File | What it is |
|---|---|
| `plants.tflite` | Plant model (about 2,100 species) |
| `birds.tflite` | Bird model (about 960 species) |
| `insects.tflite` | Insect model (about 1,000 species) |
| `aiy_plants_V1_labelmap.csv` | Plant names |
| `aiy_birds_V1_labelmap.csv` | Bird names |
| `aiy_insects_V1_labelmap.csv` | Insect names |

See the main README for download steps. Any missing model is skipped. With none, the live camera asks Claude instead.
