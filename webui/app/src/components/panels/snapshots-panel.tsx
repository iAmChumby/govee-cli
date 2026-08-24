"use client";

/**
 * SnapshotsPanel — saved device states (WEBUI_SPEC §4 GET/PUT snapshots).
 *
 * Govee exposes no snapshot listing endpoint beyond what the sidecar can
 * see, so the panel applies by name from the list AND accepts an arbitrary
 * numeric id — a slot saved in the app is appliable here even when the
 * list never heard of it.
 */

import * as React from "react";

import { api, type Snapshot } from "@/lib/api";
import { useApplyMutation, useSnapshots } from "@/lib/queries";
import { Button } from "@/components/ui/button";
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
  queryErrorMessage,
} from "./shared";

export function SnapshotsPanel({ deviceRef }: { deviceRef: string }) {
  const snapshots = useSnapshots(deviceRef);
  const [pendingName, setPendingName] = React.useState<string | null>(null);
  const [activeName, setActiveName] = React.useState<string | null>(null);

  // arbitrary numeric id entry
  const [draft, setDraft] = React.useState("");
  const [idPending, setIdPending] = React.useState(false);
  const trimmed = draft.trim();
  const idValid = /^\d+$/.test(trimmed);
  const idInvalid = trimmed !== "" && !idValid;

  const applySnapshot = useApplyMutation<string>(
    "snapshot",
    ({ ref, vars }) => api.applySnapshot(ref, vars),
    (nameOrId) => nameOrId,
  );

  const applyByName = (name: string) => {
    setPendingName(name);
    setActiveName(name); // optimistic highlight
    applySnapshot({ ref: deviceRef, vars: name })
      .catch(() => setActiveName((cur) => (cur === name ? null : cur)))
      .finally(() => setPendingName((cur) => (cur === name ? null : cur)));
  };

  const submitId = (e: React.FormEvent) => {
    e.preventDefault();
    if (!idValid) return;
    setIdPending(true);
    applySnapshot({ ref: deviceRef, vars: trimmed })
      .then(() => setDraft(""))
      .catch(() => {
        /* error toast already surfaced by the mutation hook */
      })
      .finally(() => setIdPending(false));
  };

  const all = snapshots.data ?? [];

  return (
    <PanelFrame
      label="snapshots"
      chips={
        snapshots.data && !snapshots.isError ? (
          <CountChip count={all.length} singular="slot" />
        ) : null
      }
    >
      {snapshots.isError ? (
        <QueryErrorLine
          message={queryErrorMessage(snapshots.error)}
          onRetry={() => void snapshots.refetch()}
        />
      ) : null}

      {snapshots.isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }, (_, i) => <RowSkeleton key={i} edge />)}
        </div>
      ) : null}

      {!snapshots.isLoading && !snapshots.isError && all.length === 0 ? (
        <EmptyState
          title="no snapshots listed"
          hint="save one in the Govee app first — or apply a known numeric id directly below."
        />
      ) : null}

      {snapshots.data && !snapshots.isError && all.length > 0 ? (
        <StaggerList ariaLabel="Snapshots" className="space-y-2">
          {all.map((s) => (
            <StaggerItem key={s.name}>
              <SnapshotRow
                snapshot={s}
                active={activeName === s.name}
                pending={pendingName === s.name}
                onApply={applyByName}
              />
            </StaggerItem>
          ))}
        </StaggerList>
      ) : null}

      {/* arbitrary numeric id entry */}
      <form
        onSubmit={submitId}
        className="mt-4 flex flex-wrap items-center gap-2.5 border-t border-hairline pt-4"
      >
        <span className="text-[11px] uppercase leading-none tracking-micro text-mid">
          apply by id
        </span>
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="e.g. 3"
          aria-label="Snapshot id"
          aria-invalid={idInvalid || undefined}
          inputMode="numeric"
          autoComplete="off"
          spellCheck={false}
          maxLength={6}
          className={cn(
            "h-7 w-24 rounded-btn border bg-raised px-2 font-mono text-[11px] tabular-nums text-hi transition-colors duration-150 placeholder:text-low focus-visible:border-hairline-strong focus-visible:outline-none",
            idInvalid ? "border-ember" : "border-hairline",
          )}
        />
        <Button
          type="submit"
          variant="solid"
          size="sm"
          busy={idPending}
          disabled={!idValid}
        >
          apply
        </Button>
        {idInvalid ? (
          <span className="font-mono text-[10px] text-ember">numeric ids only</span>
        ) : null}
      </form>

      <p className="mt-2.5 font-mono text-[10px] leading-relaxed text-low">
        govee has no snapshot listing endpoint — slots saved in the app are
        appliable by id even when unlisted.
      </p>
    </PanelFrame>
  );
}

/* --------------------------------------------------------- snapshot row */

interface SnapshotRowProps {
  snapshot: Snapshot;
  active: boolean;
  pending: boolean;
  onApply: (name: string) => void;
}

function SnapshotRow({ snapshot, active, pending, onApply }: SnapshotRowProps) {
  return (
    <button
      type="button"
      onClick={() => onApply(snapshot.name)}
      aria-pressed={active}
      aria-label={`Apply snapshot ${snapshot.name}`}
      className={cn(
        "group flex w-full cursor-pointer items-center gap-3 rounded-card border bg-raised px-3 py-2.5 text-left transition-colors duration-150 hover:border-hairline-strong",
        active ? "border-hairline-strong ring-1 ring-accent" : "border-hairline",
      )}
    >
      {/* neutral edge — snapshots are captured state, not authored color */}
      <span aria-hidden className="h-8 w-[3px] shrink-0 rounded-full bg-hairline-strong" />

      <span className="min-w-0 flex-1 truncate text-[12px] leading-tight text-hi">
        {snapshot.name}
      </span>

      <span className="font-mono text-[10px] tabular-nums text-low">
        #{snapshot.value}
      </span>

      {pending ? (
        <Spinner />
      ) : active ? (
        <span className="font-mono text-[9px] uppercase leading-none tracking-[0.08em] text-accent">
          applied
        </span>
      ) : null}
    </button>
  );
}
