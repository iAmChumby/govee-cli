"use client";

import * as React from "react";
import { AlertTriangle, CheckCircle2 } from "lucide-react";

import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui";
import { ApiError, type RoomSceneCaptureResult } from "@/lib/api";
import { useCaptureRoom, useDeleteRoom, useDevices } from "@/lib/queries";

/* ==================================================================
   CaptureRoomDialog — WEBUI_V3_SPEC.md §10 T28.

   `POST /rooms` both captures AND persists in one call (T22) — there is
   no preview route. So "show the unknown list before the user commits to
   the name" is built as two phases inside this one dialog rather than as
   a separate network round trip: phase 1 names the scene and fires the
   capture; phase 2 holds the dialog open on the result — unknown list
   front and centre — and only closing it (via "keep") is the commit. If
   the capture came back with devices unknown, "discard" is right there
   next to it, wired to the same DELETE the scene list uses, so a capture
   that turned out to be close to worthless never has to be lived with.
   ================================================================== */

const INPUT_CLASS =
  "h-9 w-full rounded-btn border border-hairline bg-raised px-3 text-[13px] text-hi transition-colors duration-150 placeholder:text-low focus-visible:border-hairline-strong focus-visible:outline-none";

function errMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : String(err);
}

export function CaptureRoomDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const devices = useDevices();
  const captureRoom = useCaptureRoom();
  const deleteRoom = useDeleteRoom();

  const [name, setName] = React.useState("");
  const [result, setResult] = React.useState<RoomSceneCaptureResult | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const [discarding, setDiscarding] = React.useState(false);
  const [error, setError] = React.useState<string | undefined>();

  const reset = React.useCallback(() => {
    setName("");
    setResult(null);
    setError(undefined);
  }, []);

  async function handleCapture(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError("give the scene a name");
      return;
    }
    setSubmitting(true);
    setError(undefined);
    try {
      const captured = await captureRoom(trimmed);
      setResult(captured);
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDiscard() {
    if (!result) return;
    setDiscarding(true);
    try {
      await deleteRoom(result.name);
    } catch {
      // useDeleteRoom's own onError already toasted; the dialog still
      // closes below — nothing more useful to do with a failed discard
      // than let the user retry from the rooms list.
    } finally {
      setDiscarding(false);
      reset();
      onOpenChange(false);
    }
  }

  function handleKeep() {
    reset();
    onOpenChange(false);
  }

  const nameOf = (ref: string) =>
    devices.data?.find((d) => d.ref === ref || d.id === ref)?.name ?? ref;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent>
        {!result ? (
          <>
            <DialogTitle>capture room scene</DialogTitle>
            <DialogDescription>
              records every registered device&rsquo;s current power, brightness, colour and
              mode under one name — restoring it later replays each device back to exactly
              this.
            </DialogDescription>

            <form onSubmit={handleCapture} noValidate className="mt-5 space-y-4">
              <label className="block">
                <span className="mb-1.5 block text-[11px] uppercase leading-none tracking-micro text-mid">
                  name
                </span>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    setError(undefined);
                  }}
                  placeholder="movie night"
                  autoComplete="off"
                  className={INPUT_CLASS}
                />
                {error ? (
                  <span
                    role="alert"
                    className="mt-1.5 block font-mono text-[11px] leading-snug text-ember"
                  >
                    {error}
                  </span>
                ) : null}
              </label>

              <div className="flex items-center justify-end gap-2 pt-1">
                <DialogClose asChild>
                  <Button variant="ghost">cancel</Button>
                </DialogClose>
                <Button type="submit" variant="solid" busy={submitting}>
                  capture
                </Button>
              </div>
            </form>
          </>
        ) : (
          <>
            <DialogTitle>{result.name}</DialogTitle>
            <DialogDescription>
              {result.devices.length} device{result.devices.length === 1 ? "" : "s"} captured
              and already saved — decide below whether to keep it.
            </DialogDescription>

            {result.unknown.length > 0 ? (
              <div className="mt-4 rounded-btn border border-ember/40 bg-ember/[0.08] p-3">
                <p className="flex items-center gap-1.5 text-[12px] font-medium leading-tight text-ember">
                  <AlertTriangle size={13} strokeWidth={1.75} aria-hidden />
                  {result.unknown.length} device{result.unknown.length === 1 ? "" : "s"} unknown
                </p>
                <p className="mt-1.5 font-mono text-[10px] leading-relaxed text-mid">
                  the console never saw what {result.unknown.length === 1 ? "this device" : "these devices"}{" "}
                  {result.unknown.length === 1 ? "was" : "were"} playing, so restoring this
                  scene will skip {result.unknown.length === 1 ? "it" : "them"} rather than
                  guess: {result.unknown.map(nameOf).join(", ")}
                </p>
              </div>
            ) : (
              <p className="mt-4 flex items-center gap-1.5 font-mono text-[11px] text-sage">
                <CheckCircle2 size={13} strokeWidth={1.75} aria-hidden />
                every device captured with a known mode
              </p>
            )}

            <div className="mt-5 flex items-center justify-end gap-2">
              {result.unknown.length > 0 ? (
                <Button variant="ghost" busy={discarding} onClick={() => void handleDiscard()}>
                  discard capture
                </Button>
              ) : null}
              <Button variant="solid" onClick={handleKeep}>
                keep &ldquo;{result.name}&rdquo;
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
