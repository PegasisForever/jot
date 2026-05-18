import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";

import {
  type CollabState,
  type ClientMutation,
  type SavedCollabState,
  type ServerMutationMessage,
  applyClientMutations,
  collabFromMarkdown,
  collabToMarkdown,
  saveCollabState,
  loadCollabState,
  newCollabState,
  idAtIndex,
  idBeforeIndex,
} from "./collab.js";

// ---- Types ----

export type CommentAnchor = {
  quote: string;
  prefix: string;
  suffix: string;
  start: number;
  end: number;
};

export type CommentMessage = {
  id: string;
  parentId: string | null;
  authorId: string;
  authorName: string;
  body: string;
  createdAt: string;
  updatedAt: string;
};

export type CommentThread = {
  id: string;
  resolved: boolean;
  createdAt: string;
  updatedAt: string;
  anchor: CommentAnchor;
  messages: CommentMessage[];
};

export type ShareAccess = "none" | "view" | "comment" | "edit";

export type NoteMetaFile = {
  id: string;
  title: string;
  shareId: string;
  shareAccess: ShareAccess;
  createdAt: string;
  updatedAt: string;
  threads: CommentThread[];
  collab?: SavedCollabState;
  collabState?: SavedCollabState;
};

export type NoteRecord = {
  id: string;
  title: string;
  shareId: string;
  shareAccess: ShareAccess;
  createdAt: string;
  updatedAt: string;
  threads: CommentThread[];
  markdown: string;
  collab: CollabState;
  clientAcks: Map<string, number>;
};

export type NoteSummary = {
  id: string;
  title: string;
  updatedAt: string;
  shareId: string;
  snippet: string;
};

export type ApiOk<T> = { ok: true } & T;
export type ApiErr = { ok: false; status: number; error: string; errors?: string[] };
export type ApiResult<T> = ApiOk<T> | ApiErr;

export type Actor = { authorName: string };

// ---- Module state ----

let dataDir: string | null = null;
let notesDir: string | null = null;

export const notes = new Map<string, NoteRecord>();

type NotesEventMap = {
  "note-updated": [NoteRecord];
  "threads-updated": [NoteRecord];
  "editor-hello": [NoteRecord];
  "editor-mutation": [NoteRecord, ServerMutationMessage];
  "share-access-changed": [NoteRecord];
  "note-deleted": [string];
};

class NotesEventEmitter extends EventEmitter {
  emit<K extends keyof NotesEventMap>(event: K, ...args: NotesEventMap[K]): boolean {
    return super.emit(event, ...args);
  }
  on<K extends keyof NotesEventMap>(event: K, listener: (...args: NotesEventMap[K]) => void): this {
    return super.on(event, listener);
  }
}

export const notesEvents = new NotesEventEmitter();

export function configureNotesApi(opts: { dataDir: string }) {
  dataDir = opts.dataDir;
  notesDir = path.join(opts.dataDir, "notes");
}

function getNotesDir(): string {
  if (!notesDir) throw new Error("notes-api not configured — call configureNotesApi() first.");
  return notesDir;
}

function getDataDir(): string {
  if (!dataDir) throw new Error("notes-api not configured — call configureNotesApi() first.");
  return dataDir;
}

// ---- Filesystem helpers ----

export function ensureDirectories() {
  fs.mkdirSync(getDataDir(), { recursive: true });
  fs.mkdirSync(getNotesDir(), { recursive: true });
}

export function noteMarkdownPath(id: string) {
  return path.join(getNotesDir(), `${id}.md`);
}

export function noteMetaPath(id: string) {
  return path.join(getNotesDir(), `${id}.json`);
}

export function readJson<T>(filePath: string, fallback: T) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(filePath: string, value: unknown) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function loadNotesIntoMemory() {
  notes.clear();
  const files = fs.readdirSync(getNotesDir()).filter((file) => file.endsWith(".md"));

  for (const file of files) {
    const id = path.basename(file, ".md");
    const markdownPath = noteMarkdownPath(id);
    const metaPath = noteMetaPath(id);
    if (!fs.existsSync(metaPath)) {
      continue;
    }

    const markdown = fs.readFileSync(markdownPath, "utf8");
    const meta = readJson<NoteMetaFile | null>(metaPath, null);
    if (!meta) {
      continue;
    }

    const threads = Array.isArray(meta.threads)
      ? meta.threads.map((thread) => ({
          ...thread,
          messages: Array.isArray(thread.messages)
            ? thread.messages.map((message) => ({
                ...message,
                parentId: typeof message.parentId === "string" ? message.parentId : null,
              }))
            : [],
        }))
      : [];

    let collab: CollabState;
    if (meta.collab) {
      collab = loadCollabState(meta.collab);
    } else if (meta.collabState) {
      collab = loadCollabState(meta.collabState);
    } else {
      collab = collabFromMarkdown(markdown);
    }

    notes.set(id, {
      ...meta,
      shareAccess: (meta.shareAccess as ShareAccess) || "none",
      markdown: collabToMarkdown(collab),
      threads,
      collab,
      clientAcks: new Map(),
    });
  }
}

// ---- Small helpers ----

export function nowIso() {
  return new Date().toISOString();
}

export function createShortId(length = 8) {
  return crypto.randomBytes(length).toString("base64url").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, length);
}

export function createId(length = 12) {
  return createShortId(length);
}

export function normalizeTitle(input: string) {
  return input.trim().slice(0, 160) || "untitled";
}

export function normalizeCommentBody(input: string) {
  return input.trim().slice(0, 4000);
}

export function countOccurrences(haystack: string, needle: string) {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count++;
    index = haystack.indexOf(needle, index + 1);
  }
  return count;
}

export function findNoteByShareId(shareId: string) {
  for (const note of notes.values()) {
    if (note.shareId === shareId) return note;
  }
  return null;
}

export function locateMessage(note: NoteRecord, messageId: string) {
  for (const thread of note.threads) {
    const message = thread.messages.find((item) => item.id === messageId);
    if (message) return { thread, message };
  }
  return null;
}

export function summarizeNote(note: NoteRecord, needle: string): NoteSummary {
  return {
    id: note.id,
    title: note.title,
    updatedAt: note.updatedAt,
    shareId: note.shareId,
    snippet: buildSnippet(note, needle),
  };
}

function buildSnippet(note: NoteRecord, needle: string) {
  const source = note.markdown.replace(/\s+/g, " ").trim();
  if (!source) return "";
  if (!needle) return source.slice(0, 140);
  const index = source.toLowerCase().indexOf(needle);
  if (index === -1) return source.slice(0, 140);
  const start = Math.max(0, index - 40);
  const end = Math.min(source.length, index + needle.length + 80);
  return source.slice(start, end);
}

function searchNotesInternal(query: string) {
  const needle = query.trim().toLowerCase();
  return Array.from(notes.values())
    .map((note) => summarizeNote(note, needle))
    .filter((note) => {
      if (!needle) return true;
      return note.title.toLowerCase().includes(needle) || note.snippet.toLowerCase().includes(needle);
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function persistNote(note: NoteRecord, broadcastUpdate = true) {
  note.markdown = collabToMarkdown(note.collab);

  const meta: NoteMetaFile = {
    id: note.id,
    title: note.title,
    shareId: note.shareId,
    shareAccess: note.shareAccess,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    threads: note.threads,
    collab: saveCollabState(note.collab),
  };

  fs.writeFileSync(noteMarkdownPath(note.id), note.markdown, "utf8");
  writeJson(noteMetaPath(note.id), meta);
  if (broadcastUpdate) {
    notesEvents.emit("note-updated", note);
  }
}

function createNoteRecord(): NoteRecord {
  const timestamp = nowIso();
  const id = createShortId();
  const note: NoteRecord = {
    id,
    title: "untitled",
    shareId: createShortId(14),
    shareAccess: "none",
    createdAt: timestamp,
    updatedAt: timestamp,
    markdown: "",
    threads: [],
    collab: newCollabState(),
    clientAcks: new Map(),
  };

  notes.set(id, note);
  persistNote(note);
  return note;
}

// ---- Core API ----

export function listNotes(input: { q?: string }): ApiResult<{ notes: NoteSummary[] }> {
  return { ok: true, notes: searchNotesInternal(input.q || "") };
}

export type ReadNoteFull = {
  kind: "full";
  note: {
    id: string;
    title: string;
    markdown: string;
    shareId: string;
    shareAccess: ShareAccess;
    updatedAt: string;
    createdAt: string;
  };
  threads: CommentThread[];
};

export type ReadNotePaginated = {
  kind: "paginated";
  note: {
    id: string;
    title: string;
    totalLines: number;
    offset: number;
    limit: number;
    remaining: number;
    content: string;
  };
};

export function readNote(input: { id: string; offset?: number | null; limit?: number | null }): ApiResult<ReadNoteFull | ReadNotePaginated> {
  const note = notes.get(input.id);
  if (!note) return { ok: false, status: 404, error: "Note not found." };

  const offset = input.offset ?? null;
  const limit = input.limit ?? null;

  if (offset !== null || limit !== null) {
    const lines = note.markdown.split("\n");
    const start = Math.max(0, (offset || 1) - 1);
    const end = limit ? Math.min(lines.length, start + limit) : lines.length;
    const slice = lines.slice(start, end);
    const totalLines = lines.length;
    const remaining = totalLines - end;
    return {
      ok: true,
      kind: "paginated",
      note: {
        id: note.id,
        title: note.title,
        totalLines,
        offset: start + 1,
        limit: slice.length,
        remaining,
        content: slice.map((line, i) => `${start + i + 1}: ${line}`).join("\n"),
      },
    };
  }

  return {
    ok: true,
    kind: "full",
    note: {
      id: note.id,
      title: note.title,
      markdown: note.markdown,
      shareId: note.shareId,
      shareAccess: note.shareAccess,
      updatedAt: note.updatedAt,
      createdAt: note.createdAt,
    },
    threads: note.threads,
  };
}

export function createNote(_input: Record<string, never> = {} as Record<string, never>): ApiResult<{ note: NoteSummary }> {
  const note = createNoteRecord();
  return { ok: true, note: summarizeNote(note, "") };
}

export function updateNote(input: {
  id: string;
  title?: string;
  markdown?: string;
  shareAccess?: ShareAccess;
}): ApiResult<{ savedAt: string; shareAccess: ShareAccess }> {
  const note = notes.get(input.id);
  if (!note) return { ok: false, status: 404, error: "Note not found." };

  const titleProvided = input.title !== undefined;
  const markdownProvided = input.markdown !== undefined;
  const shareAccessProvided = input.shareAccess !== undefined;

  const nextTitle = titleProvided ? normalizeTitle(String(input.title || note.title)) : note.title;
  const nextMarkdown = markdownProvided ? String(input.markdown || "") : note.markdown;
  const nextShareAccess = shareAccessProvided && ["none", "view", "comment", "edit"].includes(input.shareAccess as string)
    ? (input.shareAccess as ShareAccess)
    : note.shareAccess;

  const titleChanged = nextTitle !== note.title;
  const markdownChanged = nextMarkdown !== note.markdown;
  const shareAccessChanged = nextShareAccess !== note.shareAccess;

  note.title = nextTitle;
  note.shareAccess = nextShareAccess;
  if (markdownChanged) {
    note.collab = collabFromMarkdown(nextMarkdown, note.collab.serverCounter + 1);
    note.markdown = nextMarkdown;
  }
  note.updatedAt = nowIso();
  persistNote(note, false);
  if (shareAccessChanged) {
    notesEvents.emit("share-access-changed", note);
  }
  if (titleChanged || markdownChanged || shareAccessChanged) {
    notesEvents.emit("editor-hello", note);
    notesEvents.emit("note-updated", note);
  }

  return { ok: true, savedAt: note.updatedAt, shareAccess: note.shareAccess };
}

export function deleteNote(input: { id: string }): ApiResult<Record<string, never>> {
  const note = notes.get(input.id);
  if (!note) return { ok: false, status: 404, error: "Note not found." };

  notes.delete(input.id);
  try { fs.unlinkSync(noteMarkdownPath(input.id)); } catch {}
  try { fs.unlinkSync(noteMetaPath(input.id)); } catch {}
  notesEvents.emit("note-deleted", input.id);
  return { ok: true } as ApiOk<Record<string, never>>;
}

export type Edit = { oldText: string; newText: string };

export function applyEdits(input: { id: string; edits: Edit[]; title?: string }): ApiResult<{ savedAt: string }> {
  const note = notes.get(input.id);
  if (!note) return { ok: false, status: 404, error: "Note not found." };

  if (!Array.isArray(input.edits) || input.edits.length === 0) {
    return { ok: false, status: 400, error: "edits must be a non-empty array of {oldText, newText}." };
  }

  let workingCollab = note.collab;
  let markdown = note.markdown;
  let senderCounter = 0;
  const errors: string[] = [];
  const idListUpdates: ServerMutationMessage["idListUpdates"] = [];

  for (let i = 0; i < input.edits.length; i++) {
    const edit = input.edits[i];
    const oldText = String(edit?.oldText || "");
    const newText = String(edit?.newText || "");

    if (!oldText) {
      errors.push(`Edit ${i}: oldText is empty.`);
      continue;
    }

    const firstIndex = markdown.indexOf(oldText);
    if (firstIndex === -1) {
      errors.push(`Edit ${i}: oldText not found.`);
      continue;
    }

    const secondIndex = markdown.indexOf(oldText, firstIndex + 1);
    if (secondIndex !== -1) {
      errors.push(`Edit ${i}: oldText is ambiguous (found ${countOccurrences(markdown, oldText)} times).`);
      continue;
    }

    let nextClientCounter = senderCounter + 1;
    const mutations: ClientMutation[] = [];

    if (oldText.length > 0) {
      mutations.push({
        name: "delete",
        clientCounter: nextClientCounter++,
        args: {
          startId: idAtIndex(workingCollab, firstIndex),
          endId: idAtIndex(workingCollab, firstIndex + oldText.length - 1),
          contentLength: oldText.length,
        },
      });
    }

    if (newText.length > 0) {
      mutations.push({
        name: "insert",
        clientCounter: nextClientCounter++,
        args: {
          before: firstIndex > 0 ? idBeforeIndex(workingCollab, firstIndex) : null,
          id: { bunchId: crypto.randomUUID(), counter: 0 },
          content: newText,
          isInWord: false,
        },
      });
    }

    const result = applyClientMutations(workingCollab, mutations);
    workingCollab = result.state;
    markdown = result.markdown;
    idListUpdates.push(...result.idListUpdates);
    senderCounter = mutations.at(-1)?.clientCounter || senderCounter;
  }

  if (errors.length > 0) {
    return { ok: false, status: 400, error: errors.join("; "), errors };
  }

  note.collab = workingCollab;
  note.markdown = markdown;
  note.updatedAt = nowIso();

  let titleChanged = false;
  if (input.title !== undefined) {
    const nextTitle = normalizeTitle(String(input.title || note.title));
    if (nextTitle !== note.title) {
      note.title = nextTitle;
      titleChanged = true;
    }
  }
  persistNote(note, false);

  if (titleChanged) {
    notesEvents.emit("editor-hello", note);
  } else if (idListUpdates.length > 0) {
    notesEvents.emit("editor-mutation", note, {
      type: "mutation",
      senderId: "__api__",
      senderCounter,
      serverCounter: note.collab.serverCounter,
      markdown: note.markdown,
      idListUpdates,
    });
  }
  notesEvents.emit("note-updated", note);

  return { ok: true, savedAt: note.updatedAt };
}

export function addThread(
  input: { id: string; quote: string; body: string },
  actor: Actor,
): ApiResult<{ thread: { id: string } }> {
  const note = notes.get(input.id);
  if (!note) return { ok: false, status: 404, error: "Note not found." };

  const quote = String(input.quote || "");
  const body = normalizeCommentBody(String(input.body || ""));
  if (!quote || !body) {
    return { ok: false, status: 400, error: "quote and body are required." };
  }

  const start = note.markdown.indexOf(quote);
  if (start === -1) {
    return { ok: false, status: 400, error: "Quoted text not found in note." };
  }

  const prefix = note.markdown.slice(Math.max(0, start - 32), start);
  const end = start + quote.length;
  const suffix = note.markdown.slice(end, end + 32);

  const anchor: CommentAnchor = { quote, prefix, suffix, start, end };
  const thread: CommentThread = {
    id: createId(10),
    resolved: false,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    anchor,
    messages: [
      {
        id: createId(10),
        parentId: null,
        authorId: "__owner__",
        authorName: actor.authorName,
        body,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      },
    ],
  };

  note.threads.push(thread);
  note.updatedAt = nowIso();
  persistNote(note);
  notesEvents.emit("threads-updated", note);
  return { ok: true, thread: { id: thread.id } };
}

export function addReply(
  input: { id: string; threadId: string; body: string; parentMessageId?: string },
  actor: Actor,
): ApiResult<Record<string, never>> {
  const note = notes.get(input.id);
  if (!note) return { ok: false, status: 404, error: "Note not found." };

  const thread = note.threads.find((t) => t.id === input.threadId);
  if (!thread) return { ok: false, status: 404, error: "Thread not found." };

  const body = normalizeCommentBody(String(input.body || ""));
  const parentMessageId = String(input.parentMessageId || thread.messages[0]?.id || "");
  if (!body) return { ok: false, status: 400, error: "body is required." };

  if (!thread.messages.some((m) => m.id === parentMessageId)) {
    return { ok: false, status: 400, error: "Parent message not found." };
  }

  const timestamp = nowIso();
  thread.messages.push({
    id: createId(10),
    parentId: parentMessageId,
    authorId: "__owner__",
    authorName: actor.authorName,
    body,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  thread.updatedAt = timestamp;
  note.updatedAt = timestamp;
  persistNote(note);
  notesEvents.emit("threads-updated", note);
  return { ok: true } as ApiOk<Record<string, never>>;
}

export function setThreadResolved(input: { id: string; threadId: string; resolved: boolean }): ApiResult<Record<string, never>> {
  const note = notes.get(input.id);
  if (!note) return { ok: false, status: 404, error: "Note not found." };
  const thread = note.threads.find((t) => t.id === input.threadId);
  if (!thread) return { ok: false, status: 404, error: "Thread not found." };
  thread.resolved = Boolean(input.resolved);
  thread.updatedAt = nowIso();
  note.updatedAt = thread.updatedAt;
  persistNote(note);
  notesEvents.emit("threads-updated", note);
  return { ok: true } as ApiOk<Record<string, never>>;
}

export function deleteThread(input: { id: string; threadId: string }): ApiResult<Record<string, never>> {
  const note = notes.get(input.id);
  if (!note) return { ok: false, status: 404, error: "Note not found." };
  note.threads = note.threads.filter((t) => t.id !== input.threadId);
  note.updatedAt = nowIso();
  persistNote(note);
  notesEvents.emit("threads-updated", note);
  return { ok: true } as ApiOk<Record<string, never>>;
}

export function editMessage(input: { id: string; messageId: string; body: string }): ApiResult<Record<string, never>> {
  const note = notes.get(input.id);
  if (!note) return { ok: false, status: 404, error: "Note not found." };
  const located = locateMessage(note, input.messageId);
  if (!located) return { ok: false, status: 404, error: "Message not found." };
  const body = normalizeCommentBody(String(input.body || ""));
  if (!body) return { ok: false, status: 400, error: "Body is required." };
  located.message.body = body;
  located.message.updatedAt = nowIso();
  located.thread.updatedAt = located.message.updatedAt;
  note.updatedAt = located.message.updatedAt;
  persistNote(note);
  notesEvents.emit("threads-updated", note);
  return { ok: true } as ApiOk<Record<string, never>>;
}

export function deleteMessage(input: { id: string; messageId: string }): ApiResult<Record<string, never>> {
  const note = notes.get(input.id);
  if (!note) return { ok: false, status: 404, error: "Note not found." };
  const located = locateMessage(note, input.messageId);
  if (!located) return { ok: false, status: 404, error: "Message not found." };
  located.thread.messages = located.thread.messages.filter((m) => m.id !== located.message.id);
  if (located.thread.messages.length === 0) {
    note.threads = note.threads.filter((t) => t.id !== located.thread.id);
  } else {
    located.thread.updatedAt = nowIso();
  }
  note.updatedAt = nowIso();
  persistNote(note);
  notesEvents.emit("threads-updated", note);
  return { ok: true } as ApiOk<Record<string, never>>;
}
