"use client";

import { motion } from "motion/react";

import { StatusStrip } from "@/components/shell/status-strip";
import { TopBar } from "@/components/shell/top-bar";
import { panelIn, staggerParent } from "@/lib/motion";

import { ConnectionSection } from "./connection-section";
import { DefaultsSection } from "./defaults-section";
import { DevicesSection } from "./devices-section";
import { GroupsSection } from "./groups-section";

/* ==================================================================
   Settings — connection health, device registry, groups and config
   defaults. Every section is a flat hairline Panel with divide-y
   rows and mono metadata, per the optical v2 contract.
   ================================================================== */

export default function SettingsPage() {
  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-bg">
      <TopBar crumbs={["settings"]} />

      <div className="flex min-h-0 flex-1">
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
                  Settings
                </h1>
                <p className="mt-1 font-mono text-[11px] text-low">
                  sidecar · registry · groups · defaults
                </p>
              </div>
            </motion.section>

            <ConnectionSection />
            <DevicesSection />
            <GroupsSection />
            <DefaultsSection />
          </motion.div>
        </main>
      </div>

      <StatusStrip />
    </div>
  );
}
