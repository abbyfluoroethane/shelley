package version

import (
	"encoding/json"
	"io/fs"
	"os"
	"runtime/debug"

	"shelley.exe.dev/ui"
)

// Version and Tag are set at build time via ldflags
var (
	Version = "dev"
	Tag     = ""
)

// Capabilities advertises optional, additive features that clients can
// opt into when present. Capabilities are non-breaking: a client that
// doesn't recognize a capability just doesn't use it, and an older
// server that doesn't ship the field is equivalent to advertising none.
// Clients should treat unknown capability strings as no-ops.
func Capabilities() []string {
	return []string{
		// The server accepts a per-request thinking_level override
		// (off, minimal, low, medium, high, xhigh) on converse and
		// distill endpoints. Clients can expose a picker; older
		// servers without this capability silently ignore the field.
		"thinking-levels",
		// "drafts": conversations may have is_draft=true with their body
		// in the draft column instead of messages. Promoted to a normal
		// conversation when POSTed to /api/conversation/<id>/chat.
		// See POST /api/conversations/draft, PUT /api/conversation/<id>/draft.
		"drafts",
	}
}

// Info holds build information from runtime/debug.ReadBuildInfo
type Info struct {
	Version    string `json:"version,omitempty"`
	Tag        string `json:"tag,omitempty"`
	Commit     string `json:"commit,omitempty"`
	CommitTime string `json:"commit_time,omitempty"`
}

// GetInfo returns build information using runtime/debug.ReadBuildInfo,
// falling back to the embedded build-info.json from the UI build.
// The SHELLEY_VERSION_OVERRIDE environment variable can override the tag for testing.
func GetInfo() Info {
	tag := Tag
	if override := os.Getenv("SHELLEY_VERSION_OVERRIDE"); override != "" {
		tag = override
	}

	info := Info{
		Version: Version,
		Tag:     tag,
	}

	buildInfo, ok := debug.ReadBuildInfo()
	if ok {
		for _, setting := range buildInfo.Settings {
			switch setting.Key {
			case "vcs.revision":
				info.Commit = setting.Value
			case "vcs.time":
				info.CommitTime = setting.Value
			}
		}
	}

	// If we didn't get vcs info from debug.ReadBuildInfo, try the embedded build-info.json
	if info.Commit == "" {
		if data, err := fs.ReadFile(ui.Dist, "dist/build-info.json"); err == nil {
			var buildJSON struct {
				Commit     string `json:"commit"`
				CommitTime string `json:"commitTime"`
			}
			if json.Unmarshal(data, &buildJSON) == nil {
				info.Commit = buildJSON.Commit
				info.CommitTime = buildJSON.CommitTime
			}
		}
	}

	return info
}
