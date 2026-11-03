# How the liquid glass works

This document describes the effect completely enough to rebuild it in another project or framework. If you are an AI assistant porting it: read this file, then `src/glass/maps.ts`, `src/glass/liquid-glass.ts` and `src/glass/liquid-glass.css`. Port those three files as they are and adapt only the mounting code. Most of the constants and odd-looking details exist because something visibly broke without them; the [pitfalls](#pitfalls) section explains which.

## 1. The core idea

A shader cannot sample a web page, but `backdrop-filter` can, and `backdrop-filter` accepts `url(#svg-filter)`. Inside that SVG filter, `feDisplacementMap` moves every pixel of the backdrop by an amount read from a displacement map. That is refraction on live DOM: text, images, video, anything.

```
backdrop-filter: url(#lg-refract-1) blur(2px) saturate(1.1);
```

Everything else is about two things:

1. building displacement maps that look like real glass, and
2. keeping them cheap enough to resize and animate.

## 2. Layer stack

`createLiquidGlass(host)` prepends these children to the host, in this DOM order. The order matters: a `backdrop-filter` sees everything painted before it.

| # | Element | z-index | Purpose |
| --- | --- | --- | --- |
| – | `host::before` | auto | Shadow: a blurred *outline* (border only, no fill), pushed down. An element instead of `box-shadow` so it sits *behind* the glass and gets refracted with the page. |
| 1 | `svg.lg-defs` | – | Holds the two `<filter>` elements. Zero size, but never `display: none`. |
| 2 | `.lg-reflect` | 1 | Reflection. Overhangs the host by `pad` on each side, `backdrop-filter: url(#lg-reflect-N)`, masked back to the pill shape. |
| 3 | `.lg-caustic` › `.lg-caustic-ring` | auto | Bright bundled light under the lens: a blurred ring, masked to two soft spots. |
| 4 | `.lg-pane` | auto | **The only layer that displaces.** `url(#refract) blur() saturate()`. |
| 5 | `.lg-fold` | 1 | Brightens and saturates the whole folding band of the rim. |
| 6 | `.lg-glint` | 1 | Lit part of the edge: `brightness > 1`, strong saturation. |
| 7 | `.lg-rim` | 1 | Unlit part of the edge: `brightness < 1`, saturated. |
| – | host content | 2 | Your label, icons etc. |
| 8 | `.lg-cover` › `.lg-spec` | – | Additive white on the lit part, so the edge still shows over black. In the cover, a sibling after the host (see "Crossfade, do not blend"). |
| 9 | `.lg-cover` › `.lg-underlay` | – | Faint white veil over the finished glass. Also in the cover. |

Why siblings and not nested: an element with `backdrop-filter` is a *backdrop root*. Its children only see the parent as their backdrop, not the page. Nested edge layers would filter nothing.

Why the reflection comes first in the DOM but paints above the pane: its backdrop must be the page only. Placed after the shadow and caustic, its lower edge would mirror those soft blobs from under the pill and look smeared. `z-index: 1` then paints it after the pane, so the pane's blur does not soften the mirrored image.

Why only the pane displaces: two layers that both displace produce two different images of the same spot, and their seams show as streaks. The edge layers only change exposure, which leaves every pixel where it is.

## 3. The nine-slice

Both maps depend only on the distance to the edge and the outward normal. On a rounded rectangle the normal is constant along a straight edge and radial in a corner. So each map splits into:

```
corner | top edge    | corner
left   | neutral     | right
corner | bottom edge | corner
```

- **Corners** are radial around the real arc centre.
- **Edges** vary only across the edge, so they are one texel wide and stretched along it.
- **The centre** is neutral grey (128 = no displacement) from an `feFlood`.

`sliceRect(slot, w, h, r, reach)` computes where each tile sits. It **clamps the radius to the box** (`r = min(r, w/2, h/2)`). Because the tiles are normalised and drawn with `preserveAspectRatio="none"`, a corner baked for radius 31 laid into a 26.5px cell *is* the radius 26.5 corner. Consequence: a map baked for a larger shape can be laid into any smaller box, and resizing is just updating `x/y/width/height` on a few `feImage` elements.

The maps depend on the **short side**, not on the width. A pill growing from 60 to 240px wide keeps its short side at 60, so nothing is rebaked at all.

### The rebake ratchet

When the short side does change, `onResize` decides whether to rebake:

- **Up** by more than a few px: rebake immediately (tiles would otherwise be stretched and get blurry).
- **Down** by more than about a dozen px: wait until the size has been stable for a moment, then rebake. A spring overshoot that dips briefly below the rest size never swaps an image.
- Anything in between: just re-lay.

Baked maps are cached by `(short side, radius)`, so returning to a previous size reuses the identical data URLs and the browser does not decode them again.

## 4. Refraction map

Everything is in units of the corner radius R. `q` is the distance from the arc centre divided by R: 1 at the edge, 0 at the centre. `refrProfile(q)` is how far the glass samples **inwards** at that point:

- **Centre** up to q ≈ 0.6: exactly 1:1. No magnifier.
- **Bulge**: a smooth S-step. It reaches further than the radius grows, so the image in the ring runs backwards: lines appear twice and close into loops.
- **Lip**: the last few percent pull content from near the centre out to the rim, so the whole interior appears compressed into a bright contour along the edge. It is capped *softly*; a hard cap made lines snap into short straight stubs.

This was measured from Apple's play button over a grid. Sampling outwards instead of inwards was the single biggest mistake of earlier versions.

**Tilt.** A circle has no straight edges, but a pill does, and on a straight edge the displacement vector is exactly perpendicular, so lines crossing it stay perfectly straight and the edge looks dead. The tilt adds a small pull towards the centre along the long axis: +1 on the left cap, a linear ramp across the straight run, −1 on the right cap. Its strength follows the length of the straight run (zero on a circle), set live through `k3/k4` of an `feComposite`, no rebake.

**Corners are pre-multiplied.** The radial vector is `P(q)/q · (x, y)/R`: a radial magnitude times a linear direction. Instead of multiplying the two inside the filter (an extra `feImage` and `feComposite` per corner and axis), `productTile` bakes the product into one tile per corner and axis.

### Filter graph (refraction)

```
feFlood 128                        -> rbase
feImage ×4 edges                   -> rtop, rright, rbottom, rleft
feImage ×4 corners (x)  + feMerge  -> rx   (base, corners, left, right)
feImage ×4 corners (y)  + feMerge  -> ry   (base, corners, top, bottom)
tilt: feImage ×8 + feMerge         -> tmag
      feFlood white + ramp feImage -> sfield
      feComposite arithmetic       -> tvec  (tmag × sfield)
      feComposite arithmetic       -> rxt   (rx + k3·tvec + k4)
feColorMatrix PACK_Y  (ry -> alpha)          -> ya
feComposite in        (rxt masked by ya)     -> xy
feColorMatrix UNPACK  (R = x, G = y)         -> rmap
feDisplacementMap SourceGraphic by rmap, scale from refractionScale()
```

### Why everything is grey

On Display-P3 screens (every recent Mac), Chrome's GPU path converts coloured filter inputs and coloured intermediate results into the display profile. sRGB to P3 leaks part of the green channel into red. For a picture that is correct; for a displacement map it means "move down" also becomes "move right", and the glass twists the page into a swirl. Grey and alpha are untouched by this conversion.

So x and y are built as **two separate grey fields**. Only at the very end does y go into the alpha channel (`PACK_Y`), x gets masked by it with `operator="in"`, and a single colour matrix (`UNPACK`) produces R = x, G = y, which goes straight into `feDisplacementMap` with nothing in between.

This bug does **not** show in headless Chrome or with `--force-color-profile=srgb`. Check on a real P3 screen.

### Precomputed fields

The nine-slice graph builds the field from some 35 primitives on every frame, and each primitive is a pass over the filter region on the GPU. On a large element that is most of the glass's GPU time, and under load a frame that misses its deadline is shown half drawn: the glass flickers, and so does everything below it on the screen, scrollbar included. So once the size has settled (`scheduleFields`, 300 ms after the last change), the finished x and y fields are rendered into two grey PNGs through a canvas, and a copy of each filter (`#lg-refract-N-baked`, `#lg-reflect-N-baked`) reads those with two `feImage`s instead of building them: the same pixels from six primitives. While the size moves, the live graph is used, because a freshly set image is not decoded for a frame.

The catch is that every image in a backdrop filter is copied to the compositor again with **every frame**, not only when something changes, and on the thread that drives the scroll. The cost scales with the pixels, not the format. So the images are kept small: half resolution for the refraction (the field is smooth; only the outermost rim line gets a touch softer), and for the reflection a quarter, since its result is blurred anyway, over the outline plus the blur's reach only, not the whole overhang (the field is flat out there, and the mask discards it). The reflection's weight mask is precomputed into the same copy. Full-resolution images were tried first: no flicker, but the copy took 2 ms per frame and the page crawled.

### Tiles are bitmaps

Every tile is a small greyscale PNG (corners 32×32, edges 128×1) produced by a tiny synchronous encoder in `maps.ts` (stored zlib block, no compression, no colour profile). Earlier versions used SVG gradients as tiles; those are re-rasterised whenever the tile's size changes, which during a width animation is every frame. A bitmap is decoded once and only stretched. 32×32 is visually indistinguishable from larger sizes; the steep lip is the only part that needs the resolution.

## 5. Reflection

The reflection is the light that never enters the glass: it mirrors what sits *next to* the element into the rim.

**The overhang trick.** Chromium clips the backdrop of a `backdrop-filter` to the element's own border box before the filter runs. A larger filter region does not help. So the reflection layer itself is made larger: `inset: -pad` on every side. Its backdrop now includes the surroundings, the displacement map points outwards into them, and a mask cuts the result back to the pill. The overhang feeds the filter but is never visible.

- `pad` per side is the reach of the reflection, capped by the free space to the viewport edge (there is no backdrop outside the viewport; sampling there shows a hard line). Where space is short, that side's image is compressed instead of cut off.
- The reach grows with the element but is **capped in absolute pixels** (`REFL_REACH_MAX`). The maps are 8-bit, so one step of the displacement is `scale / 255` px. On a large element an unbounded reach makes that step several pixels wide (the reflection turns into stairs) and squeezes content from far away into the thin rim. The same applies to any displacement you scale with the element: keep `scale` small enough that `scale / 255` stays around a pixel or two.
- The free space is measured in coarse steps and only after the element **stands still** (`onView`: compare the element's position twice, retry until it no longer moves). Transitions and transforms fire no scroll events, so waiting for "scroll end" is not enough.
- The weight mask is a nine-slice too, eight alpha PNG tiles (corners 32×32, edges 128×1) merged **inside the filter** and applied with `feComposite operator="in"`. It was a CSS mask first; a CSS mask is rasterised like content, and under load Chromium draws frames before it is, which dropped the whole reflection for that frame. Where the filter leaves transparency, the page shows through unchanged. The primitives after the fields (packing, displacement, blur, mask) get a subregion of the outline plus the blur's reach, so they are not drawn over the whole overhang.
- `clip-path: inset(... round var(--lg-r))` duplicates the mask's outline and keeps the filter work to the outline instead of the whole overhang. The catch: Chromium then redraws the glass only for changes under that outline. The same goes for scrolling over a flat colour: the surroundings move, nothing under the glass changes, and the reflection lags behind and catches up in a jump. The script toggles a near-invisible fill right under the glass on every scroll event for that, in a frame callback and at least 13 ms after the last toggle: at 120 Hz every other frame is skipped and the glass trails the page by one frame, invisible in motion, which halves its GPU work where the frames are shortest; at 60 Hz nothing is skipped. A skipped toggle is passed on to the next frame, so the last position of a scroll is always drawn. The frame callbacks also show dropped frames (a callback that comes two frame times late is one the GPU did not finish in time): after one the gap grows to 25 ms for 600 ms, after three in a row to 50 ms. The page keeps scrolling at full rate in all of this; only the glass is redrawn less often, from Chromium's cached result in between. The fill is page content, a sibling inserted before the host and positioned under it, not a layer inside the host: changing anything inside the host repaints the host's own layers, and that flickered on a real display. Headless Chrome never showed it. Content that changes on its own next to the glass, like a playing video, needs the same: call `glass.refresh()` once per frame of such content (`requestVideoFrameCallback` for video, see `main.ts`).
- The weight follows Fresnel (4 % head-on, approaching 100 % at grazing angles) plus total internal reflection, raised by `reflectStrength` and with a small floor so it is visible at all. It is zero in the outermost pixel ring, which belongs to the edge layers.
- A light `feGaussianBlur` at the end: a curved mirror compresses its image and loses angular resolution.

The reflection map depends on the full size, not just the short side. It is rebuilt only when the bake changes or the free space changes, never during a width animation; in between, its tiles are re-laid like the refraction's.

## 6. Edge lighting

- **`buildBevelArcs(w, h)`** returns two complementary `conic-gradient`s, glint and rim, that sum to exactly 1 everywhere, so there is no seam between lit and unlit. The peaks sit at 45° and 225° (top right, bottom left). Lighting follows the surface *normal*, so the angles are warped by the aspect ratio; a factor of 0.4 keeps all four transitions soft on a wide pill. Cached per size.
- **Edge mask** (CSS, `.lg-edge`): a ring that is solid for `--lg-rim-w` and fades over `--lg-rim-fade`, built from four side gradients and four corner `radial-gradient`s (`add`), then cut by the conic gradient (`intersect`). The sides cover only the straight runs and the corners only their quarter, so they meet at the tangent instead of overlapping into a visible kink. `mask-composite` needs **nine** values for nine layers; a shorter list repeats and silently breaks one corner.
- **`.lg-fold`** covers the whole folding band (`REFR_FOLD_DEPTH · R` deep) and lifts brightness and saturation, so the folded image reads as the same material as the rim.
- **`.lg-spec`** is additive white on the lit caps. The other edge layers are multiplicative (brightness on whatever is behind), which does nothing over black. Do not use `mix-blend-mode` for it, see pitfalls.
- **Dark backgrounds:** `--lg-dark` (0 or 1) on the host fades the white veil down to a trace and fades out shadow and caustic and shifts the edge towards additive light; `data-lg-dark` is a shortcut for 1. Every value that differs between the two tunings is a `calc()` mix by `--lg-dark`. It never changes a map, so nothing rebakes.
- **Switch the glass in one step.** Changing anything inside the host on every frame (an animation, a scroll-tied blend) repaints the glass on every frame, and that flickers in Chromium on a real display. Headless Chrome never shows it. Three attempts inside the host all flickered: easing `--lg-dark` itself, splitting veil and edge reflection at the boundary with a gradient that follows the scroll, and fading only opacities on layers with `will-change: opacity` (the worst of the three). Moving the veil and the additive edge light out of the host and blending them there on every frame still flickered.
- **Crossfade, do not blend.** The veil and the additive edge light, the two layers that make most of the difference, live outside the host in `.lg-cover`, a sibling right after it that the script lays over the glass. `addCover(parent, dark)` adds a cover with a fixed tuning. The demo makes a light and a dark one, each with `will-change: opacity`, and on the switch crossfades them with an opacity transition while the glass itself changes in one step. The compositor blends two finished layers and repaints nothing, so the fade is calm where every repainting blend flickered. The opacity never goes quite to 0, since a layer at 0 may not be rasterised and would flash on the first frame of the fade. The catch: a cover sits above the host's content too, so a label inside the glass lies under the faint veil. Clipping a light and a dark cover to the light and dark part of the page (repaint-free as well) was tried too: the veil then ends at the boundary, and the part of the glass that is already over black shows the black through.
- **A light/dark boundary crossing the glass:** the demo switches when the boundary reaches the middle of the glass (`shade()` in `main.ts`): the glass in one step, the veil and the edge light as a crossfade. The caustic switches off a little earlier, before the boundary reaches the glass, since it glows just below it and would lie on the black as a grey haze.

## 7. Porting checklist

1. Copy `maps.ts` and `liquid-glass.ts` unchanged; copy `liquid-glass.css` into your global styles (or keep it as an imported file). It has no dependencies.
2. The host element needs: a size, a border radius equal to the `radius` option (set by `createLiquidGlass`), and either `position: relative/absolute/fixed`. A zero-specificity rule makes it `relative` if you set nothing.
3. Call `createLiquidGlass(host, options)` once the element is in the DOM, and `destroy()` when it leaves.
4. Put text inside an element, not as a bare text node: the rule that raises content above the glass layers targets elements.
5. Check the [pitfalls](#pitfalls) against the host's **ancestors**, not just the host.

React example:

```tsx
function GlassButton({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const glass = createLiquidGlass(ref.current!, { radius: 30, rim: 1.1 });
    return () => glass.destroy();
  }, []);
  return (
    <button ref={ref} className="my-glass-button">
      <span>{children}</span>
    </button>
  );
}
```

Keep React (or any framework) out of the per-frame path. In the original React component, letting resize updates go through state re-rendered the whole filter tree every frame of an animation; the ResizeObserver now writes the geometry directly to the DOM, which is what `liquid-glass.ts` does.

## 8. Animating

The demo animates nothing inside the glass. At the dark switch the glass changes in one step and the veil and the edge light crossfade (`shade()` in `main.ts`); see "Crossfade, do not blend" above. The section titles are read inside the glass the same way: one finished copy per section in a layer over the glass. Their opacity and `translate` follow the scroll position through a scroll-driven animation (`animation-timeline: scroll(root)`, keyframes per title from `rangeCopies()` in `main.ts`), which runs on the compositor without the main thread. One never-ending animation per title over the whole scroll range, not one per entrance: a finished scroll-driven animation is dropped from the compositor, and scrolling back into it then waits for the main thread to restart it, which under load made the titles stutter. Text written into the glass element itself would repaint the glass on every frame. At the end of the dark pictures the glass parks: from the parking position on, a scroll-driven `translate` moves the glass, its titles, the fill and the covers up exactly as far as the page scrolls (`parkScroll()`), so it stays `position: fixed` and still scrolls away with the page. Switching to `position: absolute` from a scroll handler was the first version; under load the handler ran late, the glass overshot and jumped back (it is still the fallback where scroll-driven animations are not supported, `park()`). It changes no size and no map. If you animate the size, animate `width` (and `height` if needed) with a transition or per frame; with the short side unchanged the glass only re-lays its tiles and never rebakes. That is the path the design is made for.

- **Animate `width`/`height` or position (`top`, `left`, `inset`, `margin`).** A width change keeps the short side, so the ResizeObserver only re-lays tiles. A height change is fine as long as it stays within the rebake ratchet.
- **To shrink towards the centre**, keep the centre fixed with layout instead of `transform-origin` and `scale`: change `width` together with `left` (`left = centre - width / 2`), or centre the element with `inset: 0` and `margin: auto` as the demo does. No `transform` on the glass, see pitfalls.
- **Never animate `transform: scale` on the glass or any ancestor.** A translated layer can be composited from existing pixels; a scaled one must be re-rasterised, and if the masks of the backdrop layers are not ready in that frame they come out unmasked: the whole pill flashes bright for one frame.
- **Avoid animating the short side through large ranges** (for example an entrance that grows the height from 48 to 62px). Every step past the ratchet rebakes and swaps images mid-animation, which shows as flicker.
- Content inside the glass (labels, icons) may scale freely, it carries no glass.
- Keep animated glass on screen or at least keep it rasterised: Chromium does not rasterise content outside the viewport, so a glass element parked off-screen with a transform gets its masks rasterised only once it slides in. If you do park elements, put a permanent `will-change: transform` on a moving wrapper **that has no backdrop-filter itself**, so the layer exists before the animation starts.

## 9. Performance: what mattered

What made it cheaper, roughly in order of impact:

- **Not rebaking.** The nine-slice plus the ratchet means a resize normally writes a few numbers instead of generating new images. Freshly set data URLs have to be decoded and rasterised, and until that happens the filter on the layer is ineffective, which looks like a stutter or a flash.
- **Fewer filter primitives.** Cost scales with the number of primitives in the SVG filter chains, not with the number of pixels. Pre-multiplying the corner tiles removed a large share of them. Halving the filter resolution, by contrast, gained almost nothing.
- **Precomputed fields** once the size has settled, see section 4: six primitives instead of 35, with the images kept small because they are copied to the compositor every frame.
- **Bitmap tiles instead of SVG gradient tiles**, for both the filter tiles and the reflection mask corners: decoded once, then only stretched.
- **Only write what changed.** Setting an SVG attribute to its current value still invalidates the filter and re-filters the backdrop. During a width change most values (corner sizes, scale) stay the same, so every write is compared first (`setAttr`, `setStyle`).
- **No framework re-render per frame**, see section 7.
- **Measure the surroundings lazily** (coarse steps, only once the element stands still) and skip all baking in browsers that cannot run the filter.

What did not help or made things worse:

- Splitting the pill into fixed-size halves to avoid per-frame updates: fewer attribute writes, but more GPU work.
- Precomputed fields at full resolution, or over the whole reflection overhang: calm, but 2 ms per frame on the compositor thread just to copy the images, and the scroll crawled.
- `feImage` with a reference to an SVG element instead of an image, which would have avoided the copy: Chromium renders nothing from it inside a backdrop filter.
- Hiding the reflection during animations and resyncing afterwards: no measurable gain.
- Rebuilding the glass in WebGL from DOM snapshots: it looked the same in isolation, but snapshotting large sections was slow and moving content (videos, carousels) went stale. Dropped in favour of the DOM version.
- Removing the `translateZ(0)` on the pane and edge layers: changes the rendered pixels, so it stays.

Rule of thumb: static glass costs little. The cost is in glass that changes its geometry every frame and in how many glass elements are visible at once.

## Pitfalls

Each of these broke the effect at least once.

- **Backdrop roots on ancestors.** `filter`, `opacity < 1`, `mask`, `clip-path`, `backdrop-filter`, `mix-blend-mode` other than normal, and `will-change` for any of those, on the host **or any ancestor**, make that element the backdrop root. The glass then refracts only what is inside that element. In practice a `transform` or `will-change` on a wrapper around the glass also cut off its backdrop in Chrome; move such wrappers with `top/left` instead, as the demo centres the glass with `inset` and `margin: auto`.
- **`isolation: isolate` on the host** does the same. Leave it off.
- **`overflow: hidden`** on the host or an ancestor clips the reflection overhang (and the shadow). Clip content on an inner element instead.
- **`mix-blend-mode` on any glass layer** turns the host into a backdrop root. That is why `.lg-spec` is a plain translucent white.
- **CSS minifiers and `backdrop-filter`.** Some minifiers merge or drop the unprefixed `backdrop-filter` when a `-webkit-` version sits next to it, leaving only the prefixed one, which Chromium ignores. All backdrop filters are therefore set inline from JavaScript.
- **`feImage href="#element"`.** An `feImage` that references a document element is treated as tainted and may not feed `feDisplacementMap`; the whole filter silently fails. The tiles must be data URLs. The filter itself can live in the document and be referenced with `url(#id)`.
- **`display: none` on the filter's `<svg>`.** Chromium does not resolve filters in a removed subtree. Use a zero-size, absolutely positioned `<svg>`.
- **Swapping mask or filter images during motion.** A freshly set mask image is not rasterised for a frame and does not mask in that frame: the reflection overhang or the edge brightness appears over the whole pill. Never swap images while the element moves; that is what the "stands still" check is for.
- **Coloured displacement maps on P3 screens.** See "Why everything is grey".
- **Zero-sized filter subregions.** A primitive with width or height 0 is disabled, and engines disagree on what it outputs. `sliceRect` uses 0.01 instead.
- **Measuring too early.** The first measurement may run before CSS or fonts settle; the delayed `onView` check after creation corrects it. If you create the glass while the element is hidden (`display: none`), the ResizeObserver bakes once it gets a size.
- **Testing.** Headless WebKit does not render `backdrop-filter` at all, and headless Chrome hides the P3 bug. Judge the look in a real browser on a real screen.

## Browser support

Chromium runs `url()` inside `backdrop-filter`; Safari and Firefox do not (Safari parses it but does not execute it). `SVG_BACKDROP` in `liquid-glass.ts` checks for `navigator.userAgentData`, which only Chromium exposes, and otherwise leaves the pane at `blur() saturate()` and skips all baking. Those browsers get frosted glass; the edge, shadow and caustic layers are plain CSS and still apply. If WebKit ships SVG filters in `backdrop-filter`, widening that check is all it takes.
