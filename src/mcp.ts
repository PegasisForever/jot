import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  type Actor,
  type ApiResult,
  type ShareAccess,
  listNotes,
  readNote,
  createNote,
  updateNote,
  deleteNote,
  applyEdits,
  addThread,
  addReply,
  setThreadResolved,
  deleteThread,
  editMessage,
  deleteMessage,
} from "./notes-api.js";

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
};

function toToolResult<T>(result: ApiResult<T>): ToolResult {
  if (!result.ok) {
    const detail = result.errors?.length ? `\n${result.errors.join("\n")}` : "";
    return { isError: true, content: [{ type: "text", text: `${result.error}${detail}` }] };
  }
  const { ok: _ok, ...rest } = result as unknown as Record<string, unknown> & { ok: true };
  return { content: [{ type: "text", text: JSON.stringify(rest, null, 2) }] };
}

const editsSchema = z.array(z.object({ oldText: z.string(), newText: z.string() }));
const shareAccessSchema = z.enum(["none", "view", "comment", "edit"]);

export function buildMcpServer(actor: Actor) {
  const server = new McpServer({ name: "jot", version: "0.1.0" });

  server.registerTool(
    "list_notes",
    {
      description: "List all notes, most recently updated first. Returns {id, title, updatedAt, shareId, snippet}.",
      inputSchema: { q: z.string().optional().describe("Optional search query matched against title and snippet.") },
    },
    async ({ q }) => toToolResult(listNotes({ q })),
  );

  server.registerTool(
    "search_notes",
    {
      description: "Search notes by title and snippet. Alias for list_notes with a required query.",
      inputSchema: { q: z.string().describe("Search query.") },
    },
    async ({ q }) => toToolResult(listNotes({ q })),
  );

  server.registerTool(
    "read_note",
    {
      description: "Read a note. Without offset/limit, returns full markdown + threads. With them, returns line-numbered slice.",
      inputSchema: {
        id: z.string(),
        offset: z.number().int().optional().describe("1-based starting line. If set with no limit, reads to end."),
        limit: z.number().int().optional().describe("Maximum number of lines to return."),
      },
    },
    async ({ id, offset, limit }) => toToolResult(readNote({ id, offset, limit })),
  );

  server.registerTool(
    "create_note",
    {
      description: "Create a new note. Optionally set title and/or initial markdown body.",
      inputSchema: {
        title: z.string().optional(),
        markdown: z.string().optional(),
      },
    },
    async ({ title, markdown }) => {
      const created = createNote();
      if (!created.ok) return toToolResult(created);
      if (title !== undefined || markdown !== undefined) {
        const updated = updateNote({ id: created.note.id, title, markdown });
        if (!updated.ok) return toToolResult(updated);
      }
      return toToolResult({ ok: true, note: created.note });
    },
  );

  server.registerTool(
    "update_note",
    {
      description: "Update a note's title and/or markdown body. Pass only the fields you want to change.",
      inputSchema: {
        id: z.string(),
        title: z.string().optional(),
        markdown: z.string().optional(),
      },
    },
    async ({ id, title, markdown }) => toToolResult(updateNote({ id, title, markdown })),
  );

  server.registerTool(
    "delete_note",
    {
      description: "Delete a note and all its threads.",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => toToolResult(deleteNote({ id })),
  );

  server.registerTool(
    "edit_note",
    {
      description: "Apply oldText/newText edits to a note's markdown. Each oldText must occur exactly once.",
      inputSchema: {
        id: z.string(),
        edits: editsSchema,
      },
    },
    async ({ id, edits }) => toToolResult(applyEdits({ id, edits })),
  );

  server.registerTool(
    "share_note",
    {
      description: "Set a note's share access level. 'none' disables sharing; 'view'/'comment'/'edit' grant progressively more access via the share link.",
      inputSchema: {
        id: z.string(),
        access: shareAccessSchema,
      },
    },
    async ({ id, access }) => toToolResult(updateNote({ id, shareAccess: access as ShareAccess })),
  );

  server.registerTool(
    "add_comment",
    {
      description: "Add a new comment thread anchored to a quoted span of the note's markdown. The quote must appear exactly once.",
      inputSchema: {
        id: z.string(),
        quote: z.string().describe("Text from the note that the comment anchors to."),
        body: z.string().describe("The comment body."),
      },
    },
    async ({ id, quote, body }) => toToolResult(addThread({ id, quote, body }, actor)),
  );

  server.registerTool(
    "reply_to_comment",
    {
      description: "Reply to an existing comment in a thread.",
      inputSchema: {
        id: z.string(),
        threadId: z.string(),
        body: z.string(),
        parentMessageId: z.string().optional().describe("Defaults to the first message in the thread."),
      },
    },
    async ({ id, threadId, body, parentMessageId }) => toToolResult(addReply({ id, threadId, body, parentMessageId }, actor)),
  );

  server.registerTool(
    "resolve_thread",
    {
      description: "Mark a comment thread as resolved.",
      inputSchema: { id: z.string(), threadId: z.string() },
    },
    async ({ id, threadId }) => toToolResult(setThreadResolved({ id, threadId, resolved: true })),
  );

  server.registerTool(
    "reopen_thread",
    {
      description: "Mark a previously-resolved thread as unresolved.",
      inputSchema: { id: z.string(), threadId: z.string() },
    },
    async ({ id, threadId }) => toToolResult(setThreadResolved({ id, threadId, resolved: false })),
  );

  server.registerTool(
    "delete_thread",
    {
      description: "Delete a comment thread and all its messages.",
      inputSchema: { id: z.string(), threadId: z.string() },
    },
    async ({ id, threadId }) => toToolResult(deleteThread({ id, threadId })),
  );

  server.registerTool(
    "edit_comment",
    {
      description: "Edit the body of an existing comment message.",
      inputSchema: { id: z.string(), messageId: z.string(), body: z.string() },
    },
    async ({ id, messageId, body }) => toToolResult(editMessage({ id, messageId, body })),
  );

  server.registerTool(
    "delete_comment",
    {
      description: "Delete a single comment message. If it was the last message in the thread, the thread is also deleted.",
      inputSchema: { id: z.string(), messageId: z.string() },
    },
    async ({ id, messageId }) => toToolResult(deleteMessage({ id, messageId })),
  );

  return server;
}
