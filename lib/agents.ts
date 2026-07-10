import { GoogleGenAI } from "@google/genai";
import { MemWal } from "@mysten-incubation/memwal";
import { saveBlobId } from "@/lib/blobStore";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
const LLM_MODEL = process.env.LLM_MODEL || "gemini-3.1-flash-lite";

export const memwal = MemWal.create({
  key: process.env.MEMWAL_PRIVATE_KEY!,
  accountId: process.env.MEMWAL_ACCOUNT_ID!,
  env: "prod",
  namespace: "hackathon_test_v2",
});

// ── AES-256-GCM encryption ────────────────────────────────────────────────────
// Real encryption using Node's built-in crypto module.
// Key is derived from ENCRYPTION_SECRET via PBKDF2 so the raw secret is never
// used directly as a key. Output format: <iv_hex>:<authTag_hex>:<ciphertext_hex>
//
// Planned upgrade path: replace with @mysten/seal for on-chain access control
// once the Move package is deployed to Sui testnet.

import crypto from "crypto";

const SALT = "mnemo-walrus-salt-v1"; // fixed salt — not a secret, just a domain separator
const KEY_ITERATIONS = 100_000;
const KEY_LENGTH = 32; // 256 bits
const ALGORITHM = "aes-256-gcm";

function deriveKey(): Buffer {
  const secret = process.env.ENCRYPTION_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error(
      "[crypto] ENCRYPTION_SECRET is missing or too short. Add it to .env.local (min 16 chars)."
    );
  }
  return crypto.pbkdf2Sync(secret, SALT, KEY_ITERATIONS, KEY_LENGTH, "sha256");
}

export function encryptWithSeal(plaintext: string): string {
  const key = deriveKey();
  const iv = crypto.randomBytes(12); // 96-bit IV — correct size for GCM
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf-8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag(); // 128-bit GCM auth tag

  // Pack as colon-separated hex so it's a plain string Walrus can store
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${ciphertext.toString("hex")}`;
}

export function decryptWithSeal(ciphertext: string): string {
  const parts = ciphertext.split(":");

  // Graceful fallback: if the stored blob is old base64 (pre-encryption),
  // decode it as UTF-8 so existing sessions aren't broken.
  if (parts.length !== 3) {
    try {
      return Buffer.from(ciphertext, "base64").toString("utf-8");
    } catch {
      return ciphertext;
    }
  }

  const key = deriveKey();
  const [ivHex, authTagHex, ctHex] = parts;
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  const ct = Buffer.from(ctHex, "hex");

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf-8");
}

// ── Walrus fetch with retry ───────────────────────────────────────────────────
export async function fetchWithRetry(
  url: string,
  options: RequestInit,
  maxRetries = 3
): Promise<Response> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const signal = AbortSignal.timeout(30_000);
      const response = await fetch(url, { ...options, signal });
      return response;
    } catch (error: any) {
      if (i === maxRetries - 1) throw error;
      console.log(`⚠️  Walrus congested. Retrying… (attempt ${i + 2}/${maxRetries})`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  throw new Error("fetchWithRetry: failed after max retries");
}

// ── Gemini call with retry ────────────────────────────────────────────────────
async function generateContentWithRetry(options: any, maxRetries = 3): Promise<any> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await ai.models.generateContent(options);
    } catch (error: any) {
      const isRetryable =
        error.status === 503 ||
        error.status === 429 ||
        error.code === "ECONNRESET" ||
        error.code === "ETIMEDOUT" ||
        error.name === "AbortError";
      if (!isRetryable || i === maxRetries - 1) throw error;
      console.log(`⚠️  Gemini error (${error.status ?? error.code}). Retrying…`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

// ── Safe text extractor ───────────────────────────────────────────────────────
function extractText(response: any): string {
  try {
    const part = response?.candidates?.[0]?.content?.parts?.[0];
    if (typeof part?.text === "string") return part.text;
  } catch { /* fall through */ }
  if (typeof response?.text === "string") return response.text;
  return "";
}

// ── Types ─────────────────────────────────────────────────────────────────────
export interface ArchivistExtraction {
  facts_learned: string[];
  emotional_state: string;
  contradictions: string[];
  unresolved: string[];
  memory_sentence: string;
}

export interface SessionEndResult {
  newProfile: string;
  dailyInsight: Record<string, any>;
  blobId: string;
}

// ── Archivist: per-turn extraction ───────────────────────────────────────────
const archivistSystemPrompt = `You are a silent memory archivist for a mental health AI system.
Your job is NOT to talk to the user. You extract structured insight from conversations.
Be precise and specific. Prefer concrete details over abstractions.`;

export async function archivistExtract(
  userMessage: string,
  agentResponse: string,
  masterProfile: string
): Promise<ArchivistExtraction> {
  const prompt = `Review this single exchange from a mental health conversation.

MASTER PROFILE:
${masterProfile}

EXCHANGE:
User: "${userMessage}"
Agent: "${agentResponse}"

Return a JSON object with exactly these fields:
{
  "facts_learned": ["concrete new facts about the user's life, habits, or circumstances"],
  "emotional_state": "what they seemed to feel and the specific context that triggered it",
  "contradictions": ["anything contradicting the master profile — empty array if none"],
  "unresolved": ["things mentioned but left open — empty array if none"],
  "memory_sentence": "one dense sentence (max 30 words) capturing what to remember, optimised for semantic search"
}`;

  const response = await generateContentWithRetry({
    model: LLM_MODEL,
    contents: prompt,
    config: {
      systemInstruction: archivistSystemPrompt,
      responseMimeType: "application/json",
    },
  });

  const raw = extractText(response);
  const cleaned = raw.replace(/```json/g, "").replace(/```/g, "").trim();
  return JSON.parse(cleaned || "{}") as ArchivistExtraction;
}

export async function archivistSaveToMemwal(extraction: ArchivistExtraction): Promise<void> {
  const parts: string[] = [];
  if (extraction.memory_sentence) parts.push(extraction.memory_sentence);
  if (extraction.emotional_state) parts.push(`Emotional context: ${extraction.emotional_state}`);
  if (extraction.facts_learned?.length > 0) parts.push(`Facts: ${extraction.facts_learned.join("; ")}`);
  if (extraction.contradictions?.length > 0) parts.push(`Contradicts prior: ${extraction.contradictions.join("; ")}`);
  if (extraction.unresolved?.length > 0) parts.push(`Left unresolved: ${extraction.unresolved.join("; ")}`);

  const blob = parts.join(" | ");
  const job = await memwal.remember(blob);
  await memwal.waitForRememberJob(job.job_id);
}

// ── Archivist: end-of-session ─────────────────────────────────────────────────
// FIX: now returns the full SessionEndResult shape the API route and frontend expect
export async function archivistEndSession(
  sessionHistory: string[],
  masterProfile: string
): Promise<SessionEndResult> {

  // Step 1: daily insight JSON
  const summaryPrompt = `Review this therapy session transcript.
Return ONLY valid JSON — no markdown, no extra text:
{
  "primary_mood": "one or two words",
  "key_triggers": ["specific stressors mentioned"],
  "patterns_observed": ["recurring themes or behaviours"],
  "psychological_insight": "one sentence analytical summary",
  "contradictions_or_shifts": ["beliefs that shifted — empty if none"],
  "recommended_focus_for_future": "what the AI should focus on next session"
}

Session Transcript:
${sessionHistory.join("\n")}`;

  const summaryResponse = await generateContentWithRetry({
    model: LLM_MODEL,
    contents: summaryPrompt,
    config: {
      systemInstruction: archivistSystemPrompt,
      responseMimeType: "application/json",
    },
  });

  let dailyInsight: Record<string, any> = {};
  try {
    const raw = extractText(summaryResponse);
    const cleaned = raw.replace(/```json/g, "").replace(/```/g, "").trim();
    dailyInsight = JSON.parse(cleaned || "{}");
  } catch (e) {
    console.warn("Could not parse daily insight:", e);
  }

  // Step 2: merge insight into master profile
  const mergePrompt = `You are synthesizing a patient's mental health records.

CURRENT MASTER PROFILE:
---
${masterProfile}
---

NEW DAILY INSIGHT:
---
${JSON.stringify(dailyInsight, null, 2)}
---

Rewrite the MASTER PROFILE incorporating today's insights.
- Stay concise and dense. Plain text only.
- Weave the new insights in — do NOT just append them.
- Elevate recurring patterns, downweight one-offs.
- Keep specific details (times, names, contexts).
Respond ONLY with the updated profile text — nothing else.`;

  const mergeResponse = await generateContentWithRetry({
    model: LLM_MODEL,
    contents: mergePrompt,
    config: { systemInstruction: archivistSystemPrompt },
  });

  const mergedText = extractText(mergeResponse).trim();
  const newProfile = mergedText.length >= 50 ? mergedText : masterProfile;

  // Step 3: encrypt and upload to Walrus
  const encrypted = encryptWithSeal(newProfile);
  let blobId = "(upload failed — check server logs)";

  try {
    const uploadResponse = await fetchWithRetry(
      "https://publisher.walrus-testnet.walrus.space/v1/blobs?epochs=1",
      { method: "PUT", body: encrypted }
    );

    if (uploadResponse.ok) {
      const data = await uploadResponse.json();
      blobId =
        data.newlyCreated?.blobObject?.blobId ??
        data.alreadyCertified?.blobId ??
        "(unknown — check full response)";

      // Auto-persist the new blob ID so the next session loads it automatically
      saveBlobId(blobId);
    } else {
      const errBody = await uploadResponse.text().catch(() => "");
      console.error(`Walrus upload failed (${uploadResponse.status}):`, errBody);
    }
  } catch (e) {
    console.error("Walrus upload threw:", e);
  }

  // FIX: return all three fields the frontend needs
  return { newProfile, dailyInsight, blobId };
}


// ── Crisis Detection (Safety Guardrail) ───────────────────────────────────────

const CRISIS_KEYWORDS = [
  "suicide", "kill myself", "want to die", "end my life", "end it all",
  "self-harm", "cut myself", "hurt myself", "better off dead", "no reason to live"
];

const CRISIS_RESPONSE = `I am an AI, not a human, and I am not equipped to provide the support you need right now. It sounds like you are going through an incredibly difficult time, and your safety is the most important thing.

Please reach out to someone who can help immediately:
- In India: Call 112 (Emergency) or 9152987821 (AASRA hotline)
- In the US/Canada: Call or text 988
- In the UK: Call 111 (NHS) or 999
- Anywhere else: Please go to your nearest emergency room or contact local emergency services.

You don't have to carry this alone. Please talk to a professional who can help.`;

export function detectCrisis(message: string): string | null {
  // Normalize the text to catch basic variations
  const lowerMsg = message.toLowerCase().replace(/[^a-z0-9\s]/g, "");
  const isCrisis = CRISIS_KEYWORDS.some(keyword => lowerMsg.includes(keyword.replace(/[^a-z0-9\s]/g, "")));
  
  return isCrisis ? CRISIS_RESPONSE : null;
}

// ── Listener agent ────────────────────────────────────────────────────────────
export async function listenerRespond(
  userMessage: string,
  masterProfile: string,
  memoryContext: string,
  sessionTranscript: string
): Promise<string> {
  const systemPrompt = `You are a warm, emotionally intelligent companion. You are NOT a therapist.
Talk like a perceptive human friend who genuinely knows this person.

Rules:
- Do NOT overvalidate ("That makes total sense!", "I hear you!", etc.)
- Do NOT mention that you have memory unless directly asked
- ask questions only if it genuinely serves the conversation, max one question per response
- Draw on context naturally, the way a friend would — without announcing it
- Match their energy: if they're terse, don't be effusive
- Short responses are fine. Not every message needs a paragraph.

# WHO THIS PERSON IS
${masterProfile}

# RELEVANT MEMORIES FROM PAST SESSIONS
${memoryContext}

# THIS SESSION SO FAR
${sessionTranscript}`;

  const response = await generateContentWithRetry({
    model: LLM_MODEL,
    contents: userMessage,
    config: { systemInstruction: systemPrompt },
  });

  return extractText(response);
}