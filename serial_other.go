//go:build !windows && !linux

package main

import "errors"

func openSerial(name string, baud int) (rawPort, error) {
	return nil, errors.New("serial ports aren't supported on this platform")
}

func listSerialPorts() []portInfo { return nil }
