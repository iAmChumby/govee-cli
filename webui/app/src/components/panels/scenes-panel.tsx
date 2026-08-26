"use client";

/**
 * ScenesPanel — the firmware scene library (WEBUI_SPEC §4 GET/PUT scenes).
 *
 * Searchable card grid; each thumb is a gradient from `nameToGradient`,
 * which routes through the same curated appearance table and resolver the
 * 3D stage uses (never an independent hash — that is how the library and
 * the stage used to show two different colours for one scene). A name the
 * table has no signal for thumbs neutral grey, on purpose. Applying is
 * optimistic: the clicked
 * card highlights immediately and settles when the mutation resolves — the
 * device reports "" for the active scene, so local truth is all we have.
 */

import * as React from "react";
import { AnimatePresence, motion } from "motion/react";
import { Search } from "lucide-react";

import { api, type FirmwareScene } from "@/lib/api";
import { useApplyMutation, useScenes } from "@/lib/queries";
import { Chip } from "@/components/ui/chip";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/cn";
import { fadeFast, springStandard } from "@/lib/motion";
import {
  CountChip,
  EmptyState,
  PanelFrame,
  QueryErrorLine,
  ThumbCardSkeleton,
  nameToGradient,
  queryErrorMessage,
} from "./shared";

export function ScenesPanel({ deviceRef }: { deviceRef: string }) {
  const scenes = useScenes(deviceRef);
  const [query, setQuery] = React.useState("");
  const [pendingName, setPendingName] = React.useState<string | null>(null);
  const [activeName, setActiveName] = React.useState<string | null>(null);

  const applyScene = useApplyMutation<string>(
    "scene",
    ({ ref, vars }) => api.applyScene(ref, vars),
    (name) => name,
  );

  const apply = (name: string) => {
    setPendingName(name);
    setActiveName(name); // optimistic "playing" highlight
    applyScene({ ref: deviceRef, vars: name })
      .catch(() => setActiveName((cur) => (cur === name ? null : cur)))
      .finally(() => setPendingName((cur) => (cur === name ? null : cur)));
  };

  const all = scenes.data?.scenes ?? [];
  const sidecarCached = scenes.data?.cached ?? false;
  const q = query.trim().toLowerCase();
  const filtered = q
    ? all.filter((s) => s.name.toLowerCase().includes(q))
    : all;

  return (
    <PanelFrame
      label="scene library"
      chips={
        scenes.data && !scenes.isError ? (
          <>
            <CountChip count={all.length} singular="scene" />
            <Chip
              tone="accent"
              title={
                sidecarCached
                  ? "Served from the sidecar's 7-day disk cache"
                  : "Fetched live from the Govee cloud"
              }
            >
              {sidecarCached ? "disk cache" : "live"}
            </Chip>
          </>
        ) : null
      }
    >
      {/* search */}
      <label className="relative block">
        <Search
          size={13}
          strokeWidth={1.5}
          aria-hidden
          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-low"
        />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="filter scenes…"
          aria-label="Filter scenes"
          spellCheck={false}
          autoComplete="off"
          className="h-9 w-full rounded-btn border border-hairline bg-raised pl-8 pr-3 text-[12px] text-hi transition-colors duration-150 placeholder:text-low focus-visible:border-hairline-strong focus-visible:outline-none"
        />
      </label>

      {/* query error */}
      {scenes.isError ? (
        <div className="mt-3">
          <QueryErrorLine
            message={queryErrorMessage(scenes.error)}
            onRetry={() => void scenes.refetch()}
          />
        </div>
      ) : null}

      {/* loading — skeleton grid matches the final card shape */}
      {scenes.isLoading ? (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {Array.from({ length: 6 }, (_, i) => <ThumbCardSkeleton key={i} />)}
        </div>
      ) : null}

      {/* empty library */}
      {!scenes.isLoading && !scenes.isError && all.length === 0 ? (
        <div className="mt-3">
          <EmptyState
            title="no scenes reported"
            hint="the firmware library loads from the cloud — the device may be offline or still registering."
          />
        </div>
      ) : null}

      {/* grid */}
      {scenes.data && !scenes.isError && all.length > 0 ? (
        filtered.length === 0 ? (
          <p className="mt-3 font-mono text-[11px] text-low">
            no scenes match &ldquo;{query}&rdquo;
          </p>
        ) : (
          <ul className="mt-3 grid gap-2 sm:grid-cols-2" aria-label="Scenes">
            <AnimatePresence mode="popLayout" initial={false}>
              {filtered.map((s) => (
                <motion.li
                  key={s.name}
                  layout
                  initial={{ opacity: 0, scale: 0.98 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.97, transition: fadeFast }}
                  transition={springStandard}
                >
                  <SceneCard
                    scene={s}
                    active={activeName === s.name}
                    pending={pendingName === s.name}
                    onApply={apply}
                  />
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
        )
      ) : null}
    </PanelFrame>
  );
}

/* ------------------------------------------------------------- scene card */

interface SceneCardProps {
  scene: FirmwareScene;
  active: boolean;
  pending: boolean;
  onApply: (name: string) => void;
}

function SceneCard({ scene, active, pending, onApply }: SceneCardProps) {
  const gradient = React.useMemo(() => nameToGradient(scene.name), [scene.name]);

  return (
    <button
      type="button"
      onClick={() => onApply(scene.name)}
      aria-pressed={active}
      aria-label={`Apply scene ${scene.name}`}
      className={cn(
        "group flex w-full cursor-pointer items-center gap-3 rounded-card border bg-raised p-2.5 text-left transition-colors duration-150 hover:border-hairline-strong",
        active ? "border-hairline-strong ring-1 ring-accent" : "border-hairline",
      )}
    >
      {/* deterministic content gradient thumb */}
      <span
        aria-hidden
        className="relative h-10 w-10 shrink-0 overflow-hidden rounded-chip border border-hairline"
        style={{ background: gradient }}
      >
        {pending ? (
          <span className="absolute inset-0 grid place-items-center bg-black/35">
            <Spinner />
          </span>
        ) : null}
      </span>

      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12px] leading-tight text-hi">
          {scene.name}
        </span>
        <span className="mt-1 flex items-center gap-1.5 font-mono text-[9px] uppercase leading-none tracking-[0.08em] text-low">
          id {String(scene.scene_id).padStart(2, "0")}
          {active ? <span className="normal-case tracking-normal text-accent">· playing</span> : null}
        </span>
      </span>
    </button>
  );
}
