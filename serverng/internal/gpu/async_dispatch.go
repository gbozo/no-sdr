// Package gpu — async_dispatch.go provides non-blocking GPU pipeline dispatch.
//
// The data loop submits IQ chunks via TrySubmitIQ (never blocks). A dedicated
// goroutine processes them on the GPU and delivers results via a callback.
// This introduces 1-frame latency (~10ms) but eliminates GPU stalls from the
// hot path, preventing the "half-second sound, half silence" audio gap pattern.
//
// Architecture: unbuffered channel ensures state safety.
//   - Data loop: submit work → unbuffered channel (non-blocking select/default)
//   - GPU goroutine: blocks on receive → synchronous GPU dispatch → write back state → loop
//   - Submit only succeeds when GPU goroutine is waiting (idle) — guarantees
//     no concurrent access to IqClientState between data loop and GPU goroutine.
//   - If GPU busy: data loop drops the chunk for GPU clients. Client jitter buffer
//     absorbs 10ms gaps. Expected drop rate: ~20-50% (GPU takes 2-5ms per 10ms chunk).

package gpu

import (
	"log/slog"
	"sync"
	"sync/atomic"
)

// ── IQ Async Dispatcher ─────────────────────────────────────────────────────

// IqWorkItem is a single GPU IQ dispatch request.
type IqWorkItem struct {
	RawIQ   []byte
	States  []*IqClientState
	Entries []IqResultEntry // caller provides entry metadata for result routing
}

// IqResultEntry identifies a client for result routing.
type IqResultEntry struct {
	ClientID string
	Index    int // index in States/results slice
}

// IqResult is delivered via the callback after GPU completes.
type IqResult struct {
	Entries []IqResultOutput
}

// IqResultOutput holds one client's GPU-processed sub-band IQ.
type IqResultOutput struct {
	ClientID string
	SubBand  []int16
}

// IqResultCallback is called from the GPU goroutine with completed results.
// It MUST be safe to call from a different goroutine than the data loop.
type IqResultCallback func(result *IqResult)

// AsyncIqDispatcher provides non-blocking GPU IQ pipeline access.
type AsyncIqDispatcher struct {
	pipeline  *IqPipelineContext
	workCh    chan *IqWorkItem
	resultCh  chan *IqResult // buffered: decouples GPU from result delivery
	callback  IqResultCallback
	logger    *slog.Logger
	stopCh    chan struct{}
	wg        sync.WaitGroup

	// Stats
	dispatches int64
	drops      int64
}

// NewAsyncIqDispatcher creates an async dispatcher wrapping the given pipeline.
// callback is called from a dedicated delivery goroutine (serialized) when results are ready.
func NewAsyncIqDispatcher(pipeline *IqPipelineContext, callback IqResultCallback, logger *slog.Logger) *AsyncIqDispatcher {
	d := &AsyncIqDispatcher{
		pipeline: pipeline,
		workCh:   make(chan *IqWorkItem), // UNBUFFERED: submit only succeeds when GPU goroutine is idle (prevents state race)
		resultCh: make(chan *IqResult, 4), // buffered: decouples GPU completion from result delivery
		callback: callback,
		logger:   logger,
		stopCh:   make(chan struct{}),
	}
	d.wg.Add(2)
	go d.run()
	go d.deliverResults()
	return d
}

// TrySubmitIQ attempts to hand an IQ work item directly to the GPU goroutine.
// Returns true if the GPU goroutine was idle and accepted the item.
// Returns false if the GPU is still processing the previous chunk.
// This NEVER blocks. The unbuffered channel guarantees that the GPU goroutine
// has finished writing back state from the previous chunk before accepting new work,
// eliminating the data race on IqClientState fields.
func (d *AsyncIqDispatcher) TrySubmitIQ(item *IqWorkItem) bool {
	select {
	case d.workCh <- item:
		return true
	default:
		atomic.AddInt64(&d.drops, 1)
		return false
	}
}

// Stats returns dispatch count and drop count.
func (d *AsyncIqDispatcher) Stats() (dispatches, drops int64) {
	return atomic.LoadInt64(&d.dispatches), atomic.LoadInt64(&d.drops)
}

// Close stops the GPU goroutine and waits for it to finish.
func (d *AsyncIqDispatcher) Close() {
	close(d.stopCh)
	d.wg.Wait()
}

func (d *AsyncIqDispatcher) run() {
	defer d.wg.Done()
	for {
		select {
		case <-d.stopCh:
			return
		case item, ok := <-d.workCh:
			if !ok {
				return
			}
			d.processIQ(item)
		}
	}
}

func (d *AsyncIqDispatcher) processIQ(item *IqWorkItem) {
	results, err := d.pipeline.Process(item.RawIQ, item.States)
	if err != nil {
		d.logger.Warn("gpu: async IQ dispatch failed", "error", err, "clients", len(item.States))
		return
	}

	atomic.AddInt64(&d.dispatches, 1)

	// Build result
	out := &IqResult{
		Entries: make([]IqResultOutput, 0, len(item.Entries)),
	}
	for _, entry := range item.Entries {
		if entry.Index < len(results) && len(results[entry.Index]) > 0 {
			out.Entries = append(out.Entries, IqResultOutput{
				ClientID: entry.ClientID,
				SubBand:  results[entry.Index],
			})
		}
	}

	if len(out.Entries) > 0 {
		// Send to delivery goroutine (buffered channel — won't block GPU goroutine
		// unless delivery is severely backed up, which shouldn't happen).
		select {
		case d.resultCh <- out:
		default:
			// Delivery goroutine is backed up — drop this result rather than stalling GPU.
			d.logger.Warn("gpu: result delivery backed up, dropping IQ result")
		}
	}
}

// deliverResults runs in a dedicated goroutine, serializing result delivery.
// This ensures per-client processClientSubBand calls are never concurrent
// (same client's accumBuf is only accessed by one goroutine at a time).
func (d *AsyncIqDispatcher) deliverResults() {
	defer d.wg.Done()
	for {
		select {
		case <-d.stopCh:
			return
		case result, ok := <-d.resultCh:
			if !ok {
				return
			}
			if d.callback != nil {
				d.callback(result)
			}
		}
	}
}

// ── FM Stereo Async Dispatcher ──────────────────────────────────────────────

// FmWorkItem is a single GPU FM stereo dispatch request.
type FmWorkItem struct {
	Composite []float32
	Carrier38 []float32
	Blends    []float32
	States    []*FmClientState
	NumSamples  int
	DecimFactor int
	// Caller context for result routing
	ClientID string
}

// FmResult is delivered via the callback after GPU completes.
type FmResult struct {
	ClientID string
	Audio    []float32 // interleaved L,R at decimated rate
}

// FmResultCallback is called from the GPU goroutine with completed results.
type FmResultCallback func(result *FmResult)

// AsyncFmDispatcher provides non-blocking GPU FM stereo pipeline access.
type AsyncFmDispatcher struct {
	pipeline *FmStereoContext
	workCh   chan *FmWorkItem
	callback FmResultCallback
	logger   *slog.Logger
	stopCh   chan struct{}
	wg       sync.WaitGroup

	// Stats
	dispatches int64
	drops      int64
}

// NewAsyncFmDispatcher creates an async dispatcher wrapping the given FM pipeline.
func NewAsyncFmDispatcher(pipeline *FmStereoContext, callback FmResultCallback, logger *slog.Logger) *AsyncFmDispatcher {
	d := &AsyncFmDispatcher{
		pipeline: pipeline,
		workCh:   make(chan *FmWorkItem, 1),
		callback: callback,
		logger:   logger,
		stopCh:   make(chan struct{}),
	}
	d.wg.Add(1)
	go d.run()
	return d
}

// TrySubmitFM attempts to enqueue an FM work item. Returns true if accepted.
func (d *AsyncFmDispatcher) TrySubmitFM(item *FmWorkItem) bool {
	select {
	case d.workCh <- item:
		return true
	default:
		atomic.AddInt64(&d.drops, 1)
		return false
	}
}

// Stats returns dispatch count and drop count.
func (d *AsyncFmDispatcher) Stats() (dispatches, drops int64) {
	return atomic.LoadInt64(&d.dispatches), atomic.LoadInt64(&d.drops)
}

// Close stops the GPU goroutine and waits for it to finish.
func (d *AsyncFmDispatcher) Close() {
	close(d.stopCh)
	d.wg.Wait()
}

func (d *AsyncFmDispatcher) run() {
	defer d.wg.Done()
	for {
		select {
		case <-d.stopCh:
			return
		case item, ok := <-d.workCh:
			if !ok {
				return
			}
			d.processFM(item)
		}
	}
}

func (d *AsyncFmDispatcher) processFM(item *FmWorkItem) {
	results, err := d.pipeline.Process(
		item.Composite, item.Carrier38, item.Blends,
		item.States, item.NumSamples, item.DecimFactor,
	)
	if err != nil {
		d.logger.Warn("gpu: async FM dispatch failed", "error", err)
		return
	}

	atomic.AddInt64(&d.dispatches, 1)

	if d.callback != nil && len(results) > 0 && len(results[0]) > 0 {
		d.callback(&FmResult{
			ClientID: item.ClientID,
			Audio:    results[0],
		})
	}
}
