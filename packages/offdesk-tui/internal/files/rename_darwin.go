//go:build darwin

package files

import "golang.org/x/sys/unix"

func renameNoReplace(source, destination string) error {
	return unix.RenamexNp(source, destination, unix.RENAME_EXCL)
}
