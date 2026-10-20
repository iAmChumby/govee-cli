"use client";

import * as React from "react";
import { AlertTriangle } from "lucide-react";

import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Slider,
  Switch,
} from "@/components/ui";
import {
  HexField,
  NativeColorInput,
  SwatchRow,
} from "@/app/device/[ref]/color-picker";
import { ApiError, type DeviceSummary, type RoomSceneSummary } from "@/lib/api";
import { useDevices, useDiyScenes, useSaveAuthoredRoom } from "@/lib/queries";
import { cn } from "@/lib/cn";
import {
  clamp,
  defaultDraft,
  draftFromScene,
  rangeFor,
  saveBlocker,
  toInput,
  type AuthoredMode,
  type Draft,
} from "./authored-scene";

/* ==================================================================
   AuthoredSceneDialog — issue #2, G7. Hand-author (or edit) a room scene:
   every registered device is a row with an include switch, off by default.
   Authoring stores a plan only; nothing is sent to a device until a restore
   or a schedule rule applies the scene. Defaults are neutral and never read
   from the device's reported state.
   ================================================================== */

const INPUT_CLASS =
  "h-9 w-full rounded-btn border border-hairline bg-raised px-3 text-body text-hi transition-colors duration-motion-150 placeholder:text-low focus-visible:border-hairline-strong pointer-coarse:h-11 pointer-coarse:text-base";

const LABEL_CLASS = "block text-label uppercase leading-none tracking-micro text-mid";

function errMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : String(err);
}

const MODE_LABEL: Record<AuthoredMode, string> = {
  colour: "Colour",
  white: "White (K)",
  diy: "DIY scene",
};

/** Segmented control: grow the hit area under coarse pointers, not the ink. */
function Segmented({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: AuthoredMode;
  options: AuthoredMode[];
  onChange: (m: AuthoredMode) => void;
  ariaLabel: string;
}) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className="flex flex-wrap gap-1.5">
      {options.map((m) => {
        const active = m === value;
        return (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(m)}
            className="flex cursor-pointer items-center justify-center pointer-coarse:min-h-11"
          >
            <span
              className={cn(
                "inline-flex h-7 items-center rounded-btn border px-3 text-label transition-colors duration-motion-150",
                active
                  ? "border-hairline-strong bg-accent-dim text-hi"
                  : "border-hairline text-mid hover:border-hairline-strong hover:text-hi",
              )}
            >
              {MODE_LABEL[m]}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function DiyPicker({
  deviceRef,
  draft,
  onChange,
}: {
  deviceRef: string;
  draft: Draft;
  onChange: (patch: Partial<Draft>) => void;
}) {
  const scenes = useDiyScenes(deviceRef);
  const list = scenes.data ?? [];
  const missing =
    draft.diyValue !== null && !list.some((s) => s.value === draft.diyValue);

  return (
    <div>
      <label className="block">
        <span className={cn(LABEL_CLASS, "mb-1.5")}>DIY scene</span>
        <select
          value={draft.diyValue === null ? "" : String(draft.diyValue)}
          onChange={(e) => {
            const value = Number(e.target.value);
            const hit = list.find((s) => s.value === value);
            if (hit) onChange({ diyValue: hit.value, diyName: hit.name });
          }}
          className={INPUT_CLASS}
        >
          <option value="" disabled>
            {scenes.isLoading ? "loading DIY scenes…" : "choose a DIY scene"}
          </option>
          {missing ? (
            <option value={String(draft.diyValue)}>
              {draft.diyName ?? "saved scene"} (not in the current list)
            </option>
          ) : null}
          {list.map((s) => (
            <option key={s.value} value={String(s.value)}>
              {s.name}
            </option>
          ))}
        </select>
      </label>
      {scenes.isError ? (
        <p role="alert" className="mt-1.5 font-mono text-data leading-snug text-ember">
          could not load DIY scenes: {errMessage(scenes.error)}
        </p>
      ) : null}
      {!scenes.isLoading && !scenes.isError && list.length === 0 ? (
        <p className="mt-1.5 font-mono text-label leading-snug text-low">
          this device reports no DIY scenes
        </p>
      ) : null}
    </div>
  );
}

function DeviceRow({
  device,
  draft,
  onInclude,
  onChange,
}: {
  device: Pick<DeviceSummary, "ref" | "id" | "name" | "model" | "online">;
  draft: Draft | undefined;
  onInclude: (on: boolean) => void;
  onChange: (patch: Partial<Draft>) => void;
}) {
  const label = device.name ?? device.ref;
  const included = draft !== undefined;
  const range = rangeFor(device.model);
  const offline = device.online === false;
  const modes: AuthoredMode[] = range.diy ? ["colour", "white", "diy"] : ["colour", "white"];

  return (
    <li className="rounded-btn border border-hairline p-3">
      <div className="flex min-w-0 items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="break-words text-body font-medium leading-snug text-hi">
            {label}
            {offline ? (
              <span className="ml-2 inline-flex items-center gap-1 align-middle font-mono text-data uppercase tracking-caps text-ember">
                <AlertTriangle size={11} strokeWidth={1.75} aria-hidden />
                offline
              </span>
            ) : null}
          </p>
          {device.model ? (
            <p className="font-mono text-data text-low">{device.model}</p>
          ) : null}
        </div>
        <Switch
          checked={included}
          onCheckedChange={onInclude}
          ariaLabel={`Include ${label}`}
          className="shrink-0"
        />
      </div>

      {offline ? (
        <p className="mt-2 font-mono text-micro leading-snug text-ember">
          the console reports this device offline — it can still be included, but it will
          error at apply time while it stays offline
        </p>
      ) : null}

      {draft ? (
        <div className="mt-3 space-y-3 border-t border-hairline pt-3">
          <div className="flex min-w-0 items-center justify-between gap-3">
            <span className={LABEL_CLASS}>power</span>
            <Switch
              checked={draft.power}
              onCheckedChange={(power) => onChange({ power })}
              ariaLabel={`Power for ${label}`}
              className="shrink-0"
            />
          </div>

          {draft.power ? (
            <>
              <div>
                <div className="mb-1 flex items-baseline justify-between gap-3">
                  <span className={LABEL_CLASS}>brightness</span>
                  <span className="font-mono text-data text-mid">{draft.brightness}%</span>
                </div>
                <Slider
                  value={draft.brightness}
                  min={1}
                  max={100}
                  step={1}
                  onValueChange={(brightness) => onChange({ brightness })}
                  ariaLabel={`Brightness for ${label}`}
                />
              </div>

              <div>
                <span className={cn(LABEL_CLASS, "mb-1.5")}>mode</span>
                <Segmented
                  value={draft.mode}
                  options={modes}
                  onChange={(mode) => onChange({ mode })}
                  ariaLabel={`Mode for ${label}`}
                />
              </div>

              {draft.mode === "colour" ? (
                <div className="space-y-2">
                  <SwatchRow
                    activeHex={draft.color}
                    onPick={(color) => onChange({ color })}
                    ariaGroupLabel={`Colour for ${label}`}
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    <NativeColorInput
                      value={draft.color ?? "#FFFFFF"}
                      onPick={(color) => onChange({ color: color.toUpperCase() })}
                    />
                    <HexField onCommit={(color) => onChange({ color })} />
                    <span className="font-mono text-data text-mid">
                      {draft.color ?? "none chosen"}
                    </span>
                  </div>
                </div>
              ) : null}

              {draft.mode === "white" ? (
                <div>
                  <div className="mb-1 flex items-baseline justify-between gap-3">
                    <span className={LABEL_CLASS}>colour temperature</span>
                    <span className="font-mono text-data text-mid">{draft.kelvin}K</span>
                  </div>
                  <Slider
                    value={clamp(draft.kelvin, range.min, range.max)}
                    min={range.min}
                    max={range.max}
                    step={50}
                    onValueChange={(kelvin) => onChange({ kelvin })}
                    ariaLabel={`Colour temperature for ${label}`}
                  />
                  <p className="mt-1 font-mono text-data leading-snug text-low">
                    {range.min}–{range.max}K
                    {range.known
                      ? ""
                      : " (range for this model is unknown here; the server checks it at save)"}
                  </p>
                </div>
              ) : null}

              {draft.mode === "diy" ? (
                <DiyPicker deviceRef={device.ref} draft={draft} onChange={onChange} />
              ) : null}
            </>
          ) : (
            <p className="font-mono text-micro leading-snug text-low">
              this device will be switched off when the scene applies
            </p>
          )}
        </div>
      ) : null}
    </li>
  );
}

function EditorBody({
  scene,
  onDone,
}: {
  scene: RoomSceneSummary | null;
  onDone: () => void;
}) {
  const devices = useDevices();
  const save = useSaveAuthoredRoom();
  const isNew = scene === null;

  const [name, setName] = React.useState("");
  const [drafts, setDrafts] = React.useState<Record<string, Draft>>(() => {
    const init: Record<string, Draft> = {};
    for (const d of scene?.devices ?? []) init[d.device_id] = draftFromScene(d);
    return init;
  });
  const [error, setError] = React.useState<string | undefined>();
  const [saving, setSaving] = React.useState(false);

  const registered = React.useMemo(() => devices.data ?? [], [devices.data]);
  const registeredIds = new Set(registered.map((d) => d.id));
  const dropped = (scene?.devices ?? []).filter((d) => !registeredIds.has(d.device_id));
  // Saved devices that are no longer registered cannot be edited; they are not
  // sent on save, and the caption below says so.
  const active = Object.values(drafts).filter((d) => registeredIds.has(d.id));

  const labelOf = React.useCallback(
    (id: string) => registered.find((d) => d.id === id)?.name ?? id,
    [registered],
  );
  const blocker = saveBlocker({ isNew, name, drafts: active, labelOf });

  function patch(id: string, p: Partial<Draft>) {
    setError(undefined);
    setDrafts((cur) => (cur[id] ? { ...cur, [id]: { ...cur[id], ...p } } : cur));
  }

  function include(device: DeviceSummary, on: boolean) {
    setError(undefined);
    setDrafts((cur) => {
      const next = { ...cur };
      if (on) next[device.id] = next[device.id] ?? defaultDraft(device);
      else delete next[device.id];
      return next;
    });
  }

  async function handleSave() {
    if (blocker) return;
    setSaving(true);
    setError(undefined);
    try {
      await save.mutateAsync({
        name: isNew ? name.trim() : scene.name,
        devices: active.map(toInput),
        isNew,
      });
      onDone();
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    // The dialog shell scrolls at 100dvh-2rem, which runs under the ~40px fixed
    // bottom status strip on a phone. Capping this column lower keeps the whole
    // dialog clear of the strip; the middle scrolls and the footer stays put.
    <div className="flex max-h-[calc(100dvh-8.5rem)] min-h-0 flex-col">
      <div className="shrink-0">
      <DialogTitle>{isNew ? "new room scene" : "edit room scene"}</DialogTitle>
      <DialogDescription>
        write down what each device should do. nothing is sent to a device until the scene is
        restored or a schedule rule applies it.
      </DialogDescription>
      </div>

      <div className="-mx-1 mt-5 min-h-0 flex-1 space-y-4 overflow-y-auto px-1">
        <label className="block">
          <span className={cn(LABEL_CLASS, "mb-1.5")}>name</span>
          {isNew ? (
            <input
              type="text"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setError(undefined);
              }}
              placeholder="evening"
              autoComplete="off"
              className={INPUT_CLASS}
            />
          ) : (
            <p className="break-words font-mono text-body text-hi">{scene.name}</p>
          )}
        </label>

        <div>
          <span className={cn(LABEL_CLASS, "mb-1.5")}>devices</span>
          {devices.isLoading ? (
            <p className="font-mono text-label text-low">loading devices…</p>
          ) : devices.isError ? (
            <p role="alert" className="font-mono text-data leading-snug text-ember">
              could not load devices: {errMessage(devices.error)}
            </p>
          ) : registered.length === 0 ? (
            <p className="font-mono text-label leading-snug text-low">
              no registered devices — run scan-http first
            </p>
          ) : (
            <ul className="space-y-2">
              {registered.map((d) => (
                <DeviceRow
                  key={d.id}
                  device={d}
                  draft={drafts[d.id]}
                  onInclude={(on) => include(d, on)}
                  onChange={(p) => patch(d.id, p)}
                />
              ))}
            </ul>
          )}
          {dropped.length > 0 ? (
            <p className="mt-2 font-mono text-data leading-snug text-ember">
              {dropped.length === 1 ? "1 saved device is" : `${dropped.length} saved devices are`}{" "}
              no longer registered and will be dropped when you save
            </p>
          ) : null}
        </div>
      </div>

      <div className="mt-3 shrink-0 space-y-2 border-t border-hairline pt-3">
        {error ? (
          <p role="alert" className="font-mono text-data leading-snug text-ember">
            {error}
          </p>
        ) : null}
        {blocker ? (
          <p className="font-mono text-data leading-snug text-mid">{blocker}</p>
        ) : null}

        <div className="flex items-center justify-end gap-2">
          <DialogClose asChild>
            <Button variant="ghost">cancel</Button>
          </DialogClose>
          <Button
            variant="solid"
            busy={saving}
            disabled={blocker !== null}
            className="disabled:border-hairline! disabled:bg-raised! disabled:text-mid! disabled:opacity-100!"
            onClick={() => void handleSave()}
          >
            {isNew ? "save scene" : "save changes"}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** `scene` null = create mode; a scene = edit mode (authored scenes only). */
export function AuthoredSceneDialog({
  open,
  onOpenChange,
  scene,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  scene: RoomSceneSummary | null;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        {/* DialogContent unmounts on close, so every open starts from a fresh
            EditorBody and a stale draft can never leak between sessions. */}
        <EditorBody scene={scene} onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}
