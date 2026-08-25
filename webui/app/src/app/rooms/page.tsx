"use client";

import * as React from "react";
import { motion } from "motion/react";
import { Plus } from "lucide-react";

import { Button, Panel, SectionLabel, Skeleton } from "@/components/ui";
import { CaptureRoomDialog } from "@/components/rooms/capture-room-dialog";
import { RoomSceneCard } from "@/components/rooms/room-scene-card";
import { useRooms } from "@/lib/queries";
import { panelIn, staggerParent } from "@/lib/motion";

/* ==================================================================
   Rooms — save every registered device's current mode under one name,
   restore all of them back to it later. WEBUI_V3_SPEC.md §10 T28.
   ================================================================== */

export default function RoomsPage() {
  const rooms = useRooms();
  const [captureOpen, setCaptureOpen] = React.useState(false);

  const scenes = rooms.data ?? [];

  return (
    <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">
      <motion.div
        variants={staggerParent}
        initial="hidden"
        animate="show"
        className="mx-auto max-w-[1080px] space-y-5 px-6 pb-16 pt-6"
      >
        {/* head */}
        <motion.section variants={panelIn} className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold leading-tight tracking-[-0.02em] text-hi">
              Rooms
            </h1>
            <p className="mt-1 font-mono text-[11px] text-low">
              {rooms.isLoading
                ? "loading scenes…"
                : `${scenes.length} saved ${scenes.length === 1 ? "scene" : "scenes"}`}
            </p>
          </div>
          <Button variant="solid" onClick={() => setCaptureOpen(true)}>
            <Plus size={14} strokeWidth={1.75} aria-hidden />
            capture scene
          </Button>
        </motion.section>

        {/* error state */}
        {rooms.isError ? (
          <motion.section variants={panelIn}>
            <Panel className="border-ember/40 p-5">
              <p className="text-[13px] font-medium text-hi">Room scenes unavailable</p>
              <p className="mt-1 font-mono text-[11px] text-mid">
                {rooms.error instanceof Error ? rooms.error.message : String(rooms.error)} — is
                the sidecar running on 127.0.0.1:6057?
              </p>
            </Panel>
          </motion.section>
        ) : null}

        {/* saved scenes */}
        <motion.section variants={panelIn}>
          <SectionLabel title="saved scenes" />
          {rooms.isLoading ? (
            <div className="mt-3 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {Array.from({ length: 3 }, (_, i) => (
                <Panel key={i} className="p-4">
                  <Skeleton className="h-5 w-32" />
                  <Skeleton className="mt-2 h-3 w-20" />
                  <Skeleton className="mt-4 h-8 w-full" />
                </Panel>
              ))}
            </div>
          ) : scenes.length === 0 && !rooms.isError ? (
            <p className="mt-3 font-mono text-[11px] leading-relaxed text-low">
              no room scenes yet — press{" "}
              <span className="text-mid">capture scene</span> above to save every device&rsquo;s
              current mode under one name
            </p>
          ) : (
            <div className="mt-3 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {scenes.map((scene) => (
                <RoomSceneCard key={scene.name} scene={scene} detail={scene.devices} />
              ))}
            </div>
          )}
        </motion.section>
      </motion.div>

      <CaptureRoomDialog
        open={captureOpen}
        onOpenChange={setCaptureOpen}
      />
    </main>
  );
}
