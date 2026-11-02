import {
  CORNERS,
  EDGES,
  PACK_Y,
  REFR_FOLD_DEPTH,
  SLOTS,
  TILT_MULTIPLY,
  UNPACK,
  buildBevelArcs,
  buildReflection,
  buildRefraction,
  reflectionPad,
  reflectionScale,
  refractionScale,
  sliceRect,
  tiltGain,
  type Axis,
  type Corner,
  type ReflectAvail,
  type ReflectionMap,
  type RefractionMap,
  type SliceRect,
  type Slot,
  type Tiles,
} from "./maps";
import "./liquid-glass.css";

export type LiquidGlassOptions = {
  /** Corner radius in CSS px. Default 30. */
  radius?: number;
  /** Width of the refracting rim, relative. Default 1.3. */
  rim?: number;
  /** Frost behind the glass in CSS px. Default 2. */
  blur?: number;
  saturate?: number;
  /** Mirror the surroundings into the rim. Costs one more backdrop layer. Default true. */
  reflect?: boolean;
  /** 1 is physical Fresnel; higher only raises the level. Default 2.5. */
  reflectStrength?: number;
};

/* Rebake only when the short side moves clearly away from the baked one.
   Down is generous (a larger map laid into a smaller box IS the smaller
   shape) and waits until the size settles, so a quick overshoot never swaps
   an href mid-animation. Up is tight, because there the tiles get stretched. */
const BAKE_SLACK_DOWN = 12;
const BAKE_SLACK_UP = 3;
const BAKE_SETTLE_MS = 650;
/** Free space around the element is measured in steps of this many px. */
const AVAIL_STEP = 8;
/** Filter region margin around the box. */
const REGION = 2;

const REFR_CACHE = new Map<string, RefractionMap>();
function cachedRefraction(short: number, radius: number) {
  const key = `${short}|${radius}`;
  let map = REFR_CACHE.get(key);
  if (!map) {
    map = buildRefraction(short, radius);
    if (REFR_CACHE.size >= 96) REFR_CACHE.delete(REFR_CACHE.keys().next().value as string);
    REFR_CACHE.set(key, map);
  }
  return map;
}

/* Only Chromium runs url() filters inside backdrop-filter. Safari drops the
   whole declaration, blur included, so everyone else gets frosted glass
   without refraction. navigator.userAgentData exists in Chromium only. */
const SVG_BACKDROP = typeof navigator !== "undefined" && "userAgentData" in navigator;

/** False where the glass falls back to frosted glass without refraction. */
export const supportsRefraction = SVG_BACKDROP;

const SVG_NS = "http://www.w3.org/2000/svg";

function el<K extends keyof SVGElementTagNameMap>(parent: Node, tag: K, attrs: Record<string, string | number> = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  parent.appendChild(node);
  return node;
}

function layer(parent: Node, cls: string) {
  const node = document.createElement("span");
  node.className = cls;
  node.setAttribute("aria-hidden", "true");
  parent.appendChild(node);
  return node;
}

/* Writing an SVG attribute, even to the same value, invalidates the filter
   and re-filters the backdrop. During a resize most values do not change
   (corners keep their size, only the edges grow), so compare first. */
const setAttr = (node: Element, name: string, value: number | string) => {
  const next = String(value);
  if (node.getAttribute(name) !== next) node.setAttribute(name, next);
};

const setRect = (node: Element, r: SliceRect) => {
  setAttr(node, "x", r.x);
  setAttr(node, "y", r.y);
  setAttr(node, "width", r.w);
  setAttr(node, "height", r.h);
};

const setStyle = (node: HTMLElement, name: string, value: string) => {
  if (node.style.getPropertyValue(name) !== value) node.style.setProperty(name, value);
};

const setBackdrop = (node: HTMLElement, value: string) => {
  setStyle(node, "backdrop-filter", value);
  setStyle(node, "-webkit-backdrop-filter", value);
};

/** One displacement field (x and y as separate grey images) for a nine-slice. */
type Field = {
  edges: Partial<Record<Slot, SVGFEImageElement>>;
  corners: Record<`${Axis}${Corner}`, SVGFEImageElement>;
};

function buildField(filter: SVGFilterElement, p: string): Field {
  el(filter, "feFlood", { "flood-color": "rgb(128,128,128)", result: `${p}base` });
  const edges: Field["edges"] = {};
  for (const slot of EDGES)
    edges[slot] = el(filter, "feImage", { preserveAspectRatio: "none", result: `${p}${slot}` });
  const corners = {} as Field["corners"];
  for (const axis of ["x", "y"] as const) {
    for (const c of CORNERS)
      corners[`${axis}${c}`] = el(filter, "feImage", { preserveAspectRatio: "none", result: `${p}c${axis}${c}` });
    const merge = el(filter, "feMerge", { result: `${p}${axis}` });
    el(merge, "feMergeNode", { in: `${p}base` });
    for (const c of CORNERS) el(merge, "feMergeNode", { in: `${p}c${axis}${c}` });
    for (const slot of axis === "x" ? ["left", "right"] : ["top", "bottom"]) el(merge, "feMergeNode", { in: `${p}${slot}` });
  }
  return { edges, corners };
}

/** Grey x and y become one coloured map only at the very end (see maps.ts). */
function packField(filter: SVGFilterElement, x: string, y: string, out: string) {
  el(filter, "feColorMatrix", { in: y, type: "matrix", values: PACK_Y, result: `${out}ya` });
  el(filter, "feComposite", { in: x, in2: `${out}ya`, operator: "in", result: `${out}xy` });
  el(filter, "feColorMatrix", { in: `${out}xy`, type: "matrix", values: UNPACK, result: out });
  return el(filter, "feDisplacementMap", {
    in: "SourceGraphic",
    in2: out,
    xChannelSelector: "R",
    yChannelSelector: "G",
    result: "bent",
  });
}

function setFieldImages(field: Field, map: { slice: Tiles; prod: Record<Axis, Record<Corner, string>> }) {
  for (const slot of EDGES) setAttr(field.edges[slot]!, "href", map.slice.img[slot]!);
  for (const axis of ["x", "y"] as const)
    for (const c of CORNERS) setAttr(field.corners[`${axis}${c}`], "href", map.prod[axis][c]);
}

function layField(field: Field, tiles: Tiles, w: number, h: number, ox = 0, oy = 0) {
  for (const slot of EDGES) setRect(field.edges[slot]!, sliceRect(slot, w, h, tiles.r, tiles.reach, ox, oy));
  for (const c of CORNERS) {
    const rect = sliceRect(c, w, h, tiles.r, tiles.reach, ox, oy);
    setRect(field.corners[`x${c}`], rect);
    setRect(field.corners[`y${c}`], rect);
  }
}

let instances = 0;

/**
 * Turns `host` into liquid glass. The host keeps its own content; the glass
 * layers are inserted in front of it and everything else is raised above
 * them. Size changes of the host are followed automatically.
 */
export function createLiquidGlass(host: HTMLElement, options: LiquidGlassOptions = {}) {
  const { radius = 30, rim = 1.3, blur = 2, saturate = 1.1, reflect = true, reflectStrength = 2.5 } = options;
  const uid = ++instances;
  const refractId = `lg-refract-${uid}`;
  const reflectId = `lg-reflect-${uid}`;

  host.classList.add("lg-host");
  host.style.borderRadius = `${radius}px`;

  const root = document.createDocumentFragment();

  /* --- The two filters, as real SVG in the document ---------------------- */

  const defs = el(root, "svg", { class: "lg-defs", width: 0, height: 0, "aria-hidden": "true" });

  const refrFilter = el(defs, "filter", {
    id: refractId,
    filterUnits: "userSpaceOnUse",
    "color-interpolation-filters": "sRGB",
    x: -REGION,
    y: -REGION,
  });
  const refrField = buildField(refrFilter, "r");

  // Tilt: magnitude tiles times a sign field (+1 left, ramp over the straight
  // run, -1 right), added onto the x field with a strength that follows the
  // length of the straight run.
  el(refrFilter, "feFlood", { "flood-color": "rgb(128,128,128)", result: "tbase" });
  const tiltTiles: Partial<Record<Slot, SVGFEImageElement>> = {};
  for (const slot of SLOTS) tiltTiles[slot] = el(refrFilter, "feImage", { preserveAspectRatio: "none", result: `t${slot}` });
  const tmag = el(refrFilter, "feMerge", { result: "tmag" });
  el(tmag, "feMergeNode", { in: "tbase" });
  for (const slot of SLOTS) el(tmag, "feMergeNode", { in: `t${slot}` });
  el(refrFilter, "feFlood", { "flood-color": "rgb(255,255,255)", result: "sbase" });
  const tiltRamp = el(refrFilter, "feImage", { preserveAspectRatio: "none", y: 0, result: "sramp" });
  const sfield = el(refrFilter, "feMerge", { result: "sfield" });
  el(sfield, "feMergeNode", { in: "sbase" });
  el(sfield, "feMergeNode", { in: "sramp" });
  el(refrFilter, "feComposite", { in: "tmag", in2: "sfield", operator: "arithmetic", ...TILT_MULTIPLY, result: "tvec" });
  const tiltAdd = el(refrFilter, "feComposite", { in: "rx", in2: "tvec", operator: "arithmetic", k1: 0, k2: 1, result: "rxt" });
  const refrDisp = packField(refrFilter, "rxt", "ry", "rmap");

  const reflFilter = el(defs, "filter", {
    id: reflectId,
    filterUnits: "userSpaceOnUse",
    "color-interpolation-filters": "sRGB",
    x: -REGION,
    y: -REGION,
  });
  const reflField = buildField(reflFilter, "f");
  const reflDisp = packField(reflFilter, "fx", "fy", "fmap");
  // A curved mirror compresses its image and loses angular resolution.
  const reflBlur = el(reflFilter, "feGaussianBlur", { in: "bent" });

  /* --- The layers ---------------------------------------------------------

     Siblings, not nested: an element with backdrop-filter is a backdrop root,
     so a child of it would only see its parent, not the page. Order matters,
     a backdrop-filter sees what was painted before it. The reflection comes
     first so its backdrop is the page only (not the shadow and caustic below
     the pill); z-index lifts it above the pane when painting. */

  const reflectLayer = layer(root, "lg-layer lg-reflect");
  reflectLayer.hidden = true;
  const causticWrap = layer(root, "lg-layer lg-caustic");
  layer(causticWrap, "lg-caustic-ring");
  const pane = layer(root, "lg-layer lg-pane");
  const fold = layer(root, "lg-layer lg-edge lg-fold");
  const glint = layer(root, "lg-layer lg-edge lg-glint");
  const rimLayer = layer(root, "lg-layer lg-edge lg-rim");
  host.prepend(root);

  // The two layers that differ most between light and dark: a sibling right
  // after the host, not a layer inside it, so they can be crossfaded without
  // touching the glass (addCover). A paint change inside the host repaints
  // the glass, and doing that on every frame flickers. Above everything the
  // host draws, content included.
  const makeCover = () => {
    const c = document.createElement("div");
    c.className = "lg-cover";
    c.setAttribute("aria-hidden", "true");
    c.style.position = "absolute";
    layer(c, "lg-layer lg-edge lg-spec");
    layer(c, "lg-layer lg-underlay");
    return c;
  };
  const cover = makeCover();
  const covers = [cover];
  host.after(cover);

  // A near-invisible fill right under the glass; refresh() changes it so
  // Chromium redraws the glass (see refresh below). It is page content, a
  // sibling before the host, not a layer inside it: a change inside the host
  // repaints the host's own layers, and that flickered.
  const tick = document.createElement("span");
  tick.className = "lg-tick";
  tick.setAttribute("aria-hidden", "true");
  // Out of the flow from the start, so it never becomes a flex or grid item.
  tick.style.position = "absolute";
  host.before(tick);

  /** Lays the fill and the cover onto the host. Ignores transforms. */
  const place = () => {
    const cs = getComputedStyle(host);
    const fixed = cs.position === "fixed";
    const r = host.getBoundingClientRect();
    // Unrounded, unlike offsetLeft/offsetTop: a pixel off shows at the edge.
    const o = fixed ? { left: 0, top: 0 } : (host.offsetParent ?? document.body).getBoundingClientRect();
    for (const el of [tick, ...covers]) {
      setStyle(el, "position", fixed ? "fixed" : "absolute");
      setStyle(el, "left", `${r.left - o.left}px`);
      setStyle(el, "top", `${r.top - o.top}px`);
      setStyle(el, "width", `${r.width}px`);
      setStyle(el, "height", `${r.height}px`);
    }
    // A cover is not a child, so it inherits nothing from the host.
    for (const c of covers) {
      setStyle(c, "z-index", cs.zIndex);
      setStyle(c, "border-radius", cs.borderRadius);
      for (const name of ["--lg-r", "--lg-s", "--lg-rim-w", "--lg-rim-fade"]) {
        const v = cs.getPropertyValue(name);
        if (v) setStyle(c, name, v);
        else c.style.removeProperty(name);
      }
    }
  };

  // Edge layers only change exposure, they never displace -- displacing in
  // more than one layer drags image parts to places they do not belong.
  // Set inline: CSS minifiers like to merge or drop backdrop-filter when the
  // prefixed and unprefixed versions sit next to each other.
  const bevel = (prop: string, exposure: number, sat: number) =>
    `brightness(var(--lg-${prop}-exp, ${exposure})) saturate(var(--lg-${prop}-sat, ${sat}))`;
  setBackdrop(fold, "brightness(var(--lg-fold-exp, 1.08)) saturate(var(--lg-fold-sat, 1.3))");
  fold.style.setProperty("--lg-fold-k", String(REFR_FOLD_DEPTH));
  setBackdrop(glint, bevel("glint", 1.35, 3.1));
  setBackdrop(rimLayer, bevel("rim", 0.84, 2.2));

  const frost = `${blur > 0 ? ` blur(${blur}px)` : ""} saturate(${saturate})`;
  setBackdrop(pane, frost.trim());

  /* --- State --------------------------------------------------------------- */

  let w = 0;
  let h = 0;
  let baked = 0;
  let refr: RefractionMap | null = null;
  let refl: ReflectionMap | null = null;
  let reflSize = { w: 0, h: 0 };
  let avail: ReflectAvail | null = null;
  let bakeTimer = 0;
  let viewTimer = 0;
  let lastSpot = "";

  const measureAvail = (): ReflectAvail => {
    const r = host.getBoundingClientRect();
    const q = (v: number) => Math.max(0, Math.floor(v / AVAIL_STEP) * AVAIL_STEP);
    return [q(r.top), q(innerWidth - r.right), q(innerHeight - r.bottom), q(r.left)];
  };

  /** Lays every tile into the current box. Never bakes. */
  const sync = () => {
    host.style.setProperty("--lg-r", `${Math.max(0.01, Math.min(radius, w / 2, h / 2))}px`);

    if (refr) {
      layField(refrField, refr.slice, w, h);
      for (const slot of SLOTS) setRect(tiltTiles[slot]!, sliceRect(slot, w, h, refr.tilt.r, refr.tilt.reach));
      const r = Math.max(0.01, Math.min(refr.slice.r, w / 2, h / 2));
      setAttr(tiltRamp, "x", r);
      setAttr(tiltRamp, "width", Math.max(0.01, w - 2 * r));
      setAttr(tiltRamp, "height", h);
      const g = tiltGain(refr, w, h);
      setAttr(tiltAdd, "k3", g);
      setAttr(tiltAdd, "k4", -g / 2);
      setAttr(refrDisp, "scale", refractionScale(refr, w, h));
      setAttr(refrFilter, "width", w + REGION * 2);
      setAttr(refrFilter, "height", h + REGION * 2);
    }

    if (refl) {
      const [pt, pr, pb, pl] = refl.pad;
      layField(reflField, refl.slice, w, h, pl, pt);
      setAttr(reflDisp, "scale", reflectionScale(refl, w, h));
      setAttr(reflFilter, "width", w + pl + pr + REGION * 2);
      setAttr(reflFilter, "height", h + pt + pb + REGION * 2);
      const rects = SLOTS.map((slot) => sliceRect(slot, w, h, refl!.mask.r, refl!.mask.reach, pl, pt));
      const position = rects.map((r) => `${r.x}px ${r.y}px`).join(",");
      const size = rects.map((r) => `${r.w}px ${r.h}px`).join(",");
      setStyle(reflectLayer, "mask-position", position);
      setStyle(reflectLayer, "-webkit-mask-position", position);
      setStyle(reflectLayer, "mask-size", size);
      setStyle(reflectLayer, "-webkit-mask-size", size);
    }

    place();
    const arcs = buildBevelArcs(w, h);
    setStyle(glint, "--lg-arc-glint", arcs.glint);
    for (const c of covers) setStyle(c.querySelector<HTMLElement>(".lg-spec")!, "--lg-arc-glint", arcs.glint);
    setStyle(rimLayer, "--lg-arc-rim", arcs.rim);
  };

  /** New reflection map: when the bake size or the free space around changes. */
  const rebuildReflection = () => {
    refl = reflect && avail ? buildReflection(reflSize.w, reflSize.h, radius, rim, reflectStrength, avail) : null;
    reflectLayer.hidden = !refl;
    if (!refl) return;

    setFieldImages(reflField, refl);
    setAttr(reflBlur, "stdDeviation", refl.blur);
    const [pt, pr, pb, pl] = refl.pad;
    reflectLayer.style.inset = `${-pt}px ${-pr}px ${-pb}px ${-pl}px`;
    // Same shape as the mask, as a plain compositor clip: it keeps the filter
    // work to the outline instead of the whole overhang, and if the mask is
    // not rasterised yet for one frame, the overhang still cannot flash.
    const clip = `inset(${pt}px ${pr}px ${pb}px ${pl}px round var(--lg-r))`;
    setStyle(reflectLayer, "clip-path", clip);
    setStyle(reflectLayer, "-webkit-clip-path", clip);
    const images = SLOTS.map((slot) => {
      const img = refl!.mask.img[slot]!;
      return img.startsWith("linear-gradient(") ? img : `url("${img}")`;
    }).join(",");
    setStyle(reflectLayer, "mask-image", images);
    setStyle(reflectLayer, "-webkit-mask-image", images);
    setBackdrop(reflectLayer, `url(#${reflectId})`);
  };

  const bake = (short: number) => {
    baked = short;
    refr = cachedRefraction(short, radius);
    setFieldImages(refrField, refr);
    for (const slot of SLOTS) setAttr(tiltTiles[slot]!, "href", refr.tilt.img[slot]!);
    setAttr(tiltRamp, "href", refr.tiltRamp);
    // The reflection depends on the full size, but only follows the bake --
    // otherwise it would rebuild on every frame of a width animation.
    reflSize = { w, h };
    rebuildReflection();
    setBackdrop(pane, `url(#${refractId})${frost}`);
  };

  const onResize = () => {
    const nw = Math.round(host.clientWidth);
    const nh = Math.round(host.clientHeight);
    if (nw < 8 || nh < 8 || (nw === w && nh === h)) return;
    w = nw;
    h = nh;

    const s = Math.min(w, h);
    if (!SVG_BACKDROP) {
      // Frosted fallback: nothing to bake.
    } else if (!refr) {
      avail = measureAvail();
      bake(s);
    } else if (s > baked + BAKE_SLACK_UP) {
      clearTimeout(bakeTimer);
      bake(s);
    } else if (baked - s > BAKE_SLACK_DOWN) {
      clearTimeout(bakeTimer);
      bakeTimer = window.setTimeout(() => {
        const settled = Math.min(Math.round(host.clientWidth), Math.round(host.clientHeight));
        if (Math.abs(settled - s) <= 1 && baked - settled > BAKE_SLACK_DOWN) {
          bake(settled);
          sync();
        }
      }, BAKE_SETTLE_MS);
    } else {
      clearTimeout(bakeTimer);
    }
    sync();
  };

  // Only the reflection depends on where the element sits. Re-measure once
  // the ELEMENT stands still (transitions fire no scroll events), and swap
  // nothing while it moves: a fresh mask is not rasterised for a frame.
  const onView = () => {
    clearTimeout(viewTimer);
    viewTimer = window.setTimeout(function check() {
      const r = host.getBoundingClientRect();
      const spot = `${Math.round(r.top)}:${Math.round(r.left)}`;
      if (spot !== lastSpot) {
        lastSpot = spot;
        viewTimer = window.setTimeout(check, 120);
        return;
      }
      place();
      const next = measureAvail();
      if (!refr) return;
      // Only rebuild when the overhang actually changes: with room to spare
      // on every side, moving or resizing the element gives the same map.
      const short = Math.min(reflSize.w, reflSize.h);
      const before = avail && reflectionPad(short, avail);
      avail = next;
      if (!before || reflectionPad(short, next).some((v, i) => v !== before[i])) {
        rebuildReflection();
        sync();
      }
    }, 220);
  };

  // Chromium redraws the glass only when something changes under its own
  // outline. The reflection also reads the area around it, so while the page
  // scrolls past with nothing changing right underneath (one flat colour),
  // the reflection holds a stale picture and catches up in a jump: a flicker.
  const refresh = () => {
    tick.toggleAttribute("data-tick");
  };
  const onScroll = () => {
    if (refl) refresh();
    onView();
  };

  const ro = new ResizeObserver(onResize);
  ro.observe(host);
  addEventListener("scroll", onScroll, { passive: true });
  addEventListener("resize", onView, { passive: true });
  onResize();
  // The first measurement may run before layout or fonts have settled.
  onView();

  return {
    /**
     * Scrolling is handled already. Content that changes next to the glass on
     * its own (a playing video) still freezes in the reflection; call this
     * for every frame of such content to keep it live.
     */
    refresh,
    /**
     * Re-places the fill under the glass and the covers over it after the
     * host moved without changing size, for example from fixed to absolute.
     */
    update() {
      place();
      onView();
    },
    /**
     * A further cover with a fixed tuning, appended to `parent`; hides the
     * built-in one. Make one light and one dark cover and crossfade them with
     * opacity (on a will-change: opacity layer): the compositor blends them
     * without repainting anything. Positioned like the host, so with a host
     * that is not fixed, `parent` must be its parent.
     */
    addCover(parent: HTMLElement, dark: number) {
      const c = makeCover();
      c.style.setProperty("--lg-dark", String(dark));
      parent.append(c);
      covers.push(c);
      cover.hidden = true;
      place();
      sync();
      return c;
    },
    destroy() {
      ro.disconnect();
      clearTimeout(bakeTimer);
      clearTimeout(viewTimer);
      removeEventListener("scroll", onScroll);
      removeEventListener("resize", onView);
      host.querySelectorAll(":scope > .lg-layer, :scope > .lg-defs").forEach((n) => n.remove());
      tick.remove();
      for (const c of covers) c.remove();
      host.classList.remove("lg-host");
    },
  };
}
