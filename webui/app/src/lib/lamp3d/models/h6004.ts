/**
 * The H6004 as it physically exists in Luke's hall: a Room Essentials
 * "Shelf Floor Lamp" from Target (DPCI A-90025032 / A-78655318) with a Govee
 * H6004 bulb screwed into it. A floor lamp, not a bulb — so unlike every
 * other model in this directory, what the console draws is the *fixture*, and
 * the Govee hardware is the thing lighting its shade from inside.
 *
 * ## What is published, and where
 *
 * Target's spec block gives the overall size, shade, base and bulb base; its
 * Q&A gives the shelf spacing. One unit = the lamp's 11" footprint, so the
 * shade, the base and the shelves are all exactly `1` unit across and the
 * whole lamp is `56/11` tall. Keeping the real inch figures beside each
 * constant is the point: this file can be checked against the product page
 * rather than against someone's memory of it.
 *
 *   - overall            56" H x 11" W x 11" D        (spec block)
 *   - shade              cylindrical, 11.5" H, 11" top, 11" bottom, white
 *                        terylene fabric — a TRUE cylinder; the spec gives
 *                        the same width at top and bottom                (spec)
 *   - base               round, 11" dia x 1" H                           (spec)
 *   - shelves            two, "14 1/8" off the floor and also apart from
 *                        each other"                                      (Q&A)
 *   - frame              black metal, E26 socket, pull chain              (photos)
 *
 * The Q&A source is Target's answer on the A-90025032 product page (2026-10-19):
 * *"Please see assembly instructions attached. … They shelves are 14 1/8" off
 * the floor and also apart from each other."* It is not in the spec block.
 *
 * ## What is inferred from the photos, and why
 *
 *  - **The shelves are round.** Target gives their count and spacing but not
 *    their shape. The assembled footprint is 11" x 11" and the base is round
 *    at 11" — an 11" *square* shelf would have a 15.6" diagonal and could not
 *    fit inside a stated 11" depth, so a shelf that spans the full width has
 *    to be round. Modelled at the base's own radius on that basis.
 *  - **The frame is an open post frame, not a centre pole.** The straight-on
 *    product image shows two posts because the front/back pairs align; the
 *    angled images show four around the circular shelf rims. This model uses
 *    four posts at 45° offsets, a flat ring under the shade, and the shelves
 *    supported at their rims. The only centre member is the pull chain. A
 *    first port of this model used a centred pole; the photos contradict it.
 *  - **Post, shelf and ring thickness, socket/bulb size, chain length.** Not
 *    published. They are set to ordinary values for a lamp of this weight
 *    (8 lb) and read correctly at any size the console draws. They are the
 *    free parameters here.
 *
 * Anything else that looks like a choice was read off the spec or the photos.
 *
 * ## Why the shade is the diffuser, and why it is dark
 *
 * The shade is the only surface the bulb's light reaches an observer through,
 * so it is the mesh that carries `emissiveMap` — the bulb itself is inside it
 * and is deliberately not modelled, because nothing of it is visible once the
 * shade is on.
 *
 * Its base colour is near-black even though the real shade is white, for the
 * reason `h6022.ts`'s `buildDiffuser()` and `h6008.ts` both spell out: the
 * body has to sit dark before the LEDs turn on or emission cannot compete
 * with the lit surface, and every bright colour clips to the same white. The
 * white the eye actually sees is emission, not albedo.
 *
 * `sheen` and `roughness` are copied from `h6022.ts` rather than retuned.
 * That model's shade is also a cylinder, and CLAUDE.md's note about sheen
 * painting white nearly everywhere on a cylinder (most of its visible surface
 * is grazing) applies here identically — its numbers are the ones already
 * proven against that failure on this exact geometry.
 *
 * ## No UV remapping, for the same reason as h6008.ts
 *
 * `h6022.ts` and `h6056.ts` remap `uv` because their `emissiveMap` is a
 * multi-texel texture whose sampled colour depends on where a vertex's UV
 * lands. This model is always the 1x1 `singleEmitterLayout()` — the H6004 is
 * a single-zone bulb with no segments over any transport (see
 * `transport.py`'s spec and `devices/h6004.py`) — so its `emissiveMap` is a
 * 1x1 `DataTexture` and every UV on the shade samples its one and only texel.
 * No profile edit here can introduce a banding bug, because there is no
 * second texel to land on.
 */

import {
  CylinderGeometry,
  Group,
  LatheGeometry,
  Mesh,
  MeshPhysicalMaterial,
  SphereGeometry,
  Vector2,
  type BufferGeometry,
  type Material,
} from "three";
import { singleEmitterLayout, type LampModel, type LedPlacement, type ProceduralSource } from "./types";

/** One model unit = the lamp's published 11" width, so every published
 *  dimension below is `inches / 11`. */
const INCH = 1 / 11;

/** 56" overall. */
const TOTAL_HEIGHT = 56 * INCH;

/** The shade: 11" across (radius 5.5"), 11.5" tall, sitting at the top. */
const SHADE_RADIUS = 5.5 * INCH;
const SHADE_HEIGHT = 11.5 * INCH;
const SHADE_BOTTOM_Y = TOTAL_HEIGHT - SHADE_HEIGHT;
const SHADE_TOP_Y = TOTAL_HEIGHT;

/** Round base, 11" dia x 1" H. */
const BASE_RADIUS = 5.5 * INCH;
const BASE_HEIGHT = 1 * INCH;

/** Two shelves, the lower "14 1/8 off the floor" and the upper the same
 *  distance again above it, per Target's Q&A (not the spec block). The
 *  figure is read as the shelf's own surface — the height you would stand
 *  something on — so each plate hangs just below its quoted y. */
const SHELF_SPACING = 14.125 * INCH;
const SHELF_LOWER_Y = SHELF_SPACING;
const SHELF_UPPER_Y = SHELF_SPACING * 2;
const SHELF_RADIUS = 5.5 * INCH;
/** Inferred — see the file header. A thin metal plate. */
const SHELF_THICKNESS = 0.4 * INCH;

/** Four vertical posts, at 45°/135°/225°/315°, just inside the shelf rims.
 *  Inferred from the two product views — see the file header. */
const POST_COUNT = 4;
const POST_RADIUS = 0.275 * INCH;
const POST_RING_RADIUS = SHELF_RADIUS - POST_RADIUS;
const POST_TOP_Y = SHADE_BOTTOM_Y - SHELF_THICKNESS;
const POST_HEIGHT = POST_TOP_Y - BASE_HEIGHT;
const POST_SEGMENTS = 12;

/** The flat ring the shade sits on; the socket passes through its hole. The
 *  photos show a black disc with a centre opening, not a torus. */
const RING_INNER_RADIUS = 0.09;
const TOP_RING_THICKNESS = SHELF_THICKNESS;

/** Inferred — see the file header. A standard E26 socket and the pull chain
 *  that hangs through the ring. */
const SOCKET_RADIUS = 0.06;
const SOCKET_HEIGHT = 0.14;
const LED_Y = SHADE_BOTTOM_Y + SOCKET_HEIGHT;
const CHAIN_RADIUS = 0.006;
const CHAIN_LENGTH = 5 * INCH;
const CHAIN_BALL_RADIUS = 0.02;

/** Angular smoothness. The shade is the silhouette that matters and is the
 *  one surface lit from within, so it gets the same 40 as `h6008.ts`'s glass;
 *  the black frame parts read as outline only and are cheaper. */
const SHADE_SEGMENTS = 40;
const FRAME_SEGMENTS = 32;

/**
 * The shade wall: a true cylinder, per the spec's equal top and bottom
 * widths, with a shallow chamfer drawn in at each rim.
 *
 * A `LatheGeometry` rather than a `CylinderGeometry` so those rims exist at
 * all: an open-ended cylinder ends in a hard circular edge that catches the
 * key light as a bright line, while the chamfer rolls it the way a fabric
 * shade's taped edge does. The wall's radius between the rims is constant —
 * it is not a barrel, and must not become one, because the spec gives the
 * same 11" for the top and bottom.
 */
function buildShadeGeometry(): BufferGeometry {
  const chamfer = SHADE_HEIGHT * 0.03;
  const profile: Vector2[] = [
    new Vector2(SHADE_RADIUS * 0.97, SHADE_BOTTOM_Y),
    new Vector2(SHADE_RADIUS, SHADE_BOTTOM_Y + chamfer),
    new Vector2(SHADE_RADIUS, SHADE_TOP_Y - chamfer),
    new Vector2(SHADE_RADIUS * 0.97, SHADE_TOP_Y),
  ];
  return new LatheGeometry(profile, SHADE_SEGMENTS);
}

/**
 * The flat annulus under the shade: outer radius at the shade wall, inner
 * radius at the socket opening. A closed lathe profile gives it a real
 * thickness and an inner wall, unlike a zero-thickness `RingGeometry`.
 */
function buildTopRingGeometry(): BufferGeometry {
  const profile: Vector2[] = [
    new Vector2(RING_INNER_RADIUS, 0),
    new Vector2(SHELF_RADIUS, 0),
    new Vector2(SHELF_RADIUS, TOP_RING_THICKNESS),
    new Vector2(RING_INNER_RADIUS, TOP_RING_THICKNESS),
    new Vector2(RING_INNER_RADIUS, 0),
  ];
  return new LatheGeometry(profile, FRAME_SEGMENTS);
}

/**
 * The one emitter, at the shade's optical centre.
 *
 * There is no matrix to distribute across, so what this position decides is
 * where `cast-light.ts` throws the fixture's spill from. That is the middle
 * of the shade — where the E26 socket puts the bulb — not the centroid of the
 * whole lamp, which on a 56" floor lamp sits around the lower shelf and
 * throws light from a point with no light source in it.
 */
function placeLed(): LedPlacement {
  return {
    index: 0,
    row: 0,
    col: 0,
    position: [0, LED_Y, 0],
    normal: [0, 1, 0],
  };
}

export const h6004Source: ProceduralSource = {
  kind: "procedural",
  // One emitter regardless of the layout passed, matching the contract's own
  // singleEmitterLayout() rather than trusting an incoming layout that should
  // not exist for this hardware — the same stance `h6008.ts` takes.
  build(): LampModel {
    const layout = singleEmitterLayout();

    const shadeGeometry = buildShadeGeometry();
    const baseGeometry = new CylinderGeometry(BASE_RADIUS, BASE_RADIUS, BASE_HEIGHT, FRAME_SEGMENTS);
    // One geometry, two meshes: the shelves are identical plates, so building
    // this twice would be two copies of the same buffer to dispose.
    const shelfGeometry = new CylinderGeometry(SHELF_RADIUS, SHELF_RADIUS, SHELF_THICKNESS, FRAME_SEGMENTS);
    const ringGeometry = buildTopRingGeometry();
    const postGeometry = new CylinderGeometry(POST_RADIUS, POST_RADIUS, POST_HEIGHT, POST_SEGMENTS);
    const socketGeometry = new CylinderGeometry(SOCKET_RADIUS, SOCKET_RADIUS, SOCKET_HEIGHT, FRAME_SEGMENTS);
    const chainGeometry = new CylinderGeometry(CHAIN_RADIUS, CHAIN_RADIUS, CHAIN_LENGTH, 6);
    const chainBallGeometry = new SphereGeometry(CHAIN_BALL_RADIUS, 8, 6);

    // See the file header: dark on purpose, and these numbers are h6022.ts's
    // proven cylinder values rather than a fresh guess.
    const diffuser = new MeshPhysicalMaterial({
      color: 0x18181d,
      roughness: 0.4,
      transmission: 0.55,
      thickness: 0.5,
      ior: 1.46,
      sheen: 0.25,
      sheenColor: 0xffffff,
      sheenRoughness: 0.45,
      // Left black on purpose: `emission.ts` lifts it to white exactly once,
      // when it first attaches the LED texture as `emissiveMap`.
      emissive: 0x000000,
    });
    diffuser.userData.baseTransmission = diffuser.transmission;

    // Black powder-coated steel, which is what this fixture actually is:
    // metallic enough to catch the key light along the posts, rough enough not
    // to mirror the environment map the way the H6008's nickel base does.
    const metal = new MeshPhysicalMaterial({
      color: 0x1c1c20,
      roughness: 0.55,
      metalness: 0.8,
    });

    const shadeMesh = new Mesh(shadeGeometry, diffuser);

    const baseMesh = new Mesh(baseGeometry, metal);
    baseMesh.position.y = BASE_HEIGHT / 2;

    const lowerShelf = new Mesh(shelfGeometry, metal);
    lowerShelf.position.y = SHELF_LOWER_Y - SHELF_THICKNESS / 2;
    const upperShelf = new Mesh(shelfGeometry, metal);
    upperShelf.position.y = SHELF_UPPER_Y - SHELF_THICKNESS / 2;

    // The ring's top face is the shade's bottom: the shade sits on it.
    const ringMesh = new Mesh(ringGeometry, metal);
    ringMesh.position.y = SHADE_BOTTOM_Y - TOP_RING_THICKNESS;

    const socketMesh = new Mesh(socketGeometry, metal);
    socketMesh.position.y = SHADE_BOTTOM_Y + SOCKET_HEIGHT / 2;

    const chainMesh = new Mesh(chainGeometry, metal);
    chainMesh.position.y = SHADE_BOTTOM_Y - CHAIN_LENGTH / 2;
    const chainBallMesh = new Mesh(chainBallGeometry, metal);
    chainBallMesh.position.y = SHADE_BOTTOM_Y - CHAIN_LENGTH - CHAIN_BALL_RADIUS;

    // Four posts at the shelf rims (45° offsets), from the base to the ring.
    const postMeshes = Array.from({ length: POST_COUNT }, (_, i) => {
      const angle = Math.PI / 4 + (i * Math.PI * 2) / POST_COUNT;
      const post = new Mesh(postGeometry, metal);
      post.position.set(
        Math.cos(angle) * POST_RING_RADIUS,
        BASE_HEIGHT + POST_HEIGHT / 2,
        Math.sin(angle) * POST_RING_RADIUS,
      );
      return post;
    });

    const group = new Group();
    group.add(
      baseMesh,
      ...postMeshes,
      lowerShelf,
      upperShelf,
      ringMesh,
      socketMesh,
      chainMesh,
      chainBallMesh,
      shadeMesh,
    );

    const led = placeLed();

    // Bounding radius about the model's own mid-height, the same measure
    // `h6008.ts` reports. On a lamp this slender the height dominates: the
    // widest ring is only 0.5 out, so the shade top and the base bottom are
    // the extremes. `renderer.ts` frames the camera from a measured `Box3`
    // and uses this only for the key light and the ground disc, both of
    // which want the lamp's true reach rather than its footprint.
    const halfHeight = TOTAL_HEIGHT / 2;
    const fitRadius = Math.max(
      Math.hypot(SHADE_RADIUS, TOTAL_HEIGHT - halfHeight),
      Math.hypot(BASE_RADIUS, halfHeight),
    );

    let disposed = false;
    return {
      model: "H6004",
      object3D: group,
      leds: [led],
      layout,
      diffusers: [shadeMesh],
      slots: { diffuser, metal },
      spill: [{ position: led.position, ledIndices: [0] }],
      fitRadius,
      height: TOTAL_HEIGHT,
      dispose(): void {
        if (disposed) return;
        disposed = true;
        shadeGeometry.dispose();
        baseGeometry.dispose();
        shelfGeometry.dispose();
        ringGeometry.dispose();
        postGeometry.dispose();
        socketGeometry.dispose();
        chainGeometry.dispose();
        chainBallGeometry.dispose();
        (diffuser as Material).dispose();
        (metal as Material).dispose();
      },
    };
  },
};
