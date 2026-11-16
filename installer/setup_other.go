//go:build !windows

package main

import "fmt"

func main() { fmt.Println("The Trace Lab installer is Windows-only. Build it with GOOS=windows.") }
