# Third-party software and data

Procemotion itself is licensed under GPL-3.0 (see `LICENSE`). It uses the following, each under its own licence.

## Libraries

| Name | Licence | Where |
|---|---|---|
| [three.js](https://github.com/mrdoob/three.js) | MIT | npm dependency (rendering, model loaders and exporters, controls) |
| [Draco](https://github.com/google/draco) decoder | Apache-2.0 | `public/draco/`, copied unchanged from three.js (`examples/jsm/libs/draco/`) |
| [Inter](https://github.com/rsms/inter) typeface, packaged by [Fontsource](https://github.com/fontsource/font-files) | SIL Open Font License 1.1 | npm dependency (the typeface of the app and the site) |
| [Vite](https://github.com/vitejs/vite) | MIT | build tool only, not part of the built site |

The full licence texts are in each package under `node_modules/` after `npm install`, and at the links above.

## Sample creatures (`public/demo/`)

Free models from [Fab](https://www.fab.com), by their authors, under
[Creative Commons Attribution 4.0](https://creativecommons.org/licenses/by/4.0/) (CC BY 4.0).

| Model | Author | Source | Changes |
|---|---|---|---|
| Low Poly wolf (`low_poly_wolf.glb`) | ManNeko | [Fab](https://www.fab.com/listings/c5747f8f-fb80-48c8-a0fd-c663877630c7) | None |
| Spider animated character (`spider.glb`) | Bestgameassets | [Fab](https://www.fab.com/listings/62456bda-b5f6-4372-8673-6471359c5e50) | The floor plane of the original scene removed |
| Snake Cobra animated (Base Model) (`snake_cobra.glb`) | DaVe inc. | [Fab](https://www.fab.com/listings/fa501201-17e7-49c2-a36a-a3b55834cfc7) | The helper boxes of the original scene removed |
| Crystalwing (`crystalwing.glb`) | StudioGreen | [Fab](https://www.fab.com/listings/b9ae9f4f-5e13-479e-acec-6a5eea9e8159) | None; `crystalwing.bones.json` (a bone classification made with Procemotion) comes with it |

The screenshots and clips of the website (`public/img/`, `public/guide/`) show these models in Procemotion.
