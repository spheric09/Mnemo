import { NextRequest, NextResponse } from "next/server";
import { archivistEndSession } from "@/lib/agents";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    // FIX: accept both "masterProfile" (what page.tsx sends)
    // and "masterProfileBlob" (old name) so either works
    const sessionHistory: string[] = body.sessionHistory ?? [];
    const masterProfile: string =
      body.masterProfile ?? body.masterProfileBlob ?? "";

    if (sessionHistory.length === 0) {
      return NextResponse.json(
        { error: "No session history to process" },
        { status: 400 }
      );
    }

    // archivistEndSession now returns { newProfile, dailyInsight, blobId }
    const result = await archivistEndSession(sessionHistory, masterProfile);

    // Return all three fields the frontend expects
    return NextResponse.json({
      newProfile: result.newProfile,
      dailyInsight: result.dailyInsight,
      blobId: result.blobId,
    });
  } catch (error: any) {
    console.error("Session end API error:", error);
    return NextResponse.json({ error: error.message ?? "Unknown error" }, { status: 500 });
  }
}
