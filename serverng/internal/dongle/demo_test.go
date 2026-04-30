package dongle

import (
	"context"
	"testing"
	"time"
)

func TestNewDemoSource_Defaults(t *testing.T) {
	src := NewDemoSource(DemoConfig{SampleRate: 2400000})
	if src.sampleRate != 2400000 {
		t.Fatalf("expected sampleRate=2400000, got %d", src.sampleRate)
	}
	if len(src.signals) != 3 {
		t.Fatalf("expected 3 default signals, got %d", len(src.signals))
	}
}

func TestNewDemoSource_CustomSignals(t *testing.T) {
	cfg := DemoConfig{
		SampleRate: 1000000,
		Signals: []SignalConfig{
			{OffsetHz: 50000, Amplitude: 0.5, ModType: "carrier"},
		},
	}
	src := NewDemoSource(cfg)
	if len(src.signals) != 1 {
		t.Fatalf("expected 1 signal, got %d", len(src.signals))
	}
	if src.signals[0].offsetHz != 50000 {
		t.Fatalf("expected offsetHz=50000, got %f", src.signals[0].offsetHz)
	}
}

func TestDemoSource_Run_ProducesData(t *testing.T) {
	src := NewDemoSource(DemoConfig{SampleRate: 48000}) // small rate for fast test
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()

	out := make(chan []byte, 100)
	go src.Run(ctx, out)

	// Should receive at least a few chunks in 100ms
	<-ctx.Done()

	count := len(out)
	if count == 0 {
		t.Fatal("expected at least one chunk from demo source")
	}

	// Verify chunk size: sampleRate/100 * 2 bytes
	expectedSize := (48000 / 100) * 2 // 960 bytes
	chunk := <-out
	if len(chunk) != expectedSize {
		t.Fatalf("expected chunk size %d, got %d", expectedSize, len(chunk))
	}

	// Verify values are in uint8 range (they always will be, but check not all zero)
	allZero := true
	for _, b := range chunk {
		if b != 0 {
			allZero = false
			break
		}
	}
	if allZero {
		t.Fatal("chunk should not be all zeros")
	}
}

func TestDemoSource_Run_CancelStops(t *testing.T) {
	src := NewDemoSource(DemoConfig{SampleRate: 48000})
	ctx, cancel := context.WithCancel(context.Background())

	out := make(chan []byte, 100)
	done := make(chan struct{})
	go func() {
		src.Run(ctx, out)
		close(done)
	}()

	// Let it run briefly then cancel
	time.Sleep(30 * time.Millisecond)
	cancel()

	select {
	case <-done:
		// success - Run exited
	case <-time.After(time.Second):
		t.Fatal("Run did not exit after context cancel")
	}
}
