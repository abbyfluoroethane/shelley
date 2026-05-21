// messageStore.ts — IndexedDB-backed per-message cache plus an in-memory
// layer for transient streaming state (tool progress, stream deltas, agent
// working). Components subscribe by conversation_id (or globally) to receive
// updates. Stream events from globalStream.ts flow in via the apply* methods.
//
// Persistence model: write-behind, but per-call atomic. Each public mutator
// updates the in-memory hot map and notifies listeners synchronously, then
// kicks off a single IDB readwrite transaction. The transaction does a true
// read-modify-write of the conversation_meta row in the same tx as the
// message puts, so concurrent writers (other tabs / store instances) cannot
// lose `max_sequence_id_local`.
//
// DB schema v3:
//   messages          — keyPath [conversation_id, sequence_id], one row per
//                       message. Range queries by conversation use a keyed
//                       bound on the compound key — no secondary index.
//   conversation_meta — keyPath conversation_id, metadata + sequence bookmarks.

import { openDB, IDBPDatabase, DBSchema, OpenDBCallbacks } from "idb";
import type { Message, Conversation, StreamResponse, ToolProgress } from "../types";

const DEFAULT_DB_NAME = "shelley-messages";
const DB_VERSION = 3;

// ─── IDB schema ─────────────────────────────────────────────────────────────

/** One row per message in the `messages` store. Identical shape to Message. */
type MessageRow = Message;

/** One row per conversation in the `conversation_meta` store. */
interface ConvMetaRow {
  conversation_id: string;
  conversation: Conversation | null;
  context_window_size: number;
  /** Server-reported maximum sequence_id (from stream or list response). */
  max_sequence_id_known: number;
  /** Highest sequence_id we have locally cached. */
  max_sequence_id_local: number;
  /** True once a full REST GET has been merged in successfully. */
  has_full_history: boolean;
  updated_at: number;
}

interface ShelleyDB extends DBSchema {
  messages: {
    key: [string, number];
    value: MessageRow;
    indexes: {
      by_message_id: string;
    };
  };
  conversation_meta: {
    key: string;
    value: ConvMetaRow;
  };
}

// ─── Public in-memory aggregate shape ────────────────────────────────────────

/** In-memory aggregate returned by peek(). NOT the IDB row shape. */
export interface ConversationCacheRecord {
  conversation_id: string;
  messages: Message[];
  conversation: Conversation | null;
  contextWindowSize: number;
  minSequenceId: number;
  maxSequenceId: number;
  /** Server-reported max sequence_id (from stream events or conversation list). */
  maxSequenceIdKnown: number;
  hasFullHistory: boolean;
  updatedAt: number;
}

// ─── Transient (non-persisted) state ─────────────────────────────────────────

export interface TransientState {
  toolProgress: Record<string, ToolProgress>;
  streamingText: string;
  agentWorking: boolean;
}

function emptyTransient(): TransientState {
  return { toolProgress: {}, streamingText: "", agentWorking: false };
}

function emptyRecord(id: string): ConversationCacheRecord {
  return {
    conversation_id: id,
    messages: [],
    conversation: null,
    contextWindowSize: 0,
    minSequenceId: 0,
    maxSequenceId: -1,
    maxSequenceIdKnown: 0,
    hasFullHistory: false,
    updatedAt: Date.now(),
  };
}

function convRange(id: string): IDBKeyRange {
  return IDBKeyRange.bound([id, Number.NEGATIVE_INFINITY], [id, Number.POSITIVE_INFINITY]);
}

type Listener = () => void;

// ─── MessageStore ─────────────────────────────────────────────────────────────

export interface MessageStoreOptions {
  dbName?: string;
  /**
   * Custom IDBFactory used in place of the global `indexedDB`. The `idb`
   * library reads `globalThis.indexedDB` directly, so when this is
   * provided we temporarily swap the global during openDB(). Tests use
   * this; production callers shouldn't need to.
   */
  factory?: IDBFactory;
}

export class MessageStore {
  private readonly dbName: string;
  private readonly factory: IDBFactory | undefined;
  private dbPromise: Promise<IDBPDatabase<ShelleyDB>> | null = null;
  private hot = new Map<string, ConversationCacheRecord>();
  private transient = new Map<string, TransientState>();
  private hydrated = new Set<string>();
  private listenersById = new Map<string, Set<Listener>>();
  private transientListenersById = new Map<string, Set<Listener>>();
  private allListeners = new Set<Listener>();
  /** Pending write-behind operations. `settle()` awaits these. */
  private inflight = new Set<Promise<unknown>>();

  constructor(opts: MessageStoreOptions = {}) {
    this.dbName = opts.dbName ?? DEFAULT_DB_NAME;
    this.factory = opts.factory ?? (typeof indexedDB !== "undefined" ? indexedDB : undefined);
  }

  // ── DB open ────────────────────────────────────────────────────────────────

  private db(): Promise<IDBPDatabase<ShelleyDB>> {
    if (!this.factory) return Promise.reject(new Error("indexedDB unavailable"));
    if (!this.dbPromise) {
      this.dbPromise = this.openWithFactory().catch((err) => {
        this.dbPromise = null;
        throw err;
      });
    }
    return this.dbPromise;
  }

  private async openWithFactory(): Promise<IDBPDatabase<ShelleyDB>> {
    const callbacks: OpenDBCallbacks<ShelleyDB> = {
      upgrade(db, oldVersion) {
        // Drop old v1 "conversations" store if present (cache only — no data loss).
        if (db.objectStoreNames.contains("conversations" as never)) {
          db.deleteObjectStore("conversations" as never);
        }
        // v2 introduced the messages + conversation_meta layout but with a
        // redundant `by_conv` index. v3 drops that index by recreating the
        // store (cache only — no data loss). Always create the v3 layout.
        if (db.objectStoreNames.contains("messages")) {
          db.deleteObjectStore("messages");
        }
        const msgStore = db.createObjectStore("messages", {
          keyPath: ["conversation_id", "sequence_id"],
        });
        msgStore.createIndex("by_message_id", "message_id", { unique: true });
        if (!db.objectStoreNames.contains("conversation_meta")) {
          db.createObjectStore("conversation_meta", {
            keyPath: "conversation_id",
          });
        }
        void oldVersion;
      },
      // Another tab requested an upgrade — close and forget the cached
      // connection so the next db() call reopens at the new version.
      blocking: (_oldVersion, _newVersion, event) => {
        const target = event.target as IDBPDatabase<ShelleyDB> | null;
        if (target) target.close();
        this.dbPromise = null;
      },
    };
    const globalFactory = typeof indexedDB !== "undefined" ? indexedDB : undefined;
    if (this.factory === globalFactory) {
      return openDB<ShelleyDB>(this.dbName, DB_VERSION, callbacks);
    }
    // Test path: a custom factory was injected. `idb` reads
    // `globalThis.indexedDB` directly, so temporarily swap it.
    const g = globalThis as { indexedDB?: IDBFactory };
    const prev = g.indexedDB;
    g.indexedDB = this.factory;
    try {
      return await openDB<ShelleyDB>(this.dbName, DB_VERSION, callbacks);
    } finally {
      g.indexedDB = prev;
    }
  }

  /** Close (and forget) the underlying connection. Tests use this. */
  async close(): Promise<void> {
    await this.settle();
    if (!this.dbPromise) return;
    try {
      const db = await this.dbPromise;
      db.close();
    } catch {
      // ignore
    } finally {
      this.dbPromise = null;
    }
  }

  /** Wait until all write-behind operations have completed. */
  async settle(): Promise<void> {
    while (this.inflight.size > 0) {
      const pending = Array.from(this.inflight);
      await Promise.allSettled(pending);
    }
  }

  /** Track a write-behind promise so `settle()` can await it. */
  private track<T>(p: Promise<T>): Promise<T> {
    this.inflight.add(p);
    const done = () => {
      this.inflight.delete(p);
    };
    p.then(done, done);
    return p;
  }

  // ── Hydrate ────────────────────────────────────────────────────────────────

  /** Load a conversation from IDB into the hot cache if not already loaded. */
  async hydrate(id: string): Promise<ConversationCacheRecord | null> {
    if (this.hydrated.has(id)) {
      return this.hot.get(id) ?? null;
    }
    let rec: ConversationCacheRecord | null = null;
    try {
      const db = await this.db();
      const meta = await db.get("conversation_meta", id);
      if (meta) {
        // getAll on the compound key range returns rows in ascending
        // (conv, seq) order — no JS sort needed.
        const rows = await db.getAll("messages", convRange(id));
        const minSeq = rows.length > 0 ? rows[0].sequence_id : 0;
        const maxSeq = rows.length > 0 ? rows[rows.length - 1].sequence_id : -1;
        rec = {
          conversation_id: id,
          messages: rows,
          conversation: meta.conversation,
          contextWindowSize: meta.context_window_size,
          minSequenceId: minSeq,
          maxSequenceId: maxSeq,
          maxSequenceIdKnown: meta.max_sequence_id_known,
          hasFullHistory: meta.has_full_history,
          updatedAt: meta.updated_at,
        };
      }
    } catch (err) {
      console.warn("messageStore.hydrate: IDB read failed:", err);
    }
    this.hydrated.add(id);
    if (rec) {
      this.hot.set(id, rec);
      this.notify(id);
    }
    return rec;
  }

  // ── Peek / isHydrated ──────────────────────────────────────────────────────

  peek(id: string): ConversationCacheRecord | null {
    return this.hot.get(id) ?? null;
  }

  isHydrated(id: string): boolean {
    return this.hydrated.has(id);
  }

  // ── Transient ──────────────────────────────────────────────────────────────

  getTransient(id: string): TransientState {
    let t = this.transient.get(id);
    if (!t) {
      t = emptyTransient();
      this.transient.set(id, t);
    }
    return t;
  }

  // ── needsBackfill ──────────────────────────────────────────────────────────

  needsBackfill(id: string): boolean {
    const rec = this.hot.get(id);
    return !rec || !rec.hasFullHistory;
  }

  // ── upsertMessages ─────────────────────────────────────────────────────────

  /** Merge a batch of messages into the per-conv cache (streaming upsert). */
  upsertMessages(id: string, incoming: Message[]): void {
    if (incoming.length === 0) return;
    const rec = this.hot.get(id) ?? emptyRecord(id);
    const byMsgId = new Map<string, Message>();
    for (const m of rec.messages) byMsgId.set(m.message_id, m);
    for (const m of incoming) byMsgId.set(m.message_id, m);

    // Rebuild sorted array (dedup by message_id, sort by sequence_id).
    const merged = Array.from(byMsgId.values()).sort((a, b) => a.sequence_id - b.sequence_id);
    rec.messages = merged;
    if (merged.length > 0) {
      rec.minSequenceId = merged[0].sequence_id;
      rec.maxSequenceId = merged[merged.length - 1].sequence_id;
    }
    rec.updatedAt = Date.now();
    this.hot.set(id, rec);
    this.hydrated.add(id);
    this.notify(id);

    // Snapshot what to persist; do not rely on hot record mutating between now
    // and when the tx runs.
    const snapshotIncoming = incoming.slice();
    const snapshotKnown = rec.maxSequenceIdKnown;
    const snapshotConv = rec.conversation;
    const snapshotCtx = rec.contextWindowSize;
    this.track(
      this._persistUpsert(id, snapshotIncoming, snapshotKnown, snapshotConv, snapshotCtx),
    ).catch((err) => console.warn("messageStore.upsertMessages: persist failed:", err));
  }

  private async _persistUpsert(
    id: string,
    incoming: Message[],
    knownHint: number,
    convHint: Conversation | null,
    ctxHint: number,
  ): Promise<void> {
    const db = await this.db();
    const tx = db.transaction(["messages", "conversation_meta"], "readwrite");
    const msgs = tx.objectStore("messages");
    const metaStore = tx.objectStore("conversation_meta");
    const existing = await metaStore.get(id);
    let maxLocal = existing?.max_sequence_id_local ?? -1;
    const idIdx = msgs.index("by_message_id");
    for (const m of incoming) {
      // A regenerated turn keeps the same message_id but moves to a new
      // sequence_id. The unique by_message_id index would otherwise reject
      // the put, so explicitly delete any prior row for this message_id
      // at a different seq before writing.
      const priorKey = await idIdx.getKey(m.message_id);
      if (priorKey && (priorKey[0] !== m.conversation_id || priorKey[1] !== m.sequence_id)) {
        await msgs.delete(priorKey);
      }
      await msgs.put(m);
      if (m.sequence_id > maxLocal) maxLocal = m.sequence_id;
    }
    const row: ConvMetaRow = {
      conversation_id: id,
      conversation: convHint ?? existing?.conversation ?? null,
      context_window_size:
        existing?.context_window_size && existing.context_window_size > 0
          ? existing.context_window_size
          : ctxHint,
      max_sequence_id_known: Math.max(
        existing?.max_sequence_id_known ?? 0,
        knownHint,
        maxLocal < 0 ? 0 : maxLocal,
      ),
      max_sequence_id_local: maxLocal,
      has_full_history: existing?.has_full_history ?? false,
      updated_at: Date.now(),
    };
    await metaStore.put(row);
    await tx.done;
  }

  // ── applyFullHistory ───────────────────────────────────────────────────────

  /** Replace cached state with the full REST response. */
  applyFullHistory(id: string, response: StreamResponse): void {
    const messages = (response.messages ?? [])
      .slice()
      .sort((a, b) => a.sequence_id - b.sequence_id);
    const minSeq = messages.length > 0 ? messages[0].sequence_id : 0;
    const maxSeq = messages.length > 0 ? messages[messages.length - 1].sequence_id : -1;
    const existing = this.hot.get(id);
    const responseKnown =
      typeof response.max_sequence_id === "number" ? response.max_sequence_id : 0;
    const knownAfter = Math.max(
      existing?.maxSequenceIdKnown ?? 0,
      responseKnown,
      maxSeq < 0 ? 0 : maxSeq,
    );
    const rec: ConversationCacheRecord = {
      conversation_id: id,
      messages,
      conversation: response.conversation ?? existing?.conversation ?? null,
      contextWindowSize: response.context_window_size ?? existing?.contextWindowSize ?? 0,
      minSequenceId: minSeq,
      maxSequenceId: maxSeq,
      maxSequenceIdKnown: knownAfter,
      hasFullHistory: true,
      updatedAt: Date.now(),
    };
    this.hot.set(id, rec);
    this.hydrated.add(id);
    this.notify(id);

    this.track(this._persistFullHistory(id, rec)).catch((err) =>
      console.warn("messageStore.applyFullHistory: persist failed:", err),
    );
  }

  private async _persistFullHistory(id: string, rec: ConversationCacheRecord): Promise<void> {
    const db = await this.db();
    const tx = db.transaction(["messages", "conversation_meta"], "readwrite");
    const msgs = tx.objectStore("messages");
    const metaStore = tx.objectStore("conversation_meta");
    const existing = await metaStore.get(id);
    // Replace semantics: drop everything for this conversation, then bulk put.
    await msgs.delete(convRange(id));
    for (const m of rec.messages) {
      await msgs.put(m);
    }
    const row: ConvMetaRow = {
      conversation_id: id,
      conversation: rec.conversation ?? existing?.conversation ?? null,
      context_window_size: rec.contextWindowSize,
      max_sequence_id_known: Math.max(existing?.max_sequence_id_known ?? 0, rec.maxSequenceIdKnown),
      // Ratchet against any concurrent writer that pushed local higher.
      // Messages were just replaced with rec.messages, so disk content
      // matches rec.maxSequenceId; but the bookkeeping field tracks the
      // high-water mark across writers (other tabs streaming live events).
      max_sequence_id_local: Math.max(existing?.max_sequence_id_local ?? -1, rec.maxSequenceId),
      has_full_history: true,
      updated_at: Date.now(),
    };
    await metaStore.put(row);
    await tx.done;
  }

  // ── setConversation ────────────────────────────────────────────────────────

  setConversation(id: string, conv: Conversation): void {
    const rec = this.hot.get(id) ?? emptyRecord(id);
    rec.conversation = conv;
    rec.updatedAt = Date.now();
    this.hot.set(id, rec);
    this.hydrated.add(id);
    this.notify(id);
    this.track(this._patchMeta(id, { conversation: conv })).catch((err) =>
      console.warn("messageStore.setConversation: persist failed:", err),
    );
  }

  // ── setContextWindowSize ───────────────────────────────────────────────────

  setContextWindowSize(id: string, size: number): void {
    const rec = this.hot.get(id) ?? emptyRecord(id);
    if (rec.contextWindowSize === size) return;
    rec.contextWindowSize = size;
    rec.updatedAt = Date.now();
    this.hot.set(id, rec);
    this.hydrated.add(id);
    this.notify(id);
    this.track(this._patchMeta(id, { context_window_size: size })).catch((err) =>
      console.warn("messageStore.setContextWindowSize: persist failed:", err),
    );
  }

  // ── setMaxSequenceIdKnown ──────────────────────────────────────────────────

  /**
   * Update the server-reported max sequence_id for a conversation.
   * Called by globalStream when StreamResponse.max_sequence_id > 0,
   * and by App when the conversation list is loaded or patched.
   */
  setMaxSequenceIdKnown(id: string, maxSeq: number): void {
    if (maxSeq <= 0) return;
    const rec = this.hot.get(id) ?? emptyRecord(id);
    if (rec.maxSequenceIdKnown >= maxSeq) return;
    rec.maxSequenceIdKnown = maxSeq;
    rec.updatedAt = Date.now();
    this.hot.set(id, rec);
    this.hydrated.add(id);
    this.notify(id);
    this.track(this._patchMeta(id, { max_sequence_id_known: maxSeq })).catch((err) =>
      console.warn("messageStore.setMaxSequenceIdKnown: persist failed:", err),
    );
  }

  /**
   * Read-modify-write patch of a conversation_meta row. Ratcheting fields
   * (max_sequence_id_known, max_sequence_id_local) use Math.max against the
   * persisted value so a concurrent writer cannot regress them.
   */
  private async _patchMeta(
    id: string,
    patch: Partial<
      Pick<
        ConvMetaRow,
        | "conversation"
        | "context_window_size"
        | "max_sequence_id_known"
        | "max_sequence_id_local"
        | "has_full_history"
      >
    >,
  ): Promise<void> {
    const db = await this.db();
    const tx = db.transaction("conversation_meta", "readwrite");
    const store = tx.store;
    const existing = await store.get(id);
    const base: ConvMetaRow = existing ?? {
      conversation_id: id,
      conversation: null,
      context_window_size: 0,
      max_sequence_id_known: 0,
      max_sequence_id_local: -1,
      has_full_history: false,
      updated_at: 0,
    };
    const row: ConvMetaRow = {
      ...base,
      ...patch,
      max_sequence_id_known:
        patch.max_sequence_id_known !== undefined
          ? Math.max(base.max_sequence_id_known, patch.max_sequence_id_known)
          : base.max_sequence_id_known,
      max_sequence_id_local:
        patch.max_sequence_id_local !== undefined
          ? Math.max(base.max_sequence_id_local, patch.max_sequence_id_local)
          : base.max_sequence_id_local,
      updated_at: Date.now(),
    };
    await store.put(row);
    await tx.done;
  }

  // ── Transient helpers ──────────────────────────────────────────────────────

  setToolProgress(id: string, p: ToolProgress): void {
    const t = this.getTransient(id);
    t.toolProgress = { ...t.toolProgress, [p.tool_use_id]: p };
    this.notifyTransient(id);
  }

  clearToolProgress(id: string, toolUseIds: string[]): void {
    if (toolUseIds.length === 0) return;
    const t = this.getTransient(id);
    let changed = false;
    const next = { ...t.toolProgress };
    for (const k of toolUseIds) {
      if (k in next) {
        delete next[k];
        changed = true;
      }
    }
    if (!changed) return;
    t.toolProgress = next;
    this.notifyTransient(id);
  }

  appendStreamDelta(id: string, text: string): void {
    if (!text) return;
    const t = this.getTransient(id);
    t.streamingText = t.streamingText + text;
    this.notifyTransient(id);
  }

  resetStreamingText(id: string): void {
    const t = this.getTransient(id);
    if (!t.streamingText) return;
    t.streamingText = "";
    this.notifyTransient(id);
  }

  setAgentWorking(id: string, working: boolean): void {
    const t = this.getTransient(id);
    if (t.agentWorking === working) return;
    t.agentWorking = working;
    this.notifyTransient(id);
  }

  resetTransient(id: string): void {
    this.transient.set(id, emptyTransient());
    this.notifyTransient(id);
  }

  // ── markAllStale ───────────────────────────────────────────────────────────

  /**
   * Mark every cached conversation as stale (hasFullHistory=false).
   * Called after a global-stream reconnect to ensure the next focus
   * triggers a REST backfill. Messages on disk are preserved.
   */
  markAllStale(): void {
    const dirty: string[] = [];
    for (const rec of this.hot.values()) {
      if (rec.hasFullHistory) {
        rec.hasFullHistory = false;
        rec.updatedAt = Date.now();
        dirty.push(rec.conversation_id);
        const set = this.listenersById.get(rec.conversation_id);
        if (set) for (const cb of set) cb();
      }
    }
    if (dirty.length > 0) {
      for (const cb of this.allListeners) cb();
      for (const id of dirty) {
        this.track(this._patchMeta(id, { has_full_history: false })).catch((err) =>
          console.warn("messageStore.markAllStale: persist failed:", err),
        );
      }
    }
  }

  // ── delete ─────────────────────────────────────────────────────────────────

  async delete(id: string): Promise<void> {
    this.hot.delete(id);
    this.transient.delete(id);
    this.hydrated.delete(id);
    this.notify(id);
    // Wait for any in-flight write-behind ops for this conversation to
    // settle before deleting, so a slow upsert can't race past us and
    // recreate rows after the delete.
    await this.settle();
    const p = (async () => {
      const db = await this.db();
      const tx = db.transaction(["messages", "conversation_meta"], "readwrite");
      await tx.objectStore("messages").delete(convRange(id));
      await tx.objectStore("conversation_meta").delete(id);
      await tx.done;
    })();
    this.track(p).catch(() => {});
    try {
      await p;
    } catch (err) {
      console.warn("messageStore.delete: IDB delete failed:", err);
    }
  }

  // ── pruneStale ─────────────────────────────────────────────────────────────

  /**
   * Delete cached rows for conversations that are no longer in the active
   * set (i.e. the server's conversation list) and whose meta row hasn't
   * been touched in `olderThanMs`. Intended for archived/forgotten
   * conversations so the IDB cache doesn't grow without bound.
   *
   * `activeIds` is the set of conversation_ids currently known to the
   * server. Anything outside that set whose `updated_at < now - olderThanMs`
   * is dropped (both messages and meta).
   *
   * Returns the list of pruned conversation_ids.
   */
  async pruneStale(activeIds: Iterable<string>, olderThanMs: number): Promise<string[]> {
    if (!this.factory) return [];
    const active = new Set(activeIds);
    const cutoff = Date.now() - olderThanMs;
    let toPrune: string[];
    try {
      const db = await this.db();
      const metas = await db.getAll("conversation_meta");
      toPrune = metas
        .filter((m) => !active.has(m.conversation_id) && m.updated_at < cutoff)
        .map((m) => m.conversation_id);
    } catch (err) {
      console.warn("messageStore.pruneStale: scan failed:", err);
      return [];
    }
    const pruned: string[] = [];
    for (const id of toPrune) {
      try {
        // Settle any in-flight writes for this conv so we don't race a
        // concurrent upsert (e.g. a live stream event landing during prune).
        await this.settle();
        const db = await this.db();
        const tx = db.transaction(["messages", "conversation_meta"], "readwrite");
        // Re-read the meta row INSIDE the prune tx and verify it's still
        // stale. If a stream event upserted it after our scan, skip.
        const meta = await tx.objectStore("conversation_meta").get(id);
        if (!meta || meta.updated_at >= cutoff) {
          await tx.done;
          continue;
        }
        await tx.objectStore("messages").delete(convRange(id));
        await tx.objectStore("conversation_meta").delete(id);
        await tx.done;
        // Drop from hot map AFTER the tx commits so a racing
        // upsert that landed mid-delete can immediately repopulate.
        this.hot.delete(id);
        this.transient.delete(id);
        this.hydrated.delete(id);
        this.notify(id);
        pruned.push(id);
      } catch (err) {
        console.warn("messageStore.pruneStale: delete failed for", id, err);
      }
    }
    return pruned;
  }

  // ── clear ──────────────────────────────────────────────────────────────────

  async clear(): Promise<void> {
    await this.settle();
    this.hot.clear();
    this.transient.clear();
    this.hydrated.clear();
    try {
      const db = await this.db();
      const tx = db.transaction(["messages", "conversation_meta"], "readwrite");
      await tx.objectStore("messages").clear();
      await tx.objectStore("conversation_meta").clear();
      await tx.done;
    } catch (err) {
      console.warn("messageStore.clear: IDB clear failed:", err);
    }
    for (const cbs of this.listenersById.values()) {
      for (const cb of cbs) cb();
    }
    for (const cb of this.allListeners) cb();
  }

  // ── Subscribe ──────────────────────────────────────────────────────────────

  subscribe(id: string, cb: Listener): () => void {
    let set = this.listenersById.get(id);
    if (!set) {
      set = new Set();
      this.listenersById.set(id, set);
    }
    set.add(cb);
    return () => {
      set!.delete(cb);
      if (set!.size === 0) this.listenersById.delete(id);
    };
  }

  subscribeTransient(id: string, cb: Listener): () => void {
    let set = this.transientListenersById.get(id);
    if (!set) {
      set = new Set();
      this.transientListenersById.set(id, set);
    }
    set.add(cb);
    return () => {
      set!.delete(cb);
      if (set!.size === 0) this.transientListenersById.delete(id);
    };
  }

  subscribeAll(cb: Listener): () => void {
    this.allListeners.add(cb);
    return () => {
      this.allListeners.delete(cb);
    };
  }

  // ── Notify helpers ─────────────────────────────────────────────────────────

  private notify(id: string): void {
    const set = this.listenersById.get(id);
    if (set) for (const cb of set) cb();
    for (const cb of this.allListeners) cb();
  }

  private notifyTransient(id: string): void {
    const set = this.transientListenersById.get(id);
    if (set) for (const cb of set) cb();
  }
}

export const messageStore = new MessageStore();
