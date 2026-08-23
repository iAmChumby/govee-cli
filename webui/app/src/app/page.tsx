"use client";

import * as React from "react";
import { animate, motion, useSpring, useTransform } from "motion/react";
import {
  CalendarClock,
  Info,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Terminal,
} from "lucide-react";

import {
  Button,
  Chip,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Dial,
  IconButton,
  Odometer,
  Panel,
  Popover,
  PopoverContent,
  PopoverTrigger,
  SectionLabel,
  Slider,
  StatusDot,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  useToast,
} from "@/components/ui";
import { StatusStrip } from "@/components/shell/status-strip";
import { TopBar } from "@/components/shell/top-bar";
import { cn } from "@/lib/cn";
import { panelIn, springHeavy, staggerParent } from "@/lib/motion";

/* ==================================================================
   App frame specimen — the visual contract for the next build phase.
   Left rail · top bar · console content · bottom status strip.
   Chrome is monochrome graphite; every trace of color below lives
   INSIDE a stage well, swatch, segment cell or scene thumb — light
   content, never decoration.
   ================================================================== */

/* ------------------------------------------------------------------
   Device fixtures (mock — later phases bind these to the sidecar)
   ------------------------------------------------------------------ */

interface PlateSpec {
  id: string;
  name: string;
  model: string;
  transport: string;
  /** identity light color — content only */
  hex: string;
  glowHue: number;
  glowSat: number;
  tempK?: number;
  initialPower: boolean;
  initialBrightness: number;
  stage: "zones" | "orb";
}

const PLATES: PlateSpec[] = [
  {
    id: "bars",
    name: "Light Bars",
    model: "H6056",
    transport: "cloud-v2",
    hex: "#4DA3FF",
    glowHue: 212,
    glowSat: 92,
    initialPower: true,
    initialBrightness: 74,
    stage: "zones",
  },
  {
    id: "lamp",
    name: "Shelf Lamp",
    model: "H6022",
    transport: "cloud-v2",
    hex: "#F5A83C",
    glowHue: 36,
    glowSat: 90,
    tempK: 3400,
    initialPower: true,
    initialBrightness: 42,
    stage: "zones",
  },
  {
    id: "bulb",
    name: "Bulb",
    model: "H6008",
    transport: "cloud-v2",
    hex: "#F26D8D",
    glowHue: 350,
    glowSat: 82,
    initialPower: false,
    initialBrightness: 30,
    stage: "orb",
  },
];

function zoneBackground(hue: number, sat: number, i: number): string {
  const t = i / 14;
  const l = 64 - t * 18;
  return `hsl(${hue} ${sat}% ${l}%)`;
}

/* ------------------------------------------------------------------
   Mini stage preview — device glow is the only color here, ramped
   through the registered --glow-alpha-style spring (heavy, weighted).
   ------------------------------------------------------------------ */

function MiniStage({
  spec,
  power,
  brightness,
}: {
  spec: PlateSpec;
  power: boolean;
  brightness: number;
}) {
  const glow = useSpring(0, springHeavy);

  React.useEffect(() => {
    const target = power ? 0.28 + 0.72 * (brightness / 100) : 0;
    void animate(glow, target, springHeavy);
  }, [power, brightness, glow]);

  const bodyOpacity = useTransform(glow, [0, 1], [0.07, 1]);
  const { glowHue: hue, glowSat: sat, stage } = spec;

  return (
    <div
      className="relative mt-3 h-24 overflow-hidden rounded-card border border-hairline bg-raised"
      role="img"
      aria-label={`${spec.name} live preview`}
    >
      {/* light emission halo — blurred radial, rides the glow spring */}
      <motion.div
        aria-hidden
        className="absolute inset-x-8 -top-10 h-24 blur-2xl"
        style={{
          opacity: glow,
          background: `radial-gradient(closest-side, hsl(${hue} ${sat}% 62% / 0.9), transparent)`,
        }}
      />

      {stage === "zones" ? (
        <motion.div
          aria-hidden
          className="absolute inset-x-4 bottom-4 flex gap-[3px]"
          style={{ opacity: bodyOpacity }}
        >
          {Array.from({ length: 15 }, (_, i) => (
            <div
              key={i}
              className="h-12 flex-1 rounded-[2px]"
              style={{ background: zoneBackground(hue, sat, i) }}
            />
          ))}
        </motion.div>
      ) : (
        <div aria-hidden className="absolute inset-0 grid place-items-center">
          {/* halo */}
          <motion.div
            className="absolute h-20 w-20 rounded-full blur-xl"
            style={{
              opacity: glow,
              background: `hsl(${hue} ${sat}% 62%)`,
            }}
          />
          {/* orb */}
          <motion.div
            className="relative h-11 w-11 rounded-full border border-hairline-strong"
            style={{
              opacity: bodyOpacity,
              background: `radial-gradient(circle at 35% 30%, hsl(${hue} ${sat}% 88%), hsl(${hue} ${sat}% 55%))`,
            }}
          />
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------
   Device plate — mini live preview, power, brightness scrub, readouts
   ------------------------------------------------------------------ */

function DevicePlate({ spec }: { spec: PlateSpec }) {
  const [power, setPower] = React.useState(spec.initialPower);
  const [brightness, setBrightness] = React.useState(spec.initialBrightness);

  return (
    <Panel className="p-4">
      <div className="flex items-center gap-2">
        <StatusDot tone={power ? "ok" : "off"} />
        <span className="text-[13px] font-medium leading-none text-hi">
          {spec.name}
        </span>
        <span className="ml-auto font-mono text-[10px] uppercase tracking-[0.08em] text-low">
          {spec.model}
        </span>
        <Switch
          checked={power}
          onCheckedChange={setPower}
          ariaLabel={`Power ${spec.name}`}
        />
      </div>

      <MiniStage spec={spec} power={power} brightness={brightness} />

      <div className="mt-3.5">
        <Slider
          value={brightness}
          onValueChange={setBrightness}
          ariaLabel={`${spec.name} brightness`}
        />
      </div>

      <div className="mt-2.5 flex items-center justify-between font-mono text-[11px] text-low">
        <Odometer
          value={brightness}
          pad={3}
          suffix="%"
          className="text-mid"
        />
        <span className="flex items-center gap-1.5">
          <span
            aria-hidden
            className="h-2.5 w-2.5 rounded-chip border border-hairline"
            style={{ background: spec.hex }}
          />
          {spec.hex.toUpperCase()}
        </span>
        {spec.tempK ? <span>{spec.tempK}K</span> : null}
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------------------
   Rail data
   ------------------------------------------------------------------ */

const NAV_ITEMS = [
  { key: "console", label: "Console", icon: Terminal, active: true },
  { key: "schedules", label: "Schedules", icon: CalendarClock, active: false },
  { key: "settings", label: "Settings", icon: Settings, active: false },
] as const;

const RAIL_DEVICES = [
  { name: "Light Bars", model: "H6056", online: true },
  { name: "Shelf Lamp", model: "H6022", online: true },
  { name: "Bulb", model: "H6008", online: false },
] as const;

function Rail() {
  return (
    <aside className="hidden w-[220px] shrink-0 flex-col border-r border-hairline bg-panel md:flex">
      <nav className="flex flex-col gap-0.5 p-3">
        {NAV_ITEMS.map((item) => (
          <button
            key={item.key}
            type="button"
            aria-current={item.active ? "page" : undefined}
            className={cn(
              "flex cursor-pointer items-center gap-2.5 rounded-btn px-2.5 py-2 text-[13px] transition-colors duration-150",
              item.active
                ? "bg-accent-dim text-hi"
                : "text-mid hover:bg-accent-dim hover:text-hi",
            )}
          >
            <item.icon size={15} strokeWidth={1.5} aria-hidden />
            {item.label}
          </button>
        ))}
      </nav>

      <div className="border-t border-hairline px-3 pt-4">
        <p className="px-2.5 pb-2 text-[11px] uppercase tracking-micro text-low">
          devices
        </p>
        <div className="flex flex-col gap-0.5">
          {RAIL_DEVICES.map((d) => (
            <button
              key={d.name}
              type="button"
              className="flex cursor-pointer items-center gap-2.5 rounded-btn px-2.5 py-1.5 text-[13px] text-mid transition-colors duration-150 hover:bg-accent-dim hover:text-hi"
            >
              <StatusDot tone={d.online ? "ok" : "off"} />
              <span className="truncate">{d.name}</span>
              <span className="ml-auto font-mono text-[10px] text-low">
                {d.model}
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="mt-auto border-t border-hairline p-3">
        <button
          type="button"
          className="flex w-full cursor-pointer items-center gap-2.5 rounded-btn px-2.5 py-2 text-[13px] text-mid transition-colors duration-150 hover:bg-accent-dim hover:text-hi"
        >
          living-room
          <span className="ml-auto font-mono text-[10px] text-low">2</span>
        </button>
      </div>
    </aside>
  );
}

/* ------------------------------------------------------------------
   Page
   ------------------------------------------------------------------ */

const SEGMENT_COUNT = 15;
const PAINTS = [
  "#FF5C5C",
  "#FFB347",
  "#FFE066",
  "#5CE09A",
  "#5CB8FF",
  "#B18CFF",
  "#F2F3F5",
];
const SCENES: Array<[string, string, string]> = [
  ["Aurora north", "param 12", "linear-gradient(90deg, #5CB8FF, #5CE09A)"],
  ["Ember drift", "param 31", "linear-gradient(90deg, #FFB347, #FF5C5C)"],
  ["Reading light", "param 04", "linear-gradient(90deg, #FFE066, #F2F3F5)"],
  ["Deep sea", "param 47", "linear-gradient(90deg, #16324F, #5CB8FF)"],
];
const MUSIC_MODES = ["vivid", "rhythm", "beat", "torch"] as const;

export default function ConsolePage() {
  const toast = useToast().toast;

  // control deck state
  const [power, setPower] = React.useState(true);
  const [gradient, setGradient] = React.useState(false);
  const [brightness, setBrightness] = React.useState(62);
  const [tempK, setTempK] = React.useState(3400);
  const [musicMode, setMusicMode] =
    React.useState<(typeof MUSIC_MODES)[number]>("rhythm");
  const [sensitivity, setSensitivity] = React.useState(60);

  // segments paint state
  const [paint, setPaint] = React.useState(PAINTS[4]);
  const [painted, setPainted] = React.useState<Record<number, string>>({
    2: "#5CB8FF",
    3: "#5CB8FF",
    4: "#5CE09A",
  });

  // overlays
  const [rebootOpen, setRebootOpen] = React.useState(false);
  const [sheetOpen, setSheetOpen] = React.useState(false);
  const [confirmGroups, setConfirmGroups] = React.useState(true);
  const [rateHints, setRateHints] = React.useState(true);

  // busy demo
  const [busy, setBusy] = React.useState(false);
  const runBusyDemo = () => {
    if (busy) return;
    setBusy(true);
    window.setTimeout(() => {
      setBusy(false);
      toast({
        variant: "ok",
        title: "Power on acknowledged",
        description: "Shelf Lamp · cloud-v2 · 142 ms",
      });
    }, 1200);
  };

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-bg">
      <TopBar />

      <div className="flex min-h-0 flex-1">
        <Rail />

        {/* ============================ console content */}
        <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          <motion.div
            variants={staggerParent}
            initial="hidden"
            animate="show"
            className="mx-auto max-w-[1080px] space-y-5 px-6 pb-16 pt-6"
          >
            {/* --------------------------- head */}
            <motion.section variants={panelIn} className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <h1 className="text-xl font-semibold leading-tight tracking-[-0.02em] text-hi">
                  Console
                </h1>
                <p className="mt-1 font-mono text-[11px] text-low">
                  3 devices · mock sidecar · all reachable
                </p>
              </div>
              <div className="flex items-center gap-2">
                <label className="relative hidden sm:block">
                  <Search
                    size={13}
                    strokeWidth={1.5}
                    aria-hidden
                    className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-low"
                  />
                  <input
                    type="text"
                    placeholder="search devices, scenes… ⌘K"
                    className="h-9 w-56 rounded-btn border border-hairline bg-raised pl-8 pr-3 text-[13px] text-hi transition-colors duration-150 placeholder:text-low focus-visible:border-hairline-strong focus-visible:outline-none"
                  />
                </label>
                <IconButton label="Refresh state" tooltip="Refresh state">
                  <RefreshCw size={15} strokeWidth={1.5} />
                </IconButton>
                <Button variant="solid">
                  <Plus size={14} strokeWidth={1.75} aria-hidden />
                  add device
                </Button>
              </div>
            </motion.section>

            {/* --------------------------- device plates */}
            <motion.section variants={panelIn}>
              <SectionLabel title="devices" />
              <div className="mt-3 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {PLATES.map((spec) => (
                  <DevicePlate key={spec.id} spec={spec} />
                ))}
              </div>
            </motion.section>

            {/* --------------------------- control deck */}
            <motion.section variants={panelIn}>
              <Panel className="p-5">
                <SectionLabel title="control deck — shelf lamp" />
                <Tabs defaultValue="light" className="mt-4">
                  <TabsList>
                    <TabsTrigger value="light">Light</TabsTrigger>
                    <TabsTrigger value="segments">Segments</TabsTrigger>
                    <TabsTrigger value="scenes">Scenes</TabsTrigger>
                    <TabsTrigger value="music">Music</TabsTrigger>
                  </TabsList>

                  <div className="min-h-[196px] pt-5">
                    <TabsContent value="light">
                      <div className="grid items-center gap-8 sm:grid-cols-[auto_minmax(0,1fr)]">
                        <div className="flex flex-col items-center gap-3">
                          <Dial
                            value={brightness}
                            min={0}
                            max={100}
                            step={1}
                            onValueChange={setBrightness}
                            label="Brightness"
                            unit="%"
                            size={148}
                          />
                          <Odometer
                            value={brightness}
                            pad={3}
                            suffix="%"
                            className="text-lg text-hi"
                          />
                        </div>

                        <div className="space-y-6">
                          <div>
                            <div className="mb-2 flex items-baseline justify-between">
                              <span className="text-[11px] uppercase tracking-micro text-mid">
                                brightness
                              </span>
                              <span className="font-mono text-[11px] text-low">
                                {brightness}%
                              </span>
                            </div>
                            <Slider
                              value={brightness}
                              onValueChange={setBrightness}
                              ariaLabel="Deck brightness"
                              showBubble
                            />
                          </div>

                          <div>
                            <div className="mb-2 flex items-baseline justify-between">
                              <span className="text-[11px] uppercase tracking-micro text-mid">
                                temperature
                              </span>
                              <span className="font-mono text-[11px] text-low">
                                {tempK}K
                              </span>
                            </div>
                            <Slider
                              value={tempK}
                              min={2700}
                              max={6500}
                              step={50}
                              onValueChange={setTempK}
                              ariaLabel="Deck color temperature"
                              showBubble
                            />
                            <div className="mt-1 flex justify-between font-mono text-[9px] text-low">
                              <span>2700K</span>
                              <span>6500K</span>
                            </div>
                          </div>

                          <div className="h-px bg-hairline" />

                          <div className="flex flex-wrap items-center gap-x-8 gap-y-4">
                            <label className="flex cursor-pointer items-center gap-3">
                              <Switch
                                checked={power}
                                onCheckedChange={setPower}
                                ariaLabel="Deck power"
                              />
                              <span className="text-[11px] uppercase tracking-micro text-mid">
                                power
                              </span>
                            </label>
                            <label className="flex cursor-pointer items-center gap-3">
                              <Switch
                                checked={gradient}
                                onCheckedChange={setGradient}
                                ariaLabel="Gradient toggle"
                              />
                              <span className="text-[11px] uppercase tracking-micro text-mid">
                                gradient
                              </span>
                            </label>
                            <span className="ml-auto hidden sm:block">
                              <Odometer
                                value={tempK}
                                pad={4}
                                suffix="K"
                                className="text-sm text-mid"
                              />
                            </span>
                          </div>
                        </div>
                      </div>
                    </TabsContent>

                    <TabsContent value="segments">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="mr-1 text-[11px] uppercase tracking-micro text-mid">
                          paint
                        </span>
                        {PAINTS.map((hexColor) => (
                          <button
                            key={hexColor}
                            type="button"
                            aria-label={`Paint ${hexColor}`}
                            aria-pressed={paint === hexColor}
                            onClick={() => setPaint(hexColor)}
                            className={cn(
                              "h-6 w-6 cursor-pointer rounded-chip border transition-all duration-150",
                              paint === hexColor
                                ? "scale-110 border-accent"
                                : "border-hairline hover:border-hairline-strong",
                            )}
                            style={{ background: hexColor }}
                          />
                        ))}
                        <Button
                          size="sm"
                          className="ml-auto"
                          onClick={() => setPainted({})}
                        >
                          clear
                        </Button>
                      </div>

                      <div className="mt-5 flex gap-1">
                        {Array.from({ length: SEGMENT_COUNT }, (_, i) => (
                          <button
                            key={i}
                            type="button"
                            aria-label={`Segment ${i}`}
                            onClick={() =>
                              setPainted((prev) => {
                                const next = { ...prev };
                                if (next[i] === paint) delete next[i];
                                else next[i] = paint;
                                return next;
                              })
                            }
                            className={cn(
                              "h-10 flex-1 cursor-pointer rounded-chip border transition-colors duration-150",
                              painted[i]
                                ? "border-transparent"
                                : "border-hairline bg-raised hover:border-hairline-strong",
                            )}
                            style={
                              painted[i]
                                ? { background: painted[i] }
                                : undefined
                            }
                          />
                        ))}
                      </div>
                      <p className="mt-2.5 font-mono text-[10px] text-low">
                        select a paint, then click cells · 0–14 addressable
                      </p>
                    </TabsContent>

                    <TabsContent value="scenes">
                      <ul className="divide-y divide-hairline">
                        {SCENES.map(([name, param, thumb]) => (
                          <li
                            key={name}
                            className="flex items-center justify-between gap-4 py-2.5"
                          >
                            <span className="flex items-center gap-3">
                              <span
                                aria-hidden
                                className="h-5 w-9 shrink-0 rounded-chip border border-hairline"
                                style={{ background: thumb }}
                              />
                              <span className="text-[13px] text-hi">
                                {name}
                              </span>
                              <span className="font-mono text-[10px] text-low">
                                {param}
                              </span>
                            </span>
                            <Button
                              size="sm"
                              onClick={() =>
                                toast({
                                  variant: "info",
                                  title: `Scene applied — ${name}`,
                                  description:
                                    "Device reports empty for scenes; confirm visually.",
                                })
                              }
                            >
                              apply
                            </Button>
                          </li>
                        ))}
                      </ul>
                    </TabsContent>

                    <TabsContent value="music">
                      <div className="flex flex-wrap gap-2">
                        {MUSIC_MODES.map((mode) => (
                          <button
                            key={mode}
                            type="button"
                            onClick={() => setMusicMode(mode)}
                            className={cn(
                              "cursor-pointer rounded-chip border px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.08em] transition-colors duration-150",
                              musicMode === mode
                                ? "border-hairline-strong bg-accent-dim text-hi"
                                : "border-hairline text-mid hover:border-hairline-strong hover:text-hi",
                            )}
                          >
                            {mode}
                          </button>
                        ))}
                      </div>
                      <div className="mt-5">
                        <div className="mb-2 flex items-baseline justify-between">
                          <span className="text-[11px] uppercase tracking-micro text-mid">
                            sensitivity
                          </span>
                          <span className="font-mono text-[11px] text-low">
                            {sensitivity}
                          </span>
                        </div>
                        <Slider
                          value={sensitivity}
                          onValueChange={setSensitivity}
                          min={0}
                          max={100}
                          ariaLabel="Music sensitivity"
                        />
                      </div>
                    </TabsContent>
                  </div>
                </Tabs>
              </Panel>
            </motion.section>

            {/* --------------------------- controls specimen */}
            <motion.section variants={panelIn}>
              <Panel className="p-5">
                <SectionLabel title="controls" />

                {/* buttons */}
                <div className="mt-4 space-y-2.5">
                  {(
                    [
                      ["solid", "solid"],
                      ["ghost", "ghost"],
                      ["danger", "danger"],
                    ] as const
                  ).map(([variant, name]) => (
                    <div
                      key={variant}
                      className="grid grid-cols-[52px_repeat(3,minmax(0,1fr))_auto] items-center gap-3"
                    >
                      <span className="font-mono text-[10px] text-low">
                        {name}
                      </span>
                      <Button variant={variant} size="sm">
                        engage
                      </Button>
                      <Button variant={variant} size="md">
                        engage
                      </Button>
                      <Button variant={variant} size="lg">
                        engage
                      </Button>
                      <Button variant={variant} disabled>
                        hold
                      </Button>
                    </div>
                  ))}
                </div>

                <div className="my-5 h-px bg-hairline" />

                {/* chips + status legend */}
                <div className="flex flex-wrap items-center gap-2">
                  <Chip>H6022</Chip>
                  <Chip tone="accent">cloud-v2</Chip>
                  <Chip tone="ok">online</Chip>
                  <Chip tone="warn">rate-limit near</Chip>
                  <span aria-hidden className="mx-1 h-4 w-px bg-hairline" />
                  <span className="flex items-center gap-1.5 font-mono text-[10px] text-low">
                    <StatusDot tone="ok" /> ok
                  </span>
                  <span className="flex items-center gap-1.5 font-mono text-[10px] text-low">
                    <StatusDot tone="warn" /> warn
                  </span>
                  <span className="flex items-center gap-1.5 font-mono text-[10px] text-low">
                    <StatusDot tone="off" /> off
                  </span>
                </div>

                <div className="my-5 h-px bg-hairline" />

                {/* mutation + overlay triggers */}
                <div className="flex flex-wrap items-center gap-2.5">
                  <Button variant="solid" busy={busy} onClick={runBusyDemo}>
                    {busy ? "sending" : "run mutation"}
                  </Button>
                  <Button
                    onClick={() =>
                      toast({
                        variant: "ok",
                        title: "Power on acknowledged",
                        description: "Shelf Lamp · cloud-v2 · 142 ms",
                      })
                    }
                  >
                    toast · ok
                  </Button>
                  <Button
                    onClick={() =>
                      toast({
                        variant: "error",
                        title: "dreamViewToggle rejected",
                        description: "400 — The device does not has DreamView",
                      })
                    }
                  >
                    toast · error
                  </Button>
                  <Button
                    onClick={() =>
                      toast({
                        variant: "info",
                        title: "Scene library cached",
                        description: "69 scenes · expires in 7 days",
                      })
                    }
                  >
                    toast · info
                  </Button>
                  <Button
                    variant="danger"
                    onClick={() => setRebootOpen(true)}
                  >
                    open dialog
                  </Button>
                  <Button onClick={() => setSheetOpen(true)}>
                    open sheet
                  </Button>
                  <Popover>
                    <PopoverTrigger asChild>
                      <IconButton label="About this build" tooltip="Build info">
                        <Info size={15} strokeWidth={1.5} />
                      </IconButton>
                    </PopoverTrigger>
                    <PopoverContent>
                      <p className="text-[11px] uppercase tracking-micro text-mid">
                        build
                      </p>
                      <dl className="mt-2 space-y-1 font-mono text-[11px]">
                        <div className="flex justify-between gap-6">
                          <dt className="text-low">filament</dt>
                          <dd className="text-mid">0.1.0</dd>
                        </div>
                        <div className="flex justify-between gap-6">
                          <dt className="text-low">tokens</dt>
                          <dd className="text-mid">optical v2</dd>
                        </div>
                        <div className="flex justify-between gap-6">
                          <dt className="text-low">sidecar</dt>
                          <dd className="text-mid">mock</dd>
                        </div>
                      </dl>
                    </PopoverContent>
                  </Popover>
                </div>
              </Panel>
            </motion.section>
          </motion.div>
        </main>
      </div>

      {/* ================================ overlays */}
      <Dialog open={rebootOpen} onOpenChange={setRebootOpen}>
        <DialogContent position="center">
          <DialogTitle>Reboot device</DialogTitle>
          <DialogDescription>
            Power-cycles Shelf Lamp over cloud-v2. The lamp drops off the
            network for roughly eight seconds.
          </DialogDescription>
          <div className="mt-6 flex justify-end gap-2.5">
            <DialogClose asChild>
              <Button>cancel</Button>
            </DialogClose>
            <DialogClose asChild>
              <Button
                variant="danger"
                onClick={() =>
                  toast({
                    variant: "ok",
                    title: "Reboot queued",
                    description: "Shelf Lamp restarts in a moment.",
                  })
                }
              >
                reboot
              </Button>
            </DialogClose>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={sheetOpen} onOpenChange={setSheetOpen}>
        <DialogContent position="right">
          <DialogTitle>Console settings</DialogTitle>
          <DialogDescription>
            Preferences live in the sidecar config and apply immediately.
          </DialogDescription>
          <div className="mt-6 space-y-5">
            <label className="flex items-center justify-between gap-4">
              <span className="text-[13px] text-hi">
                Confirm before group actions
              </span>
              <Switch
                checked={confirmGroups}
                onCheckedChange={setConfirmGroups}
                ariaLabel="Confirm before group actions"
              />
            </label>
            <label className="flex items-center justify-between gap-4">
              <span className="text-[13px] text-hi">
                Show rate-limit hints
              </span>
              <Switch
                checked={rateHints}
                onCheckedChange={setRateHints}
                ariaLabel="Show rate-limit hints"
              />
            </label>
          </div>
          <div className="mt-8 flex justify-end">
            <DialogClose asChild>
              <Button variant="solid">done</Button>
            </DialogClose>
          </div>
        </DialogContent>
      </Dialog>

      <StatusStrip />
    </div>
  );
}
