import { applyConversationListPatch } from "./conversationListStream";
import type { ConversationWithState } from "../types";

function conv(id: string, slug: string, working = false): ConversationWithState {
  return {
    conversation_id: id,
    slug,
    user_initiated: true,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    cwd: null,
    archived: false,
    parent_conversation_id: null,
    model: null,
    conversation_options: "{}",
    current_generation: 0,
    agent_working: working,
    tags: "[]",
    is_draft: false,
    draft: "",
    working,
    subagent_count: 0,
    max_sequence_id: 0,
  };
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

function run(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    throw err;
  }
}

run("replace root", () => {
  const next = applyConversationListPatch(
    [],
    [{ op: "replace", path: "", value: [conv("a", "alpha")] }],
  );
  assert(next.length === 1, "expected one conversation");
  assert(next[0].slug === "alpha", "expected replaced root value");
});

run("add, replace field, remove", () => {
  let state = [conv("a", "alpha")];
  state = applyConversationListPatch(state, [{ op: "add", path: "/0", value: conv("b", "beta") }]);
  assert(state.map((c) => c.conversation_id).join(",") === "b,a", "expected inserted item");

  state = applyConversationListPatch(state, [{ op: "replace", path: "/1/working", value: true }]);
  assert(state[1].working, "expected field replacement");

  state = applyConversationListPatch(state, [{ op: "remove", path: "/0" }]);
  assert(state.length === 1 && state[0].conversation_id === "a", "expected removal");
});

run("move", () => {
  const state = applyConversationListPatch(
    [conv("a", "alpha"), conv("b", "beta")],
    [{ op: "move", from: "/1", path: "/0" }],
  );
  assert(state.map((c) => c.conversation_id).join(",") === "b,a", "expected moved item");
});

run("json pointer escaping", () => {
  const state = applyConversationListPatch(
    [{ ...conv("a", "alpha"), git_subject: "old" }],
    [{ op: "replace", path: "/0/git_subject", value: "slash / tilde ~ ok" }],
  );
  assert(state[0].git_subject === "slash / tilde ~ ok", "expected escaped path support");
});

run("throws on add past array end", () => {
  let threw = false;
  try {
    applyConversationListPatch([], [{ op: "add", path: "/5", value: conv("a", "a") }]);
  } catch (err) {
    threw = true;
    assert(err instanceof Error && /bad array index/.test(err.message), `unexpected error: ${err}`);
    assert(
      err instanceof Error && /len=/.test(err.message),
      "expected error message to include array length context",
    );
  }
  assert(threw, "expected applyConversationListPatch to throw");
});

run("throws on replace at missing index", () => {
  let threw = false;
  try {
    applyConversationListPatch(
      [conv("a", "a")],
      [{ op: "replace", path: "/5", value: conv("b", "b") }],
    );
  } catch (err) {
    threw = true;
    assert(
      err instanceof Error && /(out of range|bad array index)/.test(err.message),
      `unexpected error: ${err}`,
    );
  }
  assert(threw, "expected applyConversationListPatch to throw");
});

run("throws on remove at missing index", () => {
  let threw = false;
  try {
    applyConversationListPatch([], [{ op: "remove", path: "/0" }]);
  } catch (err) {
    threw = true;
    assert(err instanceof Error && /bad array index/.test(err.message), `unexpected error: ${err}`);
  }
  assert(threw, "expected applyConversationListPatch to throw");
});

run("does not mutate the input list", () => {
  const original = [conv("a", "alpha"), conv("b", "beta")];
  const snapshot = JSON.stringify(original);
  const next = applyConversationListPatch(original, [
    { op: "replace", path: "/0/working", value: true },
    { op: "remove", path: "/1" },
  ]);
  assert(JSON.stringify(original) === snapshot, "expected input list to be untouched");
  assert(next.length === 1 && next[0].working === true, "expected new list to reflect patch");
});

run("add, move, replace, remove stress sequence", () => {
  // Deterministic LCG so this isn't flaky and we can extend it later.
  let s = 0x12345;
  const rand = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s;
  };
  let state: ConversationWithState[] = [];
  let nextId = 0;
  const id = () => `id-${nextId++}`;
  for (let step = 0; step < 500; step++) {
    const op = rand() % 4;
    if (op === 0 || state.length === 0) {
      const at = state.length === 0 ? 0 : rand() % (state.length + 1);
      state = applyConversationListPatch(state, [
        { op: "add", path: `/${at}`, value: conv(id(), "x") },
      ]);
    } else if (op === 1) {
      const at = rand() % state.length;
      state = applyConversationListPatch(state, [{ op: "remove", path: `/${at}` }]);
    } else if (op === 2) {
      const at = rand() % state.length;
      state = applyConversationListPatch(state, [
        { op: "replace", path: `/${at}/working`, value: state[at].working ? false : true },
      ]);
    } else {
      if (state.length < 2) continue;
      const from = rand() % state.length;
      let to = rand() % state.length;
      if (to === from) to = (to + 1) % state.length;
      state = applyConversationListPatch(state, [{ op: "move", from: `/${from}`, path: `/${to}` }]);
    }
  }
  // Reach the end without throwing.
  assert(Array.isArray(state), "expected final state to be an array");
});

console.log("\nConversationListStream tests passed");
