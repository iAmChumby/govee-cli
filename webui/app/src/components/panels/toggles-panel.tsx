"use client";

/**
 * TogglesPanel — gradientToggle & friends (WEBUI_SPEC §4 GET/PUT toggles).
 *
 * Each row states its verification status honestly: "verified" means the
 * sidecar has seen the hardware accept it; "advertised · unverified" means
 * only the capability list mentions it. A device rejecting an unverified
 * toggle (dreamViewToggle behavior) surfaces verbatim as an error toast —
 * that is correct behavior, never suppressed.
 *
 * The device reports "" for toggle instances, so switch positions are
 * session-local truth and say so.
 */

import * as React from "react";

import { api, type ToggleInfo } from "@/lib/api";
import { useApplyMutation, useToggles } from "@/lib/queries";
import { Chip } from "@/components/ui/chip";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
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

interface ToggleVars {
  instance: string;
  on: boolean;
}

export function TogglesPanel({ deviceRef }: { deviceRef: string }) {
  const toggles = useToggles(deviceRef);
  // Session-local positions; the device never reports toggle state back.
  const [local, setLocal] = React.useState<Record<string, boolean>>({});
  const [pending, setPending] = React.useState<string | null>(null);

  const applyToggle = useApplyMutation<ToggleVars>(
    "toggle",
    ({ ref, vars }) => api.applyToggle(ref, vars.instance, vars.on),
    (v) => `${v.instance} → ${v.on ? "on" : "off"}`,
  );

  const flip = (instance: string, next: boolean) => {
    const prev = local[instance] ?? false;
    setLocal((m) => ({ ...m, [instance]: next }));
    setPending(instance);
    applyToggle({ ref: deviceRef, vars: { instance, on: next } })
      .catch(() => setLocal((m) => ({ ...m, [instance]: prev })))
      .finally(() => setPending((cur) => (cur === instance ? null : cur)));
  };

  const all = toggles.data ?? [];

  return (
    <PanelFrame
      label="toggles"
      chips={
        toggles.data && !toggles.isError ? (
          <CountChip count={all.length} singular="toggle" />
        ) : null
      }
    >
      {toggles.isError ? (
        <QueryErrorLine
          message={queryErrorMessage(toggles.error)}
          onRetry={() => void toggles.refetch()}
        />
      ) : null}

      {toggles.isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 2 }, (_, i) => <RowSkeleton key={i} />)}
        </div>
      ) : null}

      {!toggles.isLoading && !toggles.isError && all.length === 0 ? (
        <EmptyState
          title="no toggles advertised"
          hint="this model exposes no toggle instances on the cloud API."
        />
      ) : null}

      {toggles.data && !toggles.isError && all.length > 0 ? (
        <>
          <StaggerList ariaLabel="Device toggles" className="space-y-2">
            {all.map((t) => (
              <StaggerItem key={t.instance}>
                <ToggleRow
                  toggle={t}
                  checked={local[t.instance] ?? false}
                  pending={pending === t.instance}
                  onFlip={flip}
                />
              </StaggerItem>
            ))}
          </StaggerList>

          <p className="mt-3 border-t border-hairline pt-3 font-mono text-[10px] leading-relaxed text-low">
            the device reports no toggle state — positions reflect this session
            only. a rejected toggle surfaces verbatim as an error toast.
          </p>
        </>
      ) : null}
    </PanelFrame>
  );
}

/* ------------------------------------------------------------ toggle row */

interface ToggleRowProps {
  toggle: ToggleInfo;
  checked: boolean;
  pending: boolean;
  onFlip: (instance: string, on: boolean) => void;
}

function ToggleRow({ toggle, checked, pending, onFlip }: ToggleRowProps) {
  return (
    <div className="flex items-center gap-3 rounded-card border border-hairline bg-raised px-3 py-2.5">
      <span className="min-w-0 flex-1 truncate font-mono text-[12px] leading-tight text-hi">
        {toggle.instance}
      </span>

      {toggle.verified ? (
        <Chip tone="ok">verified</Chip>
      ) : (
        <Chip>advertised · unverified</Chip>
      )}

      {pending ? <Spinner /> : null}

      <Switch
        checked={checked}
        onCheckedChange={(on) => onFlip(toggle.instance, on)}
        disabled={pending}
        ariaLabel={`${toggle.instance} toggle`}
      />
    </div>
  );
}
