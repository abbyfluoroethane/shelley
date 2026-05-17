package llm

import (
	"net/http"
	"strconv"
	"time"
)

// ParseRetryAfter parses a Retry-After header value (RFC 7231 §7.1.3).
// It accepts either delta-seconds or an HTTP-date. Returns 0 if the header
// is missing or unparseable.
func ParseRetryAfter(v string) time.Duration {
	if v == "" {
		return 0
	}
	if secs, err := strconv.Atoi(v); err == nil && secs >= 0 {
		return time.Duration(secs) * time.Second
	}
	if t, err := http.ParseTime(v); err == nil {
		if d := time.Until(t); d > 0 {
			return d
		}
	}
	return 0
}
