"use client";

/**
 * DiyPanel — DIY scenes (WEBUI_SPEC §4 GET/PUT diy).
 *
 * Same card family as the scene library but visually distinct: a left
 * gradient edge strip derived from the name instead of a full thumb.
 * DIY styles are authored on the phone; the panel only applies them.
 */

import * as React from "react";

import { api, type DiyScene } from "@/lib/api";
import { useApplyMutation, useDiyScenes } from "@/lib/queries";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/cn";
import {
  CountChip,
  EmptyState,
  PanelFrame,
  QueryErrorLine,
  RowSkeleton,
  StaggerItem,
  StaggerList,
  nameToGradient,
  queryErrorMessage,
} from "./shared";

export function DiyPanel({ deviceRef }: { deviceRef: string }) {
  const diy = useDiyScenes(deviceRef);
  const [pendingName, setPendingName] = React.useState<string | null>(null);
  const [activeName, setActiveName] = React.useState<string | null>(null);

  const applyDiy = useApplyMutation<string>(
    "diy",
    ({ ref, vars }) => api.applyDiy(ref, vars),
    (name) => name,
  );

  const apply = (name: string) => {
    setPendingName(name);
    setActiveName(name); // optimistic highlight
    applyDiy({ ref: deviceRef, vars: name })
      .catch(() => setActiveName((cur) => (cur === name ? null : cur)))
      .finally(() => setPendingName((cur) => (cur === name ? null : cur)));
  };

  const all = diy.data ?? [];

  return (
    <PanelFrame
      label="diy scenes"
      chips={diy.data && !diy.isError ? <CountChip count={all.length} singular="style" /> : null}
    >
      {diy.isError ? (
        <QueryErrorLine
          message={queryErrorMessage(diy.error)}
          onRetry={() => void diy.refetch()}
        />
      ) : null}

      {diy.isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }, (_, i) => <RowSkeleton key={i} edge />)}
        </div>
      ) : null}

      {!diy.isLoading && !diy.isError && all.length === 0 ? (
        <EmptyState
          title="no DIY styles on this device"
          hint="DIY styles are authored in the Govee app — save one there and it appears in this list."
        />
      ) : null}

      {diy.data && !diy.isError && all.length > 0 ? (
        <StaggerList ariaLabel="DIY scenes" className="space-y-2">
          {all.map((s) => (
            <StaggerItem key={s.name}>
              <DiyRow
                scene={s}
                active={activeName === s.name}
                pending={pendingName === s.name}
                onApply={apply}
              />
            </StaggerItem>
          ))}
        </StaggerList>
      ) : null}
    </PanelFrame>
  );
}

/* --------------------------------------------------------------- diy row */

interface DiyRowProps {
  scene: DiyScene;
  active: boolean;
  pending: boolean;
  onApply: (name: string) => void;
}

function DiyRow({ scene, active, pending, onApply }: DiyRowProps) {
  const gradient = React.useMemo(() => nameToGradient(scene.name), [scene.name]);

  return (
    <button
      type="button"
      onClick={() => onApply(scene.name)}
      aria-pressed={active}
      aria-label={`Apply DIY style ${scene.name}`}
      className={cn(
        "group flex w-full cursor-pointer items-center gap-3 rounded-card border bg-raised px-3 py-2.5 text-left transition-colors duration-150 hover:border-hairline-strong",
        active ? "border-hairline-strong ring-1 ring-accent" : "border-hairline",
      )}
    >
      {/* left accent edge — content gradient, distinct from full thumbs */}
      <span
        aria-hidden
        className="h-8 w-[3px] shrink-0 rounded-full"
        style={{ background: gradient }}
      />

      <span className="min-w-0 flex-1 truncate text-[12px] leading-tight text-hi">
        {scene.name}
      </span>

      <span className="font-mono text-[10px] text-low">
        #{scene.value}
      </span>

      {pending ? (
        <Spinner />
      ) : active ? (
        <span className="font-mono text-[9px] uppercase leading-none tracking-[0.08em] text-accent">
          playing
        </span>
      ) : null}
    </button>
  );
}
