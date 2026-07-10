/**
 * GET /api/init
 *
 * Called by the browser on page load.
 * Returns the current blob ID and the decrypted master profile
 * so the frontend never needs to know about env vars or the state file.
 */

import { NextResponse } from "next/server";
import { loadBlobId } from "@/lib/blobStore";
import { decryptWithSeal } from "@/lib/agents";

export async function GET() {
  const blobId = loadBlobId();

  if (!blobId) {
    // No prior session — tell the frontend to use the default profile
    return NextResponse.json({ blobId: null, masterProfile: null });
  }

  // Fetch the encrypted profile from Walrus and decrypt it server-side
  try {
    const response = await fetch(
      `https://aggregator.walrus-testnet.walrus.space/v1/blobs/${blobId}`,
      { signal: AbortSignal.timeout(15_000) }
    );

    if (!response.ok) {
      console.warn(`[init] Walrus fetch failed (${response.status}) for blob ${blobId}`);
      return NextResponse.json({ blobId, masterProfile: null });
    }

    const encrypted = await response.text();
    const masterProfile = decryptWithSeal(encrypted);

    return NextResponse.json({ blobId, masterProfile });
  } catch (e) {
    console.error("[init] Error fetching profile from Walrus:", e);
    // Return the blob ID so the frontend knows one exists, but no profile
    return NextResponse.json({ blobId, masterProfile: null });
  }
}
