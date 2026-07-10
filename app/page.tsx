"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import styles from "./page.module.css";

// ── Types ─────────────────────────────────────────────────────────────────────

interface ArchivistExtraction {
  facts_learned: string[];
  emotional_state: string;
  contradictions: string[];
  unresolved: string[];
  memory_sentence: string;
}

interface Message {
  role: "user" | "agent";
  content: string;
  timestamp: Date;
}

interface MemoryEntry {
  extraction: ArchivistExtraction;
  userMessage: string;
  turnIndex: number;
}

type AppState = "chatting" | "ending" | "ended";

const DEFAULT_PROFILE =
  "User is 18, environmental engineering sophomore at IIT Dhanbad. Interested in tech. Tends to overthink and overanalyze. Often feels lonely. Coping mechanisms: talking to AI, reading Stoicism.";

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatTime(d: Date) {
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// ── Sub-components ────────────────────────────────────────────────────────────

function TypingIndicator() {
  return (
    <div className={styles.typingWrap}>
      <span className={styles.typingDot} style={{ animationDelay: "0ms" }} />
      <span className={styles.typingDot} style={{ animationDelay: "160ms" }} />
      <span className={styles.typingDot} style={{ animationDelay: "320ms" }} />
    </div>
  );
}

function MemoryCard({ entry, isLatest }: { entry: MemoryEntry; isLatest: boolean }) {
  const [open, setOpen] = useState(isLatest);
  const e = entry.extraction;

  useEffect(() => {
    if (isLatest) setOpen(true);
  }, [isLatest]);

  return (
    <div className={`${styles.memCard} ${isLatest ? styles.memCardLatest : ""}`}>
      <button className={styles.memCardHeader} onClick={() => setOpen((o) => !o)}>
        <span className={styles.memCardLabel}>
          <span className={styles.goldDot} />
          {e.memory_sentence
            ? e.memory_sentence.length > 60
              ? e.memory_sentence.slice(0, 60) + "…"
              : e.memory_sentence
            : `Turn ${entry.turnIndex + 1}`}
        </span>
        <span className={`${styles.chevron} ${open ? styles.chevronOpen : ""}`}>›</span>
      </button>

      {open && (
        <div className={styles.memCardBody}>
          {e.emotional_state && (
            <div className={styles.memRow}>
              <span className={styles.memRowLabel}>Mood</span>
              <span className={styles.memRowValue}>{e.emotional_state}</span>
            </div>
          )}
          {e.facts_learned?.length > 0 && (
            <div className={styles.memRow}>
              <span className={styles.memRowLabel}>Facts</span>
              <ul className={styles.memList}>
                {e.facts_learned.map((f, i) => <li key={i}>{f}</li>)}
              </ul>
            </div>
          )}
          {e.unresolved?.length > 0 && (
            <div className={styles.memRow}>
              <span className={styles.memRowLabel}>Unresolved</span>
              <ul className={styles.memList}>
                {e.unresolved.map((u, i) => <li key={i}>{u}</li>)}
              </ul>
            </div>
          )}
          {e.contradictions?.length > 0 && (
            <div className={styles.memRow}>
              <span className={styles.memRowLabel}>Shift</span>
              <ul className={styles.memList}>
                {e.contradictions.map((c, i) => <li key={i}>{c}</li>)}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isThinking, setIsThinking] = useState(false);
  const [appState, setAppState] = useState<AppState>("chatting");

  const [masterProfile, setMasterProfile] = useState(DEFAULT_PROFILE);
  const [sessionHistory, setSessionHistory] = useState<string[]>([]);
  const [memoryLog, setMemoryLog] = useState<MemoryEntry[]>([]);
  const [recalledMemories, setRecalledMemories] = useState<string[]>([]);
  const [activeMemoryTab, setActiveMemoryTab] = useState<"live" | "recalled" | "profile">("live");

  const [endResult, setEndResult] = useState<{ blobId: string; dailyInsight: any } | null>(null);
  const [profileExpanded, setProfileExpanded] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const turnCount = useRef(0);

  // Load profile from Walrus via the server on mount.
  // /api/init reads mnemo-state.json (auto-updated after every session)
  // so no manual env-var editing is ever needed between sessions.
  useEffect(() => {
    fetch("/api/init")
      .then((r) => r.json())
      .then((data) => {
        if (data.masterProfile) {
          setMasterProfile(data.masterProfile);
          console.log("[init] Profile loaded from Walrus blob:", data.blobId);
        } else if (data.blobId) {
          // Blob ID exists but fetch failed — keep default profile, log for debug
          console.warn("[init] Blob ID found but profile fetch failed. Using default.");
        } else {
          console.log("[init] No prior session found. Using default profile.");
        }
      })
      .catch((e) => {
        console.warn("[init] /api/init failed, using default profile:", e);
      });
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isThinking]);

  // Auto-resize textarea
  useEffect(() => {
    const ta = inputRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 160) + "px";
  }, [input]);

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || isThinking || appState !== "chatting") return;

    const userMsg: Message = { role: "user", content: text, timestamp: new Date() };
    setMessages((m) => [...m, userMsg]);
    setInput("");
    setIsThinking(true);
    setActiveMemoryTab("live");

    const updatedHistory = [...sessionHistory, `User: ${text}`];

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userMessage: text,
          masterProfile,
          sessionHistory: updatedHistory,
        }),
      });

      const data = await res.json();

      if (data.error) throw new Error(data.error);

      const agentMsg: Message = {
        role: "agent",
        content: data.agentResponse,
        timestamp: new Date(),
      };
      setMessages((m) => [...m, agentMsg]);

      const newHistory = [
        ...updatedHistory,
        `Agent: ${data.agentResponse}`,
      ];
      setSessionHistory(newHistory);

      if (data.extraction) {
        setMemoryLog((prev) => [
          ...prev,
          { extraction: data.extraction, userMessage: text, turnIndex: turnCount.current },
        ]);
        turnCount.current += 1;
      }

      if (data.recalledMemories?.length > 0) {
        setRecalledMemories(data.recalledMemories);
      }
    } catch (err: any) {
      setMessages((m) => [
        ...m,
        {
          role: "agent",
          content: "Something went wrong. Please try again.",
          timestamp: new Date(),
        },
      ]);
    } finally {
      setIsThinking(false);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [input, isThinking, appState, masterProfile, sessionHistory]);

  const endSession = useCallback(async () => {
    if (sessionHistory.length === 0 || appState !== "chatting") return;
    setAppState("ending");

    try {
      const res = await fetch("/api/session-end", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionHistory, masterProfile }),
      });
      const data = await res.json();
      if (!data.error) {
        setMasterProfile(data.newProfile);
        setEndResult({ blobId: data.blobId, dailyInsight: data.dailyInsight });
        setActiveMemoryTab("profile");
      }
    } catch (err) {
      console.error("Session end failed:", err);
    } finally {
      setAppState("ended");
    }
  }, [sessionHistory, masterProfile, appState]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className={styles.shell}>
      {/* ── Left: Chat panel ── */}
      <div className={styles.chatPanel}>
        {/* Header */}
        <header className={styles.chatHeader}>
          <div className={styles.headerLeft}>
            <div className={styles.logoMark}>M</div>
            <div>
              <div className={styles.appName}>Mnemo</div>
              <div className={styles.appSub}>remembers everything</div>
            </div>
          </div>
          <div className={styles.headerRight}>
            {appState === "chatting" && sessionHistory.length > 0 && (
              <button className={styles.endBtn} onClick={endSession}>
                End session
              </button>
            )}
            {appState === "ending" && (
              <span className={styles.endingLabel}>Archiving…</span>
            )}
            {appState === "ended" && (
              <span className={styles.endedLabel}>Session saved</span>
            )}
          </div>
        </header>

        {/* Messages */}
        <div className={styles.messages}>
          {messages.length === 0 && (
            <div className={styles.emptyState}>
              <div className={styles.emptyGlyph}>◈</div>
              <p className={styles.emptyTitle}>Start talking.</p>
              <p className={styles.emptySub}>
                Mnemo builds a persistent memory of you across every session —
                not just what you said, but what it meant.
              </p>
            </div>
          )}

          {messages.map((msg, i) => (
            <div
              key={i}
              className={`${styles.msgRow} ${msg.role === "user" ? styles.msgRowUser : styles.msgRowAgent}`}
            >
              {msg.role === "agent" && (
                <div className={styles.agentAvatar}>M</div>
              )}
              <div className={styles.msgBubbleWrap}>
                <div
                  className={`${styles.msgBubble} ${
                    msg.role === "user" ? styles.msgBubbleUser : styles.msgBubbleAgent
                  }`}
                >
                  {msg.content}
                </div>
                <div className={styles.msgTime}>{formatTime(msg.timestamp)}</div>
              </div>
            </div>
          ))}

          {isThinking && (
            <div className={`${styles.msgRow} ${styles.msgRowAgent}`}>
              <div className={styles.agentAvatar}>M</div>
              <div className={styles.msgBubbleWrap}>
                <div className={`${styles.msgBubble} ${styles.msgBubbleAgent}`}>
                  <TypingIndicator />
                </div>
              </div>
            </div>
          )}

          {/* End-of-session result */}
          {endResult && (
            <div className={styles.sessionEndCard}>
              <div className={styles.sessionEndTitle}>Session archived to Walrus ✓</div>
              <div className={styles.sessionEndBlobRow}>
                <span className={styles.sessionEndBlobLabel}>Blob ID</span>
                <code className={styles.sessionEndBlobId}>{endResult.blobId}</code>
              </div>
              <p className={styles.sessionEndHint}>
                Your profile has been saved automatically. It will load instantly when you start your next session.
              </p>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Input */}
        <div className={styles.inputArea}>
          <textarea
            ref={inputRef}
            className={styles.inputField}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={appState === "ended" ? "Session ended." : "Say something…"}
            disabled={isThinking || appState !== "chatting"}
            rows={1}
          />
          <button
            className={styles.sendBtn}
            onClick={sendMessage}
            disabled={!input.trim() || isThinking || appState !== "chatting"}
            aria-label="Send message"
          >
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
              <path d="M2 9L16 9M16 9L10 3M16 9L10 15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
        </div>
      </div>

      {/* ── Right: Memory panel ── */}
      <aside className={styles.memoryPanel}>
        <div className={styles.memoryHeader}>
          <span className={styles.memoryTitle}>Memory</span>
          <div className={styles.memTabs}>
            {(["live", "recalled", "profile"] as const).map((tab) => (
              <button
                key={tab}
                className={`${styles.memTab} ${activeMemoryTab === tab ? styles.memTabActive : ""}`}
                onClick={() => setActiveMemoryTab(tab)}
              >
                {tab === "live" ? "This turn" : tab === "recalled" ? "Recalled" : "Profile"}
                {tab === "live" && memoryLog.length > 0 && (
                  <span className={styles.memBadge}>{memoryLog.length}</span>
                )}
                {tab === "recalled" && recalledMemories.length > 0 && (
                  <span className={styles.memBadge}>{recalledMemories.length}</span>
                )}
              </button>
            ))}
          </div>
        </div>

        <div className={styles.memoryBody}>
          {/* Live extraction tab */}
          {activeMemoryTab === "live" && (
            <div className={styles.memTabContent}>
              {memoryLog.length === 0 ? (
                <div className={styles.memEmpty}>
                  <div className={styles.memEmptyIcon}>◈</div>
                  <p>The Archivist will extract and display structured memories here after each message you send.</p>
                </div>
              ) : (
                [...memoryLog].reverse().map((entry, i) => (
                  <MemoryCard key={entry.turnIndex} entry={entry} isLatest={i === 0} />
                ))
              )}
            </div>
          )}

          {/* Recalled memories tab */}
          {activeMemoryTab === "recalled" && (
            <div className={styles.memTabContent}>
              {recalledMemories.length === 0 ? (
                <div className={styles.memEmpty}>
                  <div className={styles.memEmptyIcon}>◈</div>
                  <p>Memories from past sessions relevant to your current message will surface here.</p>
                </div>
              ) : (
                recalledMemories.map((mem, i) => (
                  <div key={i} className={styles.recalledCard}>
                    <span className={styles.goldDot} />
                    <span>{mem}</span>
                  </div>
                ))
              )}
            </div>
          )}

          {/* Profile tab */}
          {activeMemoryTab === "profile" && (
            <div className={styles.memTabContent}>
              <div className={styles.profileCard}>
                <div className={styles.profileHeader}>
                  <span className={styles.profileLabel}>Master Profile</span>
                  <span className={styles.profileSub}>Synthesized across all sessions</span>
                </div>
                <div className={`${styles.profileBody} ${profileExpanded ? styles.profileBodyExpanded : ""}`}>
                  {masterProfile}
                </div>
                {masterProfile.length > 300 && (
                  <button
                    className={styles.profileToggle}
                    onClick={() => setProfileExpanded((x) => !x)}
                  >
                    {profileExpanded ? "Show less" : "Show full profile"}
                  </button>
                )}
              </div>

              {endResult?.dailyInsight && (
                <div className={styles.insightCard}>
                  <div className={styles.insightLabel}>Today's insight</div>
                  {endResult.dailyInsight.primary_mood && (
                    <div className={styles.memRow}>
                      <span className={styles.memRowLabel}>Mood</span>
                      <span className={styles.memRowValue}>{endResult.dailyInsight.primary_mood}</span>
                    </div>
                  )}
                  {endResult.dailyInsight.psychological_insight && (
                    <div className={styles.memRow}>
                      <span className={styles.memRowLabel}>Insight</span>
                      <span className={styles.memRowValue}>{endResult.dailyInsight.psychological_insight}</span>
                    </div>
                  )}
                  {endResult.dailyInsight.recommended_focus_for_future && (
                    <div className={styles.memRow}>
                      <span className={styles.memRowLabel}>Next session</span>
                      <span className={styles.memRowValue}>{endResult.dailyInsight.recommended_focus_for_future}</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer watermark */}
        <div className={styles.memoryFooter}>
          <span className={styles.walrusTag}>
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" style={{marginRight: 4}}>
              <circle cx="5" cy="5" r="4" stroke="currentColor" strokeWidth="1.2"/>
              <circle cx="5" cy="5" r="1.5" fill="currentColor"/>
            </svg>
            Walrus + MemWal
          </span>
        </div>
      </aside>
    </div>
  );
}
