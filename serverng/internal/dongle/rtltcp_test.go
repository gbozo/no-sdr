package dongle

import (
	"context"
	"encoding/binary"
	"net"
	"testing"
	"time"
)

func TestCommand_FormatsPacketCorrectly(t *testing.T) {
	// Create a local TCP server to capture what Command() writes
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()

	// Accept in background and capture bytes
	received := make(chan []byte, 1)
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()

		// Send fake RTL0 header so Connect succeeds
		var header RtlDongleInfo
		header.Magic = [4]byte{'R', 'T', 'L', '0'}
		header.TunerType = 5
		header.TunerGains = 29
		binary.Write(conn, binary.BigEndian, &header)

		// Read the command bytes
		buf := make([]byte, 5)
		conn.SetReadDeadline(time.Now().Add(2 * time.Second))
		n, _ := conn.Read(buf)
		received <- buf[:n]
	}()

	addr := ln.Addr().(*net.TCPAddr)
	src := NewRtlTcpSource(RtlTcpConfig{
		Host: "127.0.0.1",
		Port: addr.Port,
	})

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	if err := src.Connect(ctx); err != nil {
		t.Fatal("Connect failed:", err)
	}
	defer src.Close()

	// Send SetFrequency command: cmd=0x01, value=144000000
	err = src.SetFrequency(144000000)
	if err != nil {
		t.Fatal("SetFrequency failed:", err)
	}

	select {
	case data := <-received:
		if len(data) != 5 {
			t.Fatalf("expected 5 bytes, got %d", len(data))
		}
		if data[0] != 0x01 {
			t.Errorf("expected cmd 0x01, got 0x%02X", data[0])
		}
		value := binary.BigEndian.Uint32(data[1:5])
		if value != 144000000 {
			t.Errorf("expected value 144000000, got %d", value)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timeout waiting for command data")
	}
}

func TestConnect_NonExistentServer_ReturnsErrorQuickly(t *testing.T) {
	src := NewRtlTcpSource(RtlTcpConfig{
		Host: "127.0.0.1",
		Port: 19999, // unlikely to be listening
	})

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	start := time.Now()
	err := src.Connect(ctx)
	elapsed := time.Since(start)

	if err == nil {
		src.Close()
		t.Fatal("expected error connecting to non-existent server")
	}

	// Should fail quickly (well under the 5s dial timeout due to connection refused)
	if elapsed > 3*time.Second {
		t.Errorf("connection took too long: %v", elapsed)
	}
}

func TestClose_NilConnection_NoPanic(t *testing.T) {
	src := NewRtlTcpSource(RtlTcpConfig{
		Host: "127.0.0.1",
		Port: 1234,
	})

	// Close without ever connecting — should not panic
	err := src.Close()
	if err != nil {
		t.Errorf("Close on nil connection returned error: %v", err)
	}
}

func TestConnect_InvalidMagic_ReturnsError(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()

	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()

		// Send invalid magic
		var header RtlDongleInfo
		header.Magic = [4]byte{'B', 'A', 'D', '!'}
		header.TunerType = 0
		header.TunerGains = 0
		binary.Write(conn, binary.BigEndian, &header)
	}()

	addr := ln.Addr().(*net.TCPAddr)
	src := NewRtlTcpSource(RtlTcpConfig{
		Host: "127.0.0.1",
		Port: addr.Port,
	})

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	err = src.Connect(ctx)
	if err == nil {
		src.Close()
		t.Fatal("expected error for invalid magic")
	}
}

func TestCommand_NotConnected_ReturnsError(t *testing.T) {
	src := NewRtlTcpSource(RtlTcpConfig{
		Host: "127.0.0.1",
		Port: 1234,
	})

	err := src.Command(0x01, 100000000)
	if err == nil {
		t.Fatal("expected error when sending command without connection")
	}
}
