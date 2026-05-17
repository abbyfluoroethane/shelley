package llm

import (
	"net/http"
	"testing"
	"time"
)

func TestParseRetryAfter(t *testing.T) {
	tests := []struct {
		in   string
		want time.Duration
		// when in is an HTTP-date we can't predict exactly; minWant is a lower bound and 0 means "no bound".
	}{
		{"", 0},
		{"0", 0},
		{"7", 7 * time.Second},
		{"60", 60 * time.Second},
		{"-1", 0},
		{"garbage", 0},
	}
	for _, tc := range tests {
		if got := ParseRetryAfter(tc.in); got != tc.want {
			t.Errorf("ParseRetryAfter(%q) = %v, want %v", tc.in, got, tc.want)
		}
	}

	// HTTP-date: ~30s in the future.
	future := time.Now().Add(30 * time.Second).UTC().Format(http.TimeFormat)
	got := ParseRetryAfter(future)
	if got < 25*time.Second || got > 35*time.Second {
		t.Errorf("ParseRetryAfter(future date) = %v, want ~30s", got)
	}

	// HTTP-date in the past should return 0.
	past := time.Now().Add(-time.Hour).UTC().Format(http.TimeFormat)
	if got := ParseRetryAfter(past); got != 0 {
		t.Errorf("ParseRetryAfter(past date) = %v, want 0", got)
	}
}
