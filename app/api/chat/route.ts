import { NextRequest, NextResponse } from "next/server";
import {
  memwal,
  listenerRespond,
  archivistExtract,
  archivistSaveToMemwal,
  detectCrisis,
} from "@/lib/agents";

export async function POST(req: NextRequest) {
  try {
    const { userMessage, masterProfile, sessionHistory } = await req.json();

    // ── 0. Safety Guardrail: Intercept crisis language immediately ──
    const crisisResponse = detectCrisis(userMessage);
    if (crisisResponse) {
      console.warn("⚠️ Crisis language detected. Bypassing LLM.");
      return NextResponse.json({
        agentResponse: crisisResponse,
        extraction: null,       // Don't extract memories during a crisis
        recalledMemories: [],   // Don't surface past memories
      });
    }

    // 1. Recall relevant memories from MemWal
    let memoryContext = "No prior related memories found.";
    let recalledMemories: string[] = [];
    try {
      const rawHistory = await memwal.recall({ query: userMessage, limit: 5 });
      const history: any[] = Array.isArray(rawHistory)
        ? rawHistory
        : (rawHistory as any)?.results ?? [];
      if (history.length > 0) {
        recalledMemories = history.map((m: any) => m.text);
        memoryContext = recalledMemories.map((t) => `- ${t}`).join("\n");
      }
    } catch (err) {
      console.warn("MemWal recall failed (non-fatal):", err);
    }

    // 2. Listener Agent: generate the response
    const recentWindow = (sessionHistory as string[]).slice(-10);
    const sessionTranscript =
      recentWindow.length > 0 ? recentWindow.join("\n") : "Session just started.";

    const agentResponse = await listenerRespond(
      userMessage,
      masterProfile,
      memoryContext,
      sessionTranscript
    );

    if (!agentResponse) {
      return NextResponse.json({ error: "Empty response from model" }, { status: 500 });
    }

    // 3. Archivist Agent: extract structured meaning, return it to UI,
    //    save to MemWal in the background (don't block the response)
    let extraction = null;
    try {
      extraction = await archivistExtract(userMessage, agentResponse, masterProfile);
      archivistSaveToMemwal(extraction).catch((err) =>
        console.warn("MemWal background save failed:", err)
      );
    } catch (err) {
      console.warn("Archivist extraction failed (non-fatal):", err);
    }

    return NextResponse.json({ agentResponse, extraction, recalledMemories });
  } catch (error: any) {
    console.error("Chat API error:", error);
    return NextResponse.json({ error: error.message ?? "Unknown error" }, { status: 500 });
  }
}
