"use client";

/**
 * Local sidecar bindings for endpoints lib/api.ts does not cover yet
 * (config read/patch, device registry writes, group writes). The request
 * and error semantics mirror lib/api.ts exactly — same JSON framing, same
 * {error:{code,message}} unwrapping into ApiError — so callers handle both
 * interchangeably. Fold these into api.ts when ownership allows.
 */

import { useQuery } from "@tanstack/react-query";

import { ApiError } from "@/lib/api";

export async function sidecarRequest<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...init?.headers },
      cache: "no-store",
    });
  } catch {
    throw new ApiError(0, "network", "Sidecar unreachable on :6057");
  }

  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    let code = "http_error";
    try {
      const body = (await response.json()) as {
        error?: { code?: string; message?: string };
      };
      if (body.error?.message) message = body.error.message;
      if (body.error?.code) code = body.error.code;
    } catch {
      // non-JSON error body — fall back to status text
    }
    throw new ApiError(response.status, code, message);
  }

  return (await response.json()) as T;
}

/* ------------------------------------------------------------- config */

/** Redacted config shape returned by GET /config (api_key never clear). */
export interface SidecarConfig {
  api_key: string | null;
  default_mac: string | null;
  default_adapter: string | null;
  default_timeout: number;
  default_brightness: number;
  default_color: string | null;
  groups: Record<string, string[]>;
  devices: Record<
    string,
    { model: string | null; name: string; static_mac: string | null }
  >;
}

export interface ConfigPatchBody {
  default_mac?: string;
  default_timeout?: number;
  default_brightness?: number;
  default_color?: string;
}

export function fetchConfig(): Promise<SidecarConfig> {
  return sidecarRequest<SidecarConfig>("/config");
}

export function patchConfig(body: ConfigPatchBody): Promise<SidecarConfig> {
  return sidecarRequest<SidecarConfig>("/config", {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

/* ---------------------------------------------------- device registry */

export interface RegisterDeviceBody {
  mac: string;
  model: string;
  name?: string;
  static_mac?: string;
}

export interface RegisteredDevice {
  mac: string;
  model: string;
  name: string | null;
  static_mac: string | null;
}

export function registerDevice(body: RegisterDeviceBody): Promise<RegisteredDevice> {
  return sidecarRequest<RegisteredDevice>("/config/devices", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function deleteDevice(mac: string): Promise<{
  removed: string;
  mac: string;
  cleared_default: boolean;
}> {
  return sidecarRequest(`/config/devices/${encodeURIComponent(mac)}`, {
    method: "DELETE",
  });
}

/* -------------------------------------------------------------- groups */

export function createGroup(
  name: string,
  devices: string[],
): Promise<{ name: string; devices: string[] }> {
  return sidecarRequest<{ name: string; devices: string[] }>("/groups", {
    method: "POST",
    body: JSON.stringify({ name, devices }),
  });
}

export function deleteGroup(name: string): Promise<{ deleted: string }> {
  return sidecarRequest<{ deleted: string }>(
    `/groups/${encodeURIComponent(name)}`,
    { method: "DELETE" },
  );
}

/* ---------------------------------------------------------------- hook */

/** Local query hook — no shared equivalent exists in lib/queries.ts yet. */
export function useConfig() {
  return useQuery({
    queryKey: ["config"],
    queryFn: fetchConfig,
    staleTime: 30_000,
  });
}
