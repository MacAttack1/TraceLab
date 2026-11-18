//go:build !windows

package main

import "errors"

func visaAvailable() bool           { return false }
func listVISA() ([]portInfo, error) { return nil, nil }
func openVISA(rsrc string) (rawPort, error) {
	return nil, errors.New("VISA is only available on Windows")
}
