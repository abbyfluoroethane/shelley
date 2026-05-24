// Package modelsdev consults a snapshot of https://models.dev/api.json to
// answer capability questions (currently: does a given model accept image
// inputs?).
//
// The snapshot is embedded at build time. Updating it is a manual exercise
// of replacing api.json in this directory.
package modelsdev

import (
	_ "embed"
	"encoding/json"
	"strings"
	"sync"
)

//go:embed api.json
var apiJSON []byte

type modelEntry struct {
	Modalities struct {
		Input  []string `json:"input"`
		Output []string `json:"output"`
	} `json:"modalities"`
}

type providerEntry struct {
	Models map[string]modelEntry `json:"models"`
}

var (
	parseOnce sync.Once
	parsed    map[string]providerEntry
)

func load() map[string]providerEntry {
	parseOnce.Do(func() {
		if err := json.Unmarshal(apiJSON, &parsed); err != nil {
			// Embedded data is shipped with the binary; failing to parse it
			// is a programmer error.
			panic("modelsdev: failed to parse embedded api.json: " + err.Error())
		}
	})
	return parsed
}

// providerMap translates Shelley's internal provider names to the provider
// keys used by models.dev's api.json.
var providerMap = map[string]string{
	"anthropic":        "anthropic",
	"openai":           "openai",
	"openai-responses": "openai",
	"gemini":           "google",
	"fireworks":        "fireworks-ai",
}

// LookupImageSupport reports whether models.dev says (provider, modelName)
// accepts image inputs. The second return value is false if we have no
// information about this model.
//
// provider is Shelley's internal provider name ("anthropic", "openai",
// "openai-responses", "gemini", "fireworks"). modelName is the value sent
// to the underlying provider.
//
// Lookup strategy, in order:
//  1. exact + case-insensitive match in the resolved provider entry
//  2. last-segment (after the final '/') match in the resolved provider —
//     handles OpenRouter-style "vendor/model" slugs pointed at a
//     provider-native endpoint
//  3. exact + last-segment match under the "openrouter" provider — handles
//     OpenRouter-routed custom models that keep the full slug
func LookupImageSupport(provider, modelName string) (supported, found bool) {
	data := load()
	if key, ok := providerMap[provider]; ok {
		if p, ok := data[key]; ok {
			if m, ok := lookupInProvider(p, modelName); ok {
				return entryHasImage(m), true
			}
		}
	}
	// Last-resort: OpenRouter keeps a full slug catalog.
	if p, ok := data["openrouter"]; ok {
		if m, ok := lookupInProvider(p, modelName); ok {
			return entryHasImage(m), true
		}
	}
	return false, false
}

// lookupInProvider tries exact, case-insensitive, and last-segment matches
// for modelName within p.Models.
func lookupInProvider(p providerEntry, modelName string) (modelEntry, bool) {
	if m, ok := p.Models[modelName]; ok {
		return m, true
	}
	lower := strings.ToLower(modelName)
	for id, entry := range p.Models {
		if strings.ToLower(id) == lower {
			return entry, true
		}
	}
	// Try the last "/"-separated segment (e.g. "openai/gpt-4o" -> "gpt-4o").
	if i := strings.LastIndex(modelName, "/"); i >= 0 && i+1 < len(modelName) {
		tail := modelName[i+1:]
		if m, ok := p.Models[tail]; ok {
			return m, true
		}
		tailLower := strings.ToLower(tail)
		for id, entry := range p.Models {
			if strings.ToLower(id) == tailLower {
				return entry, true
			}
		}
	}
	return modelEntry{}, false
}

func entryHasImage(m modelEntry) bool {
	for _, mod := range m.Modalities.Input {
		if mod == "image" {
			return true
		}
	}
	return false
}
