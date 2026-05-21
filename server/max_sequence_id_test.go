package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// TestMaxSequenceIDInConversationsList: /api/conversations rows expose
// max_sequence_id matching the latest message sequence_id.
func TestMaxSequenceIDInConversationsList(t *testing.T) {
	t.Parallel()
	database, cleanup := setupTestDB(t)
	t.Cleanup(cleanup)
	convID := seedConversation(t, database, 3)

	_, srv := newTestStreamServer(t, database)

	req := httptest.NewRequest("GET", "/api/conversations", nil)
	w := httptest.NewRecorder()
	srv.handleConversations(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var convs []ConversationWithState
	if err := json.Unmarshal(w.Body.Bytes(), &convs); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	var found *ConversationWithState
	for i := range convs {
		if convs[i].ConversationID == convID {
			found = &convs[i]
			break
		}
	}
	if found == nil {
		t.Fatalf("conversation %s not in list", convID)
	}

	// Cross-check via the bulk per-conv query.
	maxSeqs, err := database.GetMaxSequenceIDsForAllConversations(context.Background())
	if err != nil {
		t.Fatalf("GetMaxSequenceIDsForAllConversations: %v", err)
	}
	maxSeq := maxSeqs[convID]
	if maxSeq <= 0 {
		t.Fatalf("expected positive maxSeq, got %d", maxSeq)
	}
	if found.MaxSequenceID != maxSeq {
		t.Fatalf("max_sequence_id mismatch: got %d want %d", found.MaxSequenceID, maxSeq)
	}
}

// TestMaxSequenceIDOnGetConversation: GET /api/conversation/<id> returns a
// max_sequence_id matching the highest sequence_id across the returned
// messages.
func TestMaxSequenceIDOnGetConversation(t *testing.T) {
	t.Parallel()
	database, cleanup := setupTestDB(t)
	t.Cleanup(cleanup)
	convID := seedConversation(t, database, 4)

	_, srv := newTestStreamServer(t, database)

	req := httptest.NewRequest("GET", "/api/conversation/"+convID, nil)
	w := httptest.NewRecorder()
	srv.handleGetConversation(w, req, convID)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp StreamResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(resp.Messages) == 0 {
		t.Fatalf("expected messages, got none")
	}
	var want int64
	for _, m := range resp.Messages {
		if m.SequenceID > want {
			want = m.SequenceID
		}
	}
	if resp.MaxSequenceID != want {
		t.Fatalf("max_sequence_id mismatch: got %d want %d", resp.MaxSequenceID, want)
	}
}
