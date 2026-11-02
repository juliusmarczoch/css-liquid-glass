# Liquid Glass for the web

![The glass lying over the headline and refracting it](docs/preview.webp)

A liquid glass element that **really refracts the live page behind it**. No WebGL, no canvas, no screenshots of the DOM: one SVG displacement filter inside a CSS `backdrop-filter`, plus a few thin layers that light the edge.

This is a minimal demo extracted from [nordify.io](https://nordify.io): one glass element and a page to scroll underneath it. **Live: [studies.nordify.io/study/001-liquid-glass](https://studies.nordify.io/study/001-liquid-glass/)**

## What you see

- **Refraction.** The centre of the glass is 1:1. Towards the rim the image folds over and a steep lip pulls content from further inside out to the edge. The profile is measured from Apple's own controls, not eyeballed.
- **Reflection.** A second layer mirrors what sits *next to* the glass into its rim, weighted by Fresnel and total internal reflection.
- **Light.** Two lit caps (top right, bottom left), a darker rim elsewhere, a soft caustic and a shadow that the glass itself refracts.
- **Nine-slice maps.** The displacement maps are four corners, four edges and a neutral centre, baked once as tiny PNGs. Changing the size only moves the tiles, so the glass can be animated without rebuilding anything.

## Run it

```bash
npm install
npm run dev
```

Then open the URL Vite prints and scroll. The page moves under the fixed glass, the section titles appear inside it, and where the black part begins the glass switches to its dark tuning. At the end of the dark pictures it lets go and scrolls away with the page.

## Use it

```ts
import { createLiquidGlass } from "./glass/liquid-glass";

const glass = createLiquidGlass(document.querySelector(".my-button")!, {
  radius: 30, // corner radius in px
  rim: 1.1, // width of the refracting rim
  blur: 2, // frost in px
  reflect: true, // mirror the surroundings into the rim
});

// content next to the glass that changes on its own (a playing video):
// call once per frame so it does not freeze in the reflection
glass.refresh();

// after moving the element without resizing it (e.g. fixed -> absolute)
glass.update();

// a light and a dark copy of the veil and edge light, to crossfade
const light = glass.addCover(document.body, 0);
const dark = glass.addCover(document.body, 1);

// later
glass.destroy();
```

The element keeps its own content. The glass layers are inserted in front of it and your content is raised above them. Copy `src/glass/` into your project; it has no dependencies.

Fine-tune the look with custom properties on the element, for example `--lg-underlay`, `--lg-shadow-o`, `--lg-tint` or `--lg-glint-exp`. They are listed at the top of [`liquid-glass.css`](src/glass/liquid-glass.css). The veil and the edge light live in a sibling right after the element, so tune `--lg-underlay` and `--lg-spec` there: `.my-glass + .lg-cover { --lg-underlay: 0.2 }`. Over dark backgrounds, set `data-lg-dark` on the element, or set `--lg-dark: 1`. Switch it in one step: changing it on every frame flickers in Chromium. To animate the switch, crossfade a light and a dark cover from `glass.addCover()` by opacity, as the demo does (see [HOW-IT-WORKS.md](HOW-IT-WORKS.md)).

## Browser support

| Browser | Result |
| --- | --- |
| Chrome, Edge, Arc, Brave, Opera (Chromium) | Full effect |
| Safari, all iOS browsers, Firefox | Frosted glass, no refraction or reflection |

Refraction needs `url()` filters inside `backdrop-filter`, which only Chromium runs today. The code detects this and skips the map baking elsewhere; `supportsRefraction` tells you which case you are in, and the demo uses it to show a short notice.

## Porting it

[**HOW-IT-WORKS.md**](HOW-IT-WORKS.md) explains the whole construction: every layer, the filter graph, the nine-slice, what made it fast, and the traps that break it. It is written so you can hand this repository to an AI assistant and ask it to move the effect into your own site or framework.

## Files

```
src/glass/maps.ts          map baking: refraction, reflection, edge lighting
src/glass/liquid-glass.ts  the DOM side: layers, filters, resize handling
src/glass/liquid-glass.css the look of every layer
src/main.ts                demo setup: dark switch, titles in the glass, parking
src/demo.css               demo page styles
Dockerfile, deploy/, k8s/  how the live demo is hosted (nginx on Kubernetes)
```

## License

Code: MIT, see [LICENSE](LICENSE). The fonts in `public/fonts/` are self-hosted and keep their own licence: Figtree and Momo Signature are both under the SIL Open Font License ([Figtree-OFL.txt](public/fonts/Figtree-OFL.txt), [MomoSignature-OFL.txt](public/fonts/MomoSignature-OFL.txt)).
