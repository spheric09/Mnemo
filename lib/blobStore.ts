/**
 * blobStore.ts — server-side only
 *
 * Persists the latest Walrus blob ID to `mnemo-state.json` in the project
 * root so it survives process restarts without any manual env-var editing.
 *
 * File shape:
 *   { "blobId": "OsEN4Fh55I_M9Rq1K_37iOrzGuMAl6NaZEBEMXxbybc" }
 */

import fs from "fs";
import path from "path";

// Always resolve relative to the project root, not the CWD
const STATE_FILE = path.join(process.cwd(), "mnemo-state.json");

interface MnemoState {
  blobId: string;
}

export function loadBlobId(): string {
  // 1. Try mnemo-state.json (written automatically after each session)
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE, "utf-8");
      const state: MnemoState = JSON.parse(raw);
      if (state.blobId && state.blobId.length > 0) {
        console.log(`[blobStore] Loaded blob ID from mnemo-state.json: ${state.blobId}`);
        return state.blobId;
      }
    }
  } catch (e) {
    console.warn("[blobStore] Could not read mnemo-state.json:", e);
  }

  // 2. Fall back to .env.local / environment variable (first-run / bootstrap)
  const envBlobId = process.env.PREVIOUS_PROFILE_BLOB_ID ?? "";
  if (envBlobId.length > 0) {
    console.log(`[blobStore] Loaded blob ID from env: ${envBlobId}`);
  } else {
    console.log("[blobStore] No blob ID found — will use default profile.");
  }
  return envBlobId;
}

export function saveBlobId(blobId: string): void {
  if (!blobId || blobId.startsWith("(")) {
    // Don't persist error placeholders like "(upload failed)"
    console.warn("[blobStore] Refusing to save invalid blob ID:", blobId);
    return;
  }
  try {
    const state: MnemoState = { blobId };
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
    console.log(`[blobStore] Saved blob ID to mnemo-state.json: ${blobId}`);
  } catch (e) {
    console.error("[blobStore] Could not write mnemo-state.json:", e);
  }
}
