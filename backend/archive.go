package main

import (
	"archive/zip"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

type backupHandle struct {
	path      string
	name      string
	size      int64
	entries   int
	vaultRoot string
}

type restoreHandle struct {
	path      string
	received  int64
	vaultRoot string
}

// pluginDataDir returns where backup/restore temp zips live: the plugin data
// directory when the host provides one, otherwise the OS temp dir. The vault
// itself is never written to.
func pluginDataDir() string {
	if dir := strings.TrimSpace(os.Getenv("DBX_PLUGIN_DATA_DIR")); dir != "" {
		return dir
	}
	return os.TempDir()
}

func (s *server) putBackup(h *backupHandle) string {
	handle := randHex(16)
	s.handleMu.Lock()
	s.backups[handle] = h
	s.handleMu.Unlock()
	return handle
}

func (s *server) lookupBackup(handle string) (*backupHandle, *rpcError) {
	s.handleMu.Lock()
	h := s.backups[handle]
	s.handleMu.Unlock()
	if h == nil {
		return nil, errRuntime("HANDLE_MISSING", "备份句柄不存在: "+handle)
	}
	return h, nil
}

func (s *server) dropBackup(handle string) {
	s.handleMu.Lock()
	h := s.backups[handle]
	delete(s.backups, handle)
	s.handleMu.Unlock()
	if h != nil && h.path != "" {
		if err := os.Remove(h.path); err != nil && !os.IsNotExist(err) {
			logf("remove backup %s: %v", h.path, err)
		}
	}
}

func (s *server) putRestore(h *restoreHandle) string {
	handle := randHex(16)
	s.handleMu.Lock()
	s.restores[handle] = h
	s.handleMu.Unlock()
	return handle
}

func (s *server) lookupRestore(handle string) (*restoreHandle, *rpcError) {
	s.handleMu.Lock()
	h := s.restores[handle]
	s.handleMu.Unlock()
	if h == nil {
		return nil, errRuntime("HANDLE_MISSING", "恢复句柄不存在: "+handle)
	}
	return h, nil
}

func (s *server) dropRestore(handle string) {
	s.handleMu.Lock()
	h := s.restores[handle]
	delete(s.restores, handle)
	s.handleMu.Unlock()
	if h != nil && h.path != "" {
		if err := os.Remove(h.path); err != nil && !os.IsNotExist(err) {
			logf("remove restore temp %s: %v", h.path, err)
		}
	}
}

// ---------------------------------------------------------------- backup ----

func (s *server) notesBackupBegin(p rawParams) (any, *rpcError) {
	v, rerr := s.session(p.str("connectionId"))
	if rerr != nil {
		return nil, rerr
	}
	includeTrash := p.boolean("includeTrash", false)

	dataDir := pluginDataDir()
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		return nil, errRuntime("IO_ERROR", "无法创建数据目录: "+err.Error())
	}
	tmp, err := os.CreateTemp(dataDir, "miko-md-notes-backup-*.zip")
	if err != nil {
		return nil, errRuntime("IO_ERROR", "无法创建备份文件: "+err.Error())
	}
	tmpPath := tmp.Name()
	keep := false
	defer func() {
		_ = tmp.Close()
		if !keep {
			_ = os.Remove(tmpPath)
		}
	}()

	zw := zip.NewWriter(tmp)
	entries := 0
	bytesWritten := int64(0)
	walkErr := filepath.WalkDir(v.Root, func(current string, d fs.DirEntry, werr error) error {
		if werr != nil {
			logf("backup skip %s: %v", current, werr)
			return nil
		}
		if current == v.Root {
			return nil
		}
		name := d.Name()
		if isHiddenName(name) {
			if d.IsDir() {
				// .trash is opt-in; every other dot-entry is skipped entirely.
				if name == ".trash" && includeTrash {
					return nil
				}
				return fs.SkipDir
			}
			return nil
		}
		if d.IsDir() {
			return nil
		}
		info, ierr := d.Info()
		if ierr != nil {
			logf("backup stat %s: %v", current, ierr)
			return nil
		}
		if info.Size() > maxBackupEntry {
			logf("backup skip large file %s (%d bytes)", current, info.Size())
			return nil
		}
		rel, rerr := filepath.Rel(v.Root, current)
		if rerr != nil {
			logf("backup rel %s: %v", current, rerr)
			return nil
		}
		header := &zip.FileHeader{Name: filepath.ToSlash(rel), Method: zip.Deflate}
		header.SetModTime(info.ModTime())
		w, cerr := zw.CreateHeader(header)
		if cerr != nil {
			logf("backup create entry %s: %v", current, cerr)
			return nil
		}
		f, oerr := os.Open(current)
		if oerr != nil {
			logf("backup open %s: %v", current, oerr)
			return nil
		}
		n, copyErr := io.Copy(w, f)
		_ = f.Close()
		if copyErr != nil {
			logf("backup copy %s: %v", current, copyErr)
			return nil
		}
		entries++
		bytesWritten += n
		return nil
	})
	if walkErr != nil {
		logf("backup walk error: %v", walkErr)
	}
	if err := zw.Close(); err != nil {
		return nil, errRuntime("IO_ERROR", "写入 zip 失败: "+err.Error())
	}
	if err := tmp.Sync(); err != nil {
		return nil, errRuntime("IO_ERROR", "刷新备份文件失败: "+err.Error())
	}
	if err := tmp.Close(); err != nil {
		return nil, errRuntime("IO_ERROR", "关闭备份文件失败: "+err.Error())
	}
	info, err := os.Stat(tmpPath)
	if err != nil {
		return nil, errRuntime("IO_ERROR", err.Error())
	}

	h := &backupHandle{
		path:      tmpPath,
		name:      v.Name + "-backup-" + nowStamp() + ".zip",
		size:      info.Size(),
		entries:   entries,
		vaultRoot: v.Root,
	}
	handle := s.putBackup(h)
	keep = true
	logf("backup ready %s: %d entries, %d bytes written, %d bytes zip", h.name, entries, bytesWritten, h.size)
	return map[string]any{
		"handle":  handle,
		"name":    h.name,
		"size":    h.size,
		"entries": entries,
	}, nil
}

func (s *server) notesBackupRead(p rawParams) (any, *rpcError) {
	if _, rerr := s.session(p.str("connectionId")); rerr != nil {
		return nil, rerr
	}
	handle := strings.TrimSpace(p.str("handle"))
	h, rerr := s.lookupBackup(handle)
	if rerr != nil {
		return nil, rerr
	}
	offset, ok := p.floatParam("offset")
	if !ok {
		return nil, errParams("PATH_INVALID", "缺少 offset")
	}
	off := int64(offset)
	if off < 0 || off > h.size {
		return nil, errParams("PATH_INVALID", "offset 越界: "+strconv.FormatInt(off, 10))
	}
	length := p.intParam("length", defaultReadLength)
	length = clampInt64(length, 1, maxReadLength)

	f, err := os.Open(h.path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, errRuntime("HANDLE_MISSING", "备份文件已失效: "+handle)
		}
		return nil, errRuntime("IO_ERROR", err.Error())
	}
	defer func() { _ = f.Close() }()

	buf := make([]byte, length)
	n, rerr2 := f.ReadAt(buf, off)
	if rerr2 != nil && rerr2 != io.EOF {
		return nil, errRuntime("IO_ERROR", rerr2.Error())
	}
	return map[string]any{
		"dataBase64": encodeBase64(buf[:n]),
		"offset":     off,
		"eof":        off+int64(n) >= h.size,
	}, nil
}

func (s *server) notesBackupEnd(p rawParams) (any, *rpcError) {
	if _, rerr := s.session(p.str("connectionId")); rerr != nil {
		return nil, rerr
	}
	handle := strings.TrimSpace(p.str("handle"))
	if _, rerr := s.lookupBackup(handle); rerr != nil {
		return nil, rerr
	}
	s.dropBackup(handle)
	return map[string]any{"success": true}, nil
}

// --------------------------------------------------------------- restore ----

func (s *server) notesRestoreBegin(p rawParams) (any, *rpcError) {
	v, rerr := s.session(p.str("connectionId"))
	if rerr != nil {
		return nil, rerr
	}
	dataDir := pluginDataDir()
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		return nil, errRuntime("IO_ERROR", "无法创建数据目录: "+err.Error())
	}
	tmp, err := os.CreateTemp(dataDir, "miko-md-notes-restore-*.zip")
	if err != nil {
		return nil, errRuntime("IO_ERROR", "无法创建恢复文件: "+err.Error())
	}
	tmpPath := tmp.Name()
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmpPath)
		return nil, errRuntime("IO_ERROR", err.Error())
	}
	h := &restoreHandle{path: tmpPath, vaultRoot: v.Root}
	return map[string]any{"handle": s.putRestore(h)}, nil
}

func (s *server) notesRestoreChunk(p rawParams) (any, *rpcError) {
	if _, rerr := s.session(p.str("connectionId")); rerr != nil {
		return nil, rerr
	}
	handle := strings.TrimSpace(p.str("handle"))
	h, rerr := s.lookupRestore(handle)
	if rerr != nil {
		return nil, rerr
	}
	data, derr := decodeBase64(p.str("dataBase64"))
	if derr != nil {
		return nil, derr
	}
	if h.received+int64(len(data)) > maxRestoreTotal {
		return nil, errRuntime("PAYLOAD_TOO_LARGE", "恢复数据超过 256 MiB")
	}
	if len(data) > 0 {
		f, err := os.OpenFile(h.path, os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o600)
		if err != nil {
			return nil, errRuntime("IO_ERROR", "无法写入恢复临时文件: "+err.Error())
		}
		n, werr := f.Write(data)
		cerr := f.Close()
		if werr != nil {
			return nil, errRuntime("IO_ERROR", werr.Error())
		}
		if cerr != nil {
			return nil, errRuntime("IO_ERROR", cerr.Error())
		}
		h.received += int64(n)
	}
	return map[string]any{"received": h.received}, nil
}

func (s *server) notesRestoreCommit(p rawParams) (any, *rpcError) {
	v, rerr := s.session(p.str("connectionId"))
	if rerr != nil {
		return nil, rerr
	}
	handle := strings.TrimSpace(p.str("handle"))
	h, rerr := s.lookupRestore(handle)
	if rerr != nil {
		return nil, rerr
	}
	if !pathExists(h.path) {
		return nil, errRuntime("HANDLE_MISSING", "恢复临时文件已失效: "+handle)
	}
	targetAbs, targetRel, perr := v.absPath(p.str("targetDir"))
	if perr != nil {
		return nil, perr
	}
	overwrite := p.boolean("overwrite", false)
	if err := ensureDir(targetAbs); err != nil {
		return nil, errRuntime("IO_ERROR", "创建目标目录失败: "+err.Error())
	}

	restored, skipped, cerr := commitZip(v, h.path, targetRel, overwrite)
	if cerr != nil {
		// Keep the uploaded payload so the UI can retry with other options or
		// abort explicitly.
		return nil, cerr
	}
	s.dropRestore(handle)
	logf("restore committed into %q: %d restored, %d skipped", targetRel, restored, skipped)
	return map[string]any{
		"restored":  restored,
		"skipped":   skipped,
		"targetDir": targetRel,
	}, nil
}

func (s *server) notesRestoreAbort(p rawParams) (any, *rpcError) {
	if _, rerr := s.session(p.str("connectionId")); rerr != nil {
		return nil, rerr
	}
	s.dropRestore(strings.TrimSpace(p.str("handle")))
	return map[string]any{"success": true}, nil
}

// commitZip performs the merge into the vault and returns the counters.
func commitZip(v *Vault, zipPath, targetRel string, overwrite bool) (int, int, *rpcError) {
	zr, err := zip.OpenReader(zipPath)
	if err != nil {
		return 0, 0, errRuntime("ZIP_INVALID", "不是有效的 zip: "+err.Error())
	}
	defer func() { _ = zr.Close() }()

	restored, skipped := 0, 0
	for _, f := range zr.File {
		name := normalizeZipName(f.Name)
		if name == "" {
			skipped++
			continue
		}
		if strings.HasSuffix(f.Name, "/") || f.FileInfo().IsDir() {
			continue // directories are created implicitly
		}
		if f.Mode()&os.ModeSymlink != 0 {
			logf("restore skip symlink entry %q", f.Name)
			skipped++
			continue
		}
		if !f.Mode().IsRegular() {
			logf("restore skip non-regular entry %q", f.Name)
			skipped++
			continue
		}
		if !safeZipPath(name) {
			logf("restore skip unsafe entry %q", f.Name)
			skipped++
			continue
		}
		if isTrashPath(name) {
			skipped++
			continue
		}
		destRel := joinRel(targetRel, name)
		destAbs, _, perr := v.absPath(destRel)
		if perr != nil {
			logf("restore skip entry outside vault %q", name)
			skipped++
			continue
		}
		if pathExists(destAbs) && !overwrite {
			skipped++
			continue
		}
		if err := ensureDir(filepath.Dir(destAbs)); err != nil {
			logf("restore mkdir for %q: %v", name, err)
			skipped++
			continue
		}
		data, readErr := readZipEntry(f)
		if readErr != nil {
			logf("restore read %q: %v", name, readErr)
			skipped++
			continue
		}
		if err := writeFileAtomic(destAbs, data); err != nil {
			logf("restore write %q: %v", name, err)
			skipped++
			continue
		}
		restored++
	}
	return restored, skipped, nil
}

func readZipEntry(f *zip.File) ([]byte, error) {
	rc, err := f.Open()
	if err != nil {
		return nil, err
	}
	defer func() { _ = rc.Close() }()
	data, err := io.ReadAll(io.LimitReader(rc, maxRestoreEntry+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > maxRestoreEntry {
		return nil, fmt.Errorf("条目超过 %d 字节", maxRestoreEntry)
	}
	return data, nil
}

func normalizeZipName(name string) string {
	s := strings.ReplaceAll(name, `\`, "/")
	for strings.HasPrefix(s, "./") {
		s = s[2:]
	}
	return s
}

// safeZipPath rejects absolute paths, drive letters, NUL and any ".." segment.
func safeZipPath(name string) bool {
	if name == "" {
		return false
	}
	if strings.IndexByte(name, 0) >= 0 {
		return false
	}
	if strings.HasPrefix(name, "/") {
		return false
	}
	if filepath.IsAbs(name) || filepath.VolumeName(name) != "" {
		return false
	}
	for _, seg := range strings.Split(name, "/") {
		if seg == ".." {
			return false
		}
	}
	return true
}

func isTrashPath(name string) bool {
	first := name
	if i := strings.IndexByte(name, '/'); i >= 0 {
		first = name[:i]
	}
	return first == ".trash"
}
