import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';

// ─── Config ────────────────────────────────────────────────────────────────

const LOG_DIR = join(process.cwd(), 'logs');

// Ensure logs directory exists at startup
mkdirSync(LOG_DIR, { recursive: true });

// ─── Types ─────────────────────────────────────────────────────────────────

export type LogRole = 'user' | 'assistant' | 'tool' | 'system' | 'feishu_raw';

export interface LogEntry {
  timestamp: string;
  chat_id: string;
  session_id?: string;
  role: LogRole;
  content: string;
  meta?: Record<string, unknown>;
}

/** Raw Feishu message fields worth preserving */
export interface FeishuRawMessage {
  message_id: string;
  chat_type: string;
  message_type: string;
  raw_content: string; // the original JSON string from Feishu
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Returns today's date string: YYYY-MM-DD */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Returns the log file path for the current day */
function logFilePath(): string {
  return join(LOG_DIR, `${today()}.jsonl`);
}

/** ISO timestamp for right now */
function now(): string {
  return new Date().toISOString();
}

// ─── Core writer ───────────────────────────────────────────────────────────

/**
 * Append a single LogEntry as a JSONL line to today's log file.
 * Uses sync I/O so the write is never lost even if the process exits.
 */
function writeEntry(entry: LogEntry): void {
  try {
    appendFileSync(logFilePath(), JSON.stringify(entry) + '\n', 'utf-8');
  } catch (err) {
    // Never let logging blow up the bot
    console.error('[logger] Failed to write log entry:', err);
  }
}

// ─── Public API ────────────────────────────────────────────────────────────

/** Log the raw Feishu message event before any processing */
export function logFeishuRaw(chat_id: string, msg: FeishuRawMessage): void {
  writeEntry({
    timestamp: now(),
    chat_id,
    role: 'feishu_raw',
    content: msg.raw_content,
    meta: {
      message_id: msg.message_id,
      chat_type: msg.chat_type,
      message_type: msg.message_type,
    },
  });
}

/** Log a message sent by the user */
export function logUser(chat_id: string, text: string, session_id?: string): void {
  writeEntry({ timestamp: now(), chat_id, session_id, role: 'user', content: text });
}

/** Log a final reply sent back to the user */
export function logAssistant(chat_id: string, text: string, session_id?: string): void {
  writeEntry({ timestamp: now(), chat_id, session_id, role: 'assistant', content: text });
}

/** Log a tool call made by the agent during processing */
export function logTool(chat_id: string, toolName: string, session_id?: string): void {
  writeEntry({ timestamp: now(), chat_id, session_id, role: 'tool', content: toolName });
}

/** Log a system-level event (e.g. session start, self-update) */
export function logSystem(chat_id: string, event: string, session_id?: string): void {
  writeEntry({ timestamp: now(), chat_id, session_id, role: 'system', content: event });
}
