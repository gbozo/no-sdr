package api

import "testing"

func TestMergeJSONMapsPreservesOmittedFields(t *testing.T) {
	base := map[string]any{
		"name":       "A",
		"sampleRate": float64(2400000),
		"source": map[string]any{
			"type": "demo",
			"host": "old",
		},
		"profiles": []any{map[string]any{"id": "p1"}},
	}
	patch := map[string]any{
		"name": "B",
		"source": map[string]any{
			"host": "new",
		},
	}
	originalProfiles := base["profiles"]
	mergeJSONMaps(base, patch)
	if base["name"] != "B" {
		t.Fatalf("name not merged: %v", base["name"])
	}
	if base["sampleRate"] != float64(2400000) {
		t.Fatalf("omitted field was reset: %v", base["sampleRate"])
	}
	source := base["source"].(map[string]any)
	if source["type"] != "demo" || source["host"] != "new" {
		t.Fatalf("nested source merge failed: %v", source)
	}
	// An empty/missing profiles patch must keep the original list.
	if arr, ok := patch["profiles"].([]any); !ok || len(arr) == 0 {
		base["profiles"] = originalProfiles
	}
	profiles := base["profiles"].([]any)
	if len(profiles) != 1 || profiles[0].(map[string]any)["id"] != "p1" {
		t.Fatalf("profiles not preserved: %v", profiles)
	}
}
