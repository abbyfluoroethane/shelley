package modelsdev

import "testing"

func TestLookupImageSupport(t *testing.T) {
	cases := []struct {
		provider   string
		model      string
		wantFound  bool
		wantImages bool
	}{
		{"fireworks", "accounts/fireworks/models/glm-5p1", true, false},
		{"fireworks", "accounts/fireworks/models/kimi-k2p6", true, true},
		{"anthropic", "claude-opus-4-1-20250805", true, true},
		{"openai", "gpt-5.4", true, true},
		{"gemini", "gemini-3-pro-preview", true, true},
		{"fireworks", "made-up-model", false, false},
		{"bogus", "x", false, false},

		// OpenRouter-style slugs with a known provider prefix should fall
		// back to the last segment within the resolved provider...
		{"openai", "openai/gpt-4o", true, true},
		{"openai", "openai/gpt-oss-20b", true, false},
		{"anthropic", "anthropic/claude-3-haiku", true, true},
		{"gemini", "google/gemini-2.5-flash", true, true},

		// ...or fall through to OpenRouter's own catalog for slugs whose
		// vendor prefix doesn't map onto a Shelley provider.
		{"openai", "meta-llama/llama-3.3-70b-instruct", true, false},
		{"openai", "deepseek/deepseek-chat", true, false},
		{"openai", "qwen/qwen-2.5-72b-instruct", true, false},
		{"openai", "mistralai/mistral-large", true, false},
		{"openai", "z-ai/glm-4.5-air", true, false},
	}
	for _, c := range cases {
		gotImages, gotFound := LookupImageSupport(c.provider, c.model)
		if gotFound != c.wantFound || gotImages != c.wantImages {
			t.Errorf("LookupImageSupport(%q,%q) = (%v,%v); want (%v,%v)",
				c.provider, c.model, gotImages, gotFound, c.wantImages, c.wantFound)
		}
	}
}
