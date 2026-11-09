package api

// mergeJSONMaps recursively merges patch into base. Nested objects are merged
// key-by-key; arrays, scalars, and null replace the base value. This gives the
// admin PUT endpoints PATCH-like semantics so a partial body does not reset
// fields that were omitted.
func mergeJSONMaps(base, patch map[string]any) {
	for key, value := range patch {
		if patchMap, ok := value.(map[string]any); ok {
			if baseMap, ok := base[key].(map[string]any); ok {
				mergeJSONMaps(baseMap, patchMap)
				continue
			}
		}
		base[key] = value
	}
}
