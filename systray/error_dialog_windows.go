//go:build windows

package main

import (
	"syscall"
	"unsafe"
)

// showErrorDialog shows a native Windows message box (MB_ICONERROR | MB_OK)
// and blocks until the user dismisses it.
//
// MessageBoxW is resolved lazily from user32.dll so the lookup only happens
// on the rare failure path. The title and message are converted to UTF-16,
// the encoding the W variants of the Win32 API expect.
func showErrorDialog(title, message string) {
	user32 := syscall.NewLazyDLL("user32.dll")
	box := user32.NewProc("MessageBoxW")
	t, _ := syscall.UTF16PtrFromString(title)
	m, _ := syscall.UTF16PtrFromString(message)
	// 0x10 (MB_ICONERROR) | 0x0 (MB_OK). The return value is the button
	// pressed, which is always IDOK here and can be ignored.
	box.Call(
		0, // hWnd: no owner window
		uintptr(unsafe.Pointer(m)),
		uintptr(unsafe.Pointer(t)),
		0x10,
	)
}
