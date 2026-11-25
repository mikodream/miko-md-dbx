package main

import (
	"bytes"
	"fmt"
	"io"
	"io/fs"
	"math"
	"net/url"
	"os"
	slashpath "path"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"
)

const defaultAssetsDir = "_assets"

var (
	imageExts = map[string]bool{
		".png": true, ".jpg": true, ".jpeg": true, ".gif": true,
		".webp": true, ".svg": true, ".bmp": true, ".avif": true,
	}
	textExts = map[string]bool{
		".txt": true, ".text": true, ".log": true, ".csv": true,
		".tsv": true, ".yaml": true, ".yml": true, ".toml": true,
		".ini": true, ".conf": true, ".cfg": true, ".go": true,
		".py": true, ".rs": true, ".js": true, ".mjs": true,
		".ts": true, ".jsx": true, ".tsx": true, ".css": true,
		".html": true, ".htm": true, ".sh": true, ".bash": true,
		".zsh": true, ".sql": true, ".java": true, ".c": true,
		".h": true, ".cpp": true, ".hpp": true, ".rb": true,
		".php": true, ".lua": true, ".swift": true, ".kt": true,
		".dockerfile": true, ".gitignore": true, ".env": true,
	}
	importSkipDirs = map[string]bool{
		"node_modules": true, ".git": true, ".trash": true,
		"dist": true, "target": true,
	}
)

// Vault is one opened notes root plus its connection-level configuration.
type Vault struct {
	Root         string // absolute, cleaned, as configured
	RootReal     string // symlink-resolved root, used for containment checks
	Name         string
	AssetsDir    string // vault-relative, "/" separated, may be ""
	TrashEnabled bool
}

func expandUserPath(raw string) (string, error) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return "", nil
	}
	if s == "~" || strings.HasPrefix(s, "~/") || strings.HasPrefix(s, "~"+string(os.PathSeparator)) {
		home, err := os.UserHomeDir()
		if err != nil || home == "" {
			return "", fmt.Errorf("无法解析用户主目录")
		}
		if s == "~" {
			s = home
		} else {
			s = filepath.Join(home, s[2:])
		}
	}
	if !filepath.IsAbs(s) {
		abs, err := filepath.Abs(s)
		if err != nil {
			return "", err
		}
		s = abs
	}
	return filepath.Clean(s), nil
}

func expandVaultPath(raw string) (string, *rpcError) {
	if strings.TrimSpace(raw) == "" {
		return "", errParams("PATH_INVALID", "缺少 vault_path")
	}
	abs, err := expandUserPath(raw)
	if err != nil {
		return "", errRuntime("PATH_INVALID", "无法解析笔记库路径: "+err.Error())
	}
	return abs, nil
}

func newVault(root, assetsDir string, trashEnabled bool) *Vault {
	real := root
	if resolved, err := filepath.EvalSymlinks(root); err == nil && resolved != "" {
		real = resolved
	}
	return &Vault{
		Root:         filepath.Clean(root),
		RootReal:     filepath.Clean(real),
		Name:         filepath.Base(filepath.Clean(root)),
		AssetsDir:    assetsDir,
		TrashEnabled: trashEnabled,
	}
}

func (v *Vault) assetsPath() string {
	if strings.TrimSpace(v.AssetsDir) == "" {
		return v.Root
	}
	return filepath.Join(v.Root, filepath.FromSlash(v.AssetsDir))
}

func insideDir(root, p string) bool {
	root = filepath.Clean(root)
	p = filepath.Clean(p)
	if p == root {
		return true
	}
	prefix := root
	if !strings.HasSuffix(prefix, string(os.PathSeparator)) {
		prefix += string(os.PathSeparator)
	}
	return strings.HasPrefix(p, prefix)
}

// cleanRelPath validates a vault-relative path and returns its normal form:
// "/" separated, no leading slash, no "." or ".." segments, no backslashes,
// no NUL. The empty string denotes the vault root.
func cleanRelPath(rel string) (string, *rpcError) {
	if strings.IndexByte(rel, 0) >= 0 {
		return "", errParams("PATH_INVALID", "路径包含空字节")
	}
	if strings.Contains(rel, `\`) {
		return "", errParams("PATH_INVALID", "路径不能包含反斜杠: "+rel)
	}
	if rel == "" {
		return "", nil
	}
	if strings.HasPrefix(rel, "/") {
		return "", errParams("PATH_INVALID", "路径必须是笔记库相对路径: "+rel)
	}
	if filepath.VolumeName(rel) != "" {
		return "", errParams("PATH_INVALID", "路径不能带盘符: "+rel)
	}
	segments := strings.Split(rel, "/")
	out := make([]string, 0, len(segments))
	for _, seg := range segments {
		switch seg {
		case "", ".":
			continue
		case "..":
			return "", errParams("PATH_INVALID", "路径不能包含 .. 段: "+rel)
		}
		out = append(out, seg)
	}
	return strings.Join(out, "/"), nil
}

// cleanSegment validates a single path component (rename/newName/mkdir name).
func cleanSegment(name string) (string, *rpcError) {
	if name == "" {
		return "", errParams("PATH_INVALID", "名称为空")
	}
	if strings.IndexByte(name, 0) >= 0 {
		return "", errParams("PATH_INVALID", "名称包含空字节")
	}
	if strings.ContainsAny(name, `/\`) {
		return "", errParams("PATH_INVALID", "名称不能包含路径分隔符: "+name)
	}
	if name == "." || name == ".." {
		return "", errParams("PATH_INVALID", "名称非法: "+name)
	}
	return name, nil
}

// symlinkInside checks the deepest existing ancestor of abs after resolving
// symlinks; a link pointing outside the vault is rejected.
func (v *Vault) symlinkInside(abs string) bool {
	p := abs
	for i := 0; i < 128; i++ {
		if _, err := os.Lstat(p); err == nil {
			break
		}
		parent := filepath.Dir(p)
		if parent == p {
			break
		}
		p = parent
	}
	resolved, err := filepath.EvalSymlinks(p)
	if err != nil {
		return true // nothing resolvable: the lexical check already passed
	}
	if insideDir(v.RootReal, resolved) {
		return true
	}
	// The configured root itself may be reached through a different alias.
	return insideDir(v.Root, resolved)
}

// absPath turns a vault-relative path into an absolute one and enforces
// containment (lexically and through symlinks).
func (v *Vault) absPath(rel string) (string, string, *rpcError) {
	clean, perr := cleanRelPath(rel)
	if perr != nil {
		return "", "", perr
	}
	abs := v.Root
	if clean != "" {
		abs = filepath.Join(v.Root, filepath.FromSlash(clean))
	}
	abs = filepath.Clean(abs)
	if !insideDir(v.Root, abs) {
		return "", "", errRuntime("PATH_OUTSIDE_VAULT", "路径越出笔记库: "+rel)
	}
	if !v.symlinkInside(abs) {
		return "", "", errRuntime("PATH_OUTSIDE_VAULT", "路径经符号链接越出笔记库: "+rel)
	}
	return abs, clean, nil
}

func (v *Vault) relOf(abs string) string {
	rel, err := filepath.Rel(v.Root, abs)
	if err != nil {
		return filepath.ToSlash(filepath.Base(abs))
	}
	if rel == "." {
		return ""
	}
	return filepath.ToSlash(rel)
}

// stat resolves rel and stats it, mapping ENOENT to NOT_FOUND.
func (v *Vault) stat(rel string) (string, string, os.FileInfo, *rpcError) {
	abs, clean, perr := v.absPath(rel)
	if perr != nil {
		return "", "", nil, perr
	}
	info, err := os.Stat(abs)
	if err != nil {
		if os.IsNotExist(err) {
			return abs, clean, nil, errRuntime("NOT_FOUND", "路径不存在: "+displayPath(clean))
		}
		return abs, clean, nil, errRuntime("IO_ERROR", err.Error())
	}
	return abs, clean, info, nil
}

func displayPath(rel string) string {
	if rel == "" {
		return "/"
	}
	return rel
}

func joinRel(dirRel, name string) string {
	dirRel = strings.Trim(dirRel, "/")
	if dirRel == "" {
		return name
	}
	return dirRel + "/" + name
}

func isHiddenName(name string) bool {
	return strings.HasPrefix(name, ".") && name != "." && name != ".."
}

func isNoteName(name string) bool {
	switch strings.ToLower(slashpath.Ext(name)) {
	case ".md", ".markdown":
		return true
	}
	return false
}

func isImageName(name string) bool {
	return imageExts[strings.ToLower(slashpath.Ext(name))]
}

// ------------------------------------------------------------ vault walks ---

func (v *Vault) countNotes(dirRel string) int {
	abs, _, perr := v.absPath(dirRel)
	if perr != nil {
		return 0
	}
	count := 0
	_ = filepath.WalkDir(abs, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if p != abs && isHiddenName(d.Name()) {
			if d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if d.IsDir() {
			return nil
		}
		if isNoteName(d.Name()) {
			count++
		}
		return nil
	})
	return count
}

func (v *Vault) countFolders() int {
	folders := 0
	_ = filepath.WalkDir(v.Root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if p == v.Root {
			return nil
		}
		if isHiddenName(d.Name()) {
			if d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if d.IsDir() {
			folders++
		}
		return nil
	})
	return folders
}

type vaultStats struct {
	Notes   int64
	Folders int64
	Bytes   int64
	Images  int64
}

func (v *Vault) stats() vaultStats {
	var st vaultStats
	_ = filepath.WalkDir(v.Root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if p == v.Root {
			return nil
		}
		if isHiddenName(d.Name()) {
			if d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if d.IsDir() {
			st.Folders++
			return nil
		}
		info, ierr := d.Info()
		if ierr != nil {
			return nil
		}
		st.Bytes += info.Size()
		if isNoteName(d.Name()) {
			st.Notes++
		}
		if isImageName(d.Name()) {
			st.Images++
		}
		return nil
	})
	return st
}

func entryRank(e fs.DirEntry) int {
	if e.IsDir() {
		return 0
	}
	if isNoteName(e.Name()) {
		return 1
	}
	return 2
}

// readDirSorted lists a vault directory, dropping hidden entries, sorted
// directories-first then notes then other files, case-insensitively by name.
func (v *Vault) readDirSorted(dirRel string) ([]fs.DirEntry, string, *rpcError) {
	abs, clean, perr := v.absPath(dirRel)
	if perr != nil {
		return nil, "", perr
	}
	ents, err := os.ReadDir(abs)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, clean, errRuntime("NOT_FOUND", "目录不存在: "+displayPath(clean))
		}
		return nil, clean, errRuntime("IO_ERROR", err.Error())
	}
	out := make([]fs.DirEntry, 0, len(ents))
	for _, e := range ents {
		if isHiddenName(e.Name()) {
			continue
		}
		out = append(out, e)
	}
	sort.SliceStable(out, func(i, j int) bool {
		ri, rj := entryRank(out[i]), entryRank(out[j])
		if ri != rj {
			return ri < rj
		}
		li, lj := strings.ToLower(out[i].Name()), strings.ToLower(out[j].Name())
		if li != lj {
			return li < lj
		}
		return out[i].Name() < out[j].Name()
	})
	return out, clean, nil
}

// ------------------------------------------------------------------ notes ---

type treeNode struct {
	Name       string      `json:"name"`
	Path       string      `json:"path"`
	Kind       string      `json:"kind"`
	Size       *int64      `json:"size,omitempty"`
	ModifiedAt *int64      `json:"modifiedAt,omitempty"`
	NoteCount  *int        `json:"noteCount,omitempty"`
	Children   *[]treeNode `json:"children,omitempty"`
	Truncated  bool        `json:"truncated,omitempty"`
}

type listEntry struct {
	Name       string `json:"name"`
	Path       string `json:"path"`
	Kind       string `json:"kind"`
	Size       *int64 `json:"size,omitempty"`
	ModifiedAt *int64 `json:"modifiedAt,omitempty"`
}

func classifyEntry(e fs.DirEntry) string {
	if e.IsDir() {
		return "dir"
	}
	if isNoteName(e.Name()) {
		return "note"
	}
	return "file"
}

func (v *Vault) treeNodes(dirRel string, level, maxDepth int) ([]treeNode, int, bool) {
	ents, _, perr := v.readDirSorted(dirRel)
	if perr != nil {
		return []treeNode{}, 0, false
	}
	truncated := false
	if len(ents) > maxTreePerLevel {
		ents = ents[:maxTreePerLevel]
		truncated = true
	}
	nodes := make([]treeNode, 0, len(ents))
	total := 0
	for _, e := range ents {
		childRel := joinRel(dirRel, e.Name())
		kind := classifyEntry(e)
		if kind == "dir" {
			var children []treeNode
			count := 0
			childTrunc := false
			if level+1 < maxDepth {
				children, count, childTrunc = v.treeNodes(childRel, level+1, maxDepth)
			} else {
				count = v.countNotes(childRel)
				childTrunc = true
			}
			if truncated {
				// the visible children are truncated, so the subtree total has to
				// come from a full walk to stay accurate
				count = v.countNotes(childRel)
			}
			if children == nil {
				children = []treeNode{}
			}
			nodes = append(nodes, treeNode{
				Name:      e.Name(),
				Path:      childRel,
				Kind:      "dir",
				NoteCount: &count,
				Children:  &children,
				Truncated: childTrunc,
			})
			total += count
			continue
		}
		info, ierr := e.Info()
		if ierr != nil {
			continue
		}
		size := info.Size()
		modified := info.ModTime().UnixMilli()
		nodes = append(nodes, treeNode{
			Name:       e.Name(),
			Path:       childRel,
			Kind:       kind,
			Size:       &size,
			ModifiedAt: &modified,
		})
		if kind == "note" {
			total++
		}
	}
	return nodes, total, truncated
}

func (s *server) notesInfo(p rawParams) (any, *rpcError) {
	v, rerr := s.session(p.str("connectionId"))
	if rerr != nil {
		return nil, rerr
	}
	st := v.stats()
	return map[string]any{
		"vault": map[string]any{
			"path":         v.Root,
			"name":         v.Name,
			"assetsDir":    v.AssetsDir,
			"trashEnabled": v.TrashEnabled,
			"uriRoot":      "mdnotes://vault/",
		},
		"stats": map[string]any{
			"notes":   st.Notes,
			"folders": st.Folders,
			"bytes":   st.Bytes,
			"images":  st.Images,
		},
		"plugin": map[string]any{"id": pluginID, "version": pluginVersion},
	}, nil
}

func (s *server) notesTree(p rawParams) (any, *rpcError) {
	v, rerr := s.session(p.str("connectionId"))
	if rerr != nil {
		return nil, rerr
	}
	dirRel := p.str("dir")
	_, cleanDir, info, rerr := v.stat(dirRel)
	if rerr != nil {
		return nil, rerr
	}
	if !info.IsDir() {
		return nil, errRuntime("NOT_A_DIR", "不是目录: "+displayPath(cleanDir))
	}
	depth := int(p.intParam("depth", defaultTreeDepth))
	if depth < 1 {
		depth = 1
	}
	if depth > maxTreeDepth {
		depth = maxTreeDepth
	}
	nodes, _, _ := v.treeNodes(cleanDir, 0, depth)
	if nodes == nil {
		nodes = []treeNode{}
	}
	return map[string]any{"nodes": nodes}, nil
}

func (s *server) notesList(p rawParams) (any, *rpcError) {
	v, rerr := s.session(p.str("connectionId"))
	if rerr != nil {
		return nil, rerr
	}
	ents, cleanDir, rerr := v.readDirSorted(p.str("dir"))
	if rerr != nil {
		return nil, rerr
	}
	entries := make([]listEntry, 0, len(ents))
	for _, e := range ents {
		entry := listEntry{Name: e.Name(), Path: joinRel(cleanDir, e.Name()), Kind: classifyEntry(e)}
		if entry.Kind != "dir" {
			if info, ierr := e.Info(); ierr == nil {
				size := info.Size()
				modified := info.ModTime().UnixMilli()
				entry.Size = &size
				entry.ModifiedAt = &modified
			}
		}
		entries = append(entries, entry)
	}
	return map[string]any{"entries": entries}, nil
}

func (s *server) notesRead(p rawParams) (any, *rpcError) {
	v, rerr := s.session(p.str("connectionId"))
	if rerr != nil {
		return nil, rerr
	}
	rel := p.str("path")
	if strings.TrimSpace(rel) == "" {
		return nil, errParams("PATH_INVALID", "缺少 path")
	}
	abs, clean, info, rerr := v.stat(rel)
	if rerr != nil {
		return nil, rerr
	}
	if info.IsDir() {
		return nil, errRuntime("NOT_A_NOTE", "不是笔记文件: "+displayPath(clean))
	}
	if info.Size() > maxNoteBytes {
		return nil, errRuntime("PAYLOAD_TOO_LARGE", fmt.Sprintf("笔记超过 4 MiB: %s", displayPath(clean)))
	}
	data, err := os.ReadFile(abs)
	if err != nil {
		return nil, errRuntime("IO_ERROR", err.Error())
	}
	return map[string]any{
		"path":       clean,
		"name":       filepath.Base(abs),
		"content":    strings.ToValidUTF8(string(data), "\uFFFD"),
		"size":       info.Size(),
		"modifiedAt": info.ModTime().UnixMilli(),
	}, nil
}

func (s *server) notesWrite(p rawParams) (any, *rpcError) {
	v, rerr := s.session(p.str("connectionId"))
	if rerr != nil {
		return nil, rerr
	}
	rel := p.str("path")
	if strings.TrimSpace(rel) == "" {
		return nil, errParams("PATH_INVALID", "缺少 path")
	}
	abs, clean, perr := v.absPath(rel)
	if perr != nil {
		return nil, perr
	}
	content := p.str("content")
	data := []byte(content)

	exists := false
	var current os.FileInfo
	if info, err := os.Stat(abs); err == nil {
		exists = true
		current = info
		if info.IsDir() {
			return nil, errRuntime("PATH_INVALID", "目标是目录: "+displayPath(clean))
		}
	} else if !os.IsNotExist(err) {
		return nil, errRuntime("IO_ERROR", err.Error())
	}

	if raw := p.raw("expectedModifiedAt"); raw != nil {
		want, ok := rawToFloat(raw)
		if !ok {
			return nil, errParams("INVALID_REQUEST", "expectedModifiedAt 必须是数字")
		}
		if !exists {
			return nil, errRuntime("CONFLICT", "文件已被外部修改: "+displayPath(clean))
		}
		if current.ModTime().UnixMilli() != int64(math.Round(want)) {
			return nil, errRuntime("CONFLICT", "文件已被外部修改: "+displayPath(clean))
		}
	}

	if err := ensureDir(filepath.Dir(abs)); err != nil {
		return nil, errRuntime("IO_ERROR", "创建目录失败: "+err.Error())
	}
	if err := writeFileAtomic(abs, data); err != nil {
		return nil, errRuntime("IO_ERROR", "写入失败: "+err.Error())
	}
	info, err := os.Stat(abs)
	if err != nil {
		return nil, errRuntime("IO_ERROR", err.Error())
	}
	return map[string]any{
		"path":       clean,
		"size":       info.Size(),
		"modifiedAt": info.ModTime().UnixMilli(),
		"created":    !exists,
	}, nil
}

func (s *server) notesCreate(p rawParams) (any, *rpcError) {
	v, rerr := s.session(p.str("connectionId"))
	if rerr != nil {
		return nil, rerr
	}
	dirRel := p.str("dir")
	absDir, _, perr := v.absPath(dirRel)
	if perr != nil {
		return nil, perr
	}
	if err := ensureDir(absDir); err != nil {
		return nil, errRuntime("IO_ERROR", "创建目录失败: "+err.Error())
	}
	title := p.str("title")
	if strings.TrimSpace(title) == "" {
		title = "未命名笔记"
	}
	stem := sanitizeNoteTitle(title)
	if stem == "" {
		stem = "Untitled"
	}
	target := uniqueNotePath(absDir, stem)
	if err := writeFileAtomic(target, []byte{}); err != nil {
		return nil, errRuntime("IO_ERROR", "创建笔记失败: "+err.Error())
	}
	info, err := os.Stat(target)
	if err != nil {
		return nil, errRuntime("IO_ERROR", err.Error())
	}
	return map[string]any{
		"path":       v.relOf(target),
		"name":       filepath.Base(target),
		"content":    "",
		"modifiedAt": info.ModTime().UnixMilli(),
	}, nil
}

func (s *server) notesRename(p rawParams) (any, *rpcError) {
	v, rerr := s.session(p.str("connectionId"))
	if rerr != nil {
		return nil, rerr
	}
	rel := p.str("path")
	if strings.TrimSpace(rel) == "" {
		return nil, errParams("PATH_INVALID", "缺少 path")
	}
	newName := p.str("newName")
	if strings.TrimSpace(newName) == "" {
		return nil, errParams("PATH_INVALID", "缺少 newName")
	}
	name, perr := cleanSegment(newName)
	if perr != nil {
		return nil, perr
	}
	abs, clean, _, rerr := v.stat(rel)
	if rerr != nil {
		return nil, rerr
	}
	if clean == "" {
		return nil, errParams("PATH_INVALID", "不能重命名笔记库根目录")
	}
	target := filepath.Join(filepath.Dir(abs), name)
	if _, err := os.Stat(target); err == nil {
		if target == abs {
			return map[string]any{"path": clean, "name": name}, nil
		}
		return nil, errRuntime("ALREADY_EXISTS", "目标已存在: "+name)
	} else if !os.IsNotExist(err) {
		return nil, errRuntime("IO_ERROR", err.Error())
	}
	if err := renameOverwrite(abs, target); err != nil {
		return nil, errRuntime("IO_ERROR", "重命名失败: "+err.Error())
	}
	return map[string]any{"path": v.relOf(target), "name": name}, nil
}

func (s *server) notesMove(p rawParams) (any, *rpcError) {
	v, rerr := s.session(p.str("connectionId"))
	if rerr != nil {
		return nil, rerr
	}
	rel := p.str("path")
	if strings.TrimSpace(rel) == "" {
		return nil, errParams("PATH_INVALID", "缺少 path")
	}
	srcAbs, srcClean, info, rerr := v.stat(rel)
	if rerr != nil {
		return nil, rerr
	}
	if srcClean == "" {
		return nil, errParams("PATH_INVALID", "不能移动笔记库根目录")
	}
	targetDirAbs, targetClean, perr := v.absPath(p.str("targetDir"))
	if perr != nil {
		return nil, perr
	}
	if info.IsDir() {
		if targetClean == srcClean || strings.HasPrefix(targetClean, srcClean+"/") {
			return nil, errParams("PATH_INVALID", "不能把目录移进自己的子树")
		}
	}
	if err := ensureDir(targetDirAbs); err != nil {
		return nil, errRuntime("IO_ERROR", "创建目标目录失败: "+err.Error())
	}
	dest := filepath.Join(targetDirAbs, filepath.Base(srcAbs))
	if insideDir(srcAbs, dest) && info.IsDir() {
		return nil, errParams("PATH_INVALID", "不能把目录移进自己的子树")
	}
	if dest == srcAbs {
		return map[string]any{"path": srcClean}, nil
	}
	if _, err := os.Stat(dest); err == nil {
		return nil, errRuntime("ALREADY_EXISTS", "目标已存在: "+v.relOf(dest))
	} else if !os.IsNotExist(err) {
		return nil, errRuntime("IO_ERROR", err.Error())
	}
	if err := renameOverwrite(srcAbs, dest); err != nil {
		return nil, errRuntime("IO_ERROR", "移动失败: "+err.Error())
	}
	return map[string]any{"path": v.relOf(dest)}, nil
}

func (s *server) notesMkdir(p rawParams) (any, *rpcError) {
	v, rerr := s.session(p.str("connectionId"))
	if rerr != nil {
		return nil, rerr
	}
	name, perr := cleanSegment(strings.TrimSpace(p.str("name")))
	if perr != nil {
		return nil, perr
	}
	parentAbs, _, perr := v.absPath(p.str("dir"))
	if perr != nil {
		return nil, perr
	}
	target := filepath.Join(parentAbs, name)
	if info, err := os.Stat(target); err == nil {
		if info.IsDir() {
			return map[string]any{"path": v.relOf(target)}, nil
		}
		return nil, errRuntime("ALREADY_EXISTS", "同名文件已存在: "+name)
	} else if !os.IsNotExist(err) {
		return nil, errRuntime("IO_ERROR", err.Error())
	}
	if err := os.MkdirAll(target, 0o755); err != nil {
		return nil, errRuntime("IO_ERROR", "创建目录失败: "+err.Error())
	}
	return map[string]any{"path": v.relOf(target)}, nil
}

func (s *server) notesDelete(p rawParams) (any, *rpcError) {
	v, rerr := s.session(p.str("connectionId"))
	if rerr != nil {
		return nil, rerr
	}
	rel := p.str("path")
	if strings.TrimSpace(rel) == "" {
		return nil, errParams("PATH_INVALID", "不能删除笔记库根目录")
	}
	abs, clean, perr := v.absPath(rel)
	if perr != nil {
		return nil, perr
	}
	if clean == "" {
		return nil, errParams("PATH_INVALID", "不能删除笔记库根目录")
	}
	if _, err := os.Lstat(abs); err != nil {
		if os.IsNotExist(err) {
			return nil, errRuntime("NOT_FOUND", "路径不存在: "+clean)
		}
		return nil, errRuntime("IO_ERROR", err.Error())
	}
	permanent := p.boolean("permanent", false)
	if v.TrashEnabled && !permanent {
		trashDir := filepath.Join(v.Root, ".trash")
		if err := os.MkdirAll(trashDir, 0o755); err != nil {
			return nil, errRuntime("IO_ERROR", "创建 .trash 失败: "+err.Error())
		}
		base := filepath.Base(abs)
		target := filepath.Join(trashDir, nowStamp()+"-"+base)
		for i := 2; pathExists(target); i++ {
			target = filepath.Join(trashDir, nowStamp()+"-"+strconv.Itoa(i)+"-"+base)
		}
		if err := renameOverwrite(abs, target); err != nil {
			return nil, errRuntime("IO_ERROR", "移入 .trash 失败: "+err.Error())
		}
		return map[string]any{"path": clean, "trashedTo": v.relOf(target)}, nil
	}
	if err := os.RemoveAll(abs); err != nil {
		return nil, errRuntime("IO_ERROR", "删除失败: "+err.Error())
	}
	return map[string]any{"path": clean}, nil
}

type searchHit struct {
	Path    string `json:"path"`
	Name    string `json:"name"`
	Title   string `json:"title"`
	Line    int    `json:"line"`
	Text    string `json:"text"`
	Snippet string `json:"snippet"`
}

func (s *server) notesSearch(p rawParams) (any, *rpcError) {
	v, rerr := s.session(p.str("connectionId"))
	if rerr != nil {
		return nil, rerr
	}
	hits := make([]searchHit, 0)
	query := p.str("query")
	if strings.TrimSpace(query) != "" {
		limit := int(p.intParam("limit", 50))
		if limit <= 0 {
			limit = 50
		}
		if limit > maxSearchLimit {
			limit = maxSearchLimit
		}
		lowerQuery := strings.ToLower(query)
		queryLen := len(lowerQuery)

		var files []string
		_ = filepath.WalkDir(v.Root, func(path string, d fs.DirEntry, err error) error {
			if err != nil {
				return nil
			}
			if path == v.Root {
				return nil
			}
			if isHiddenName(d.Name()) {
				if d.IsDir() {
					return fs.SkipDir
				}
				return nil
			}
			if d.IsDir() || !isNoteName(d.Name()) {
				return nil
			}
			rel, rerr := filepath.Rel(v.Root, path)
			if rerr != nil {
				return nil
			}
			files = append(files, filepath.ToSlash(rel))
			return nil
		})
		sort.Strings(files)

		for _, rel := range files {
			if len(hits) >= limit {
				break
			}
			abs, _, perr := v.absPath(rel)
			if perr != nil {
				continue
			}
			info, serr := os.Stat(abs)
			if serr != nil || info.IsDir() || info.Size() > maxNoteBytes {
				continue
			}
			data, rerr := os.ReadFile(abs)
			if rerr != nil {
				continue
			}
			content := strings.ToValidUTF8(string(data), "\uFFFD")
			title := noteTitle(rel, content)
			found := 0
			for i, line := range strings.Split(content, "\n") {
				if found >= 3 || len(hits) >= limit {
					break
				}
				lowerLine := strings.ToLower(line)
				idx := strings.Index(lowerLine, lowerQuery)
				if idx < 0 {
					continue
				}
				found++
				hits = append(hits, searchHit{
					Path:    rel,
					Name:    slashpath.Base(rel),
					Title:   title,
					Line:    i + 1,
					Text:    clipRunes(strings.TrimSpace(line), 200),
					Snippet: snippetAround(line, idx, queryLen),
				})
			}
		}
	}
	return map[string]any{"hits": hits}, nil
}

func (s *server) notesSaveImage(p rawParams) (any, *rpcError) {
	v, rerr := s.session(p.str("connectionId"))
	if rerr != nil {
		return nil, rerr
	}
	data, derr := decodeBase64(p.str("dataBase64"))
	if derr != nil {
		return nil, derr
	}
	if len(data) == 0 {
		return nil, errParams("PATH_INVALID", "缺少图片数据")
	}
	if int64(len(data)) > maxImageBytes {
		return nil, errRuntime("PAYLOAD_TOO_LARGE", "图片超过 8 MiB")
	}

	noteRel := p.str("notePath")
	noteDirRel := ""
	if strings.TrimSpace(noteRel) != "" {
		cleanNote, perr := cleanRelPath(noteRel)
		if perr != nil {
			return nil, perr
		}
		if dir := slashpath.Dir(cleanNote); dir != "." && dir != "/" {
			noteDirRel = dir
		}
	}

	destDirRel := v.AssetsDir
	if strings.TrimSpace(destDirRel) == "" {
		destDirRel = noteDirRel
	}
	destAbs, _, perr := v.absPath(destDirRel)
	if perr != nil {
		return nil, perr
	}
	if err := ensureDir(destAbs); err != nil {
		return nil, errRuntime("IO_ERROR", "创建图片目录失败: "+err.Error())
	}

	rawName := p.str("name")
	ext := extForMime(p.str("mimeType"))
	if ext == "" {
		ext = sniffImageExt(data)
	}
	var stem, nameExt string
	if strings.TrimSpace(rawName) != "" {
		var nerr *rpcError
		stem, nameExt, nerr = splitImageName(rawName)
		if nerr != nil {
			return nil, nerr
		}
		if nameExt == "" {
			nameExt = ext
		}
	} else {
		stem = nowStamp() + "-" + randHex(8)
		nameExt = ext
	}
	if nameExt == "" {
		nameExt = ".bin"
	}

	target := uniqueImagePath(destAbs, stem, nameExt)
	if err := writeFileAtomic(target, data); err != nil {
		return nil, errRuntime("IO_ERROR", "写入图片失败: "+err.Error())
	}

	imageRel := v.relOf(target)
	noteDirAbs := v.Root
	if noteDirRel != "" {
		noteDirAbs = filepath.Join(v.Root, filepath.FromSlash(noteDirRel))
	}
	relToNote, relErr := filepath.Rel(noteDirAbs, target)
	if relErr != nil {
		relToNote = filepath.Base(target)
	}
	mdRel := filepath.ToSlash(relToNote)
	alt := filepath.Base(target)
	mdPath := mdRel
	if strings.ContainsAny(mdRel, " ()<>") {
		mdPath = "<" + mdRel + ">"
	}
	return map[string]any{
		"path":     imageRel,
		"name":     alt,
		"markdown": fmt.Sprintf("![%s](%s)", alt, mdPath),
		"bytes":    len(data),
	}, nil
}

func (s *server) notesImportFile(p rawParams) (any, *rpcError) {
	v, rerr := s.session(p.str("connectionId"))
	if rerr != nil {
		return nil, rerr
	}
	name := strings.TrimSpace(p.str("name"))
	relative := strings.TrimSpace(p.str("relativePath"))
	useRel := relative
	if useRel == "" {
		useRel = name
	}
	if useRel == "" {
		return nil, errParams("PATH_INVALID", "缺少 name 或 relativePath")
	}
	destRel := joinRel(p.str("targetDir"), useRel)
	cleanDest, perr := cleanRelPath(destRel)
	if perr != nil {
		return nil, perr
	}
	if cleanDest == "" || strings.HasSuffix(cleanDest, "/") {
		return nil, errParams("PATH_INVALID", "目标路径非法: "+useRel)
	}
	data, derr := decodeBase64(p.str("dataBase64"))
	if derr != nil {
		return nil, derr
	}
	overwrite := p.boolean("overwrite", false)

	abs, clean, perr := v.absPath(cleanDest)
	if perr != nil {
		return nil, perr
	}
	if info, err := os.Stat(abs); err == nil {
		if info.IsDir() {
			return nil, errRuntime("ALREADY_EXISTS", "同名目录已存在: "+clean)
		}
		if !overwrite {
			clean, perr = uniqueRelPath(v, clean)
			if perr != nil {
				return nil, perr
			}
			abs, _, perr = v.absPath(clean)
			if perr != nil {
				return nil, perr
			}
		}
	} else if !os.IsNotExist(err) {
		return nil, errRuntime("IO_ERROR", err.Error())
	}

	if err := ensureDir(filepath.Dir(abs)); err != nil {
		return nil, errRuntime("IO_ERROR", "创建目录失败: "+err.Error())
	}
	if err := writeFileAtomic(abs, data); err != nil {
		return nil, errRuntime("IO_ERROR", "导入失败: "+err.Error())
	}
	return map[string]any{"path": clean}, nil
}

func (s *server) notesImportFolder(p rawParams) (any, *rpcError) {
	v, rerr := s.session(p.str("connectionId"))
	if rerr != nil {
		return nil, rerr
	}
	srcRaw := strings.TrimSpace(p.str("sourcePath"))
	if srcRaw == "" {
		return nil, errParams("PATH_INVALID", "缺少 sourcePath")
	}
	var srcAbs string
	if strings.HasPrefix(srcRaw, "~") || filepath.IsAbs(srcRaw) {
		abs, err := expandUserPath(srcRaw)
		if err != nil {
			return nil, errRuntime("PATH_INVALID", "无法解析来源路径: "+err.Error())
		}
		srcAbs = abs
	} else {
		abs, _, perr := v.absPath(srcRaw)
		if perr != nil {
			return nil, perr
		}
		srcAbs = abs
	}
	srcInfo, err := os.Stat(srcAbs)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, errRuntime("PATH_INVALID", "来源路径不存在: "+srcRaw)
		}
		return nil, errRuntime("IO_ERROR", err.Error())
	}
	if !srcInfo.IsDir() {
		return nil, errRuntime("PATH_INVALID", "来源路径不是目录: "+srcRaw)
	}

	_, targetClean, perr := v.absPath(p.str("targetDir"))
	if perr != nil {
		return nil, perr
	}
	destRootRel := joinRel(targetClean, srcInfo.Name())
	destRootAbs, _, perr := v.absPath(destRootRel)
	if perr != nil {
		return nil, perr
	}
	if err := ensureDir(destRootAbs); err != nil {
		return nil, errRuntime("IO_ERROR", "创建目标目录失败: "+err.Error())
	}

	imported, skipped := 0, 0
	var copied int64
	walkErr := filepath.WalkDir(srcAbs, func(current string, d fs.DirEntry, werr error) error {
		if werr != nil {
			skipped++
			logf("importFolder skip %s: %v", current, werr)
			return nil
		}
		if current == srcAbs {
			return nil
		}
		name := d.Name()
		if isHiddenName(name) {
			skipped++
			if d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if d.IsDir() {
			if importSkipDirs[strings.ToLower(name)] {
				skipped++
				return fs.SkipDir
			}
			return nil
		}
		if !isNoteName(name) && !isImageName(name) {
			skipped++
			return nil
		}
		info, ierr := d.Info()
		if ierr != nil {
			skipped++
			return nil
		}
		if info.Size() > maxImportFolder {
			skipped++
			logf("importFolder skip large file %s (%d bytes)", current, info.Size())
			return nil
		}
		rel, rerr := filepath.Rel(srcAbs, current)
		if rerr != nil {
			skipped++
			return nil
		}
		destRel := joinRel(destRootRel, filepath.ToSlash(rel))
		abs, _, aerr := v.absPath(destRel)
		if aerr != nil {
			skipped++
			return nil
		}
		if err := ensureDir(filepath.Dir(abs)); err != nil {
			skipped++
			return nil
		}
		if pathExists(abs) {
			uniq, uerr := uniqueRelPath(v, destRel)
			if uerr != nil {
				skipped++
				return nil
			}
			destRel = uniq
			abs, _, aerr = v.absPath(destRel)
			if aerr != nil {
				skipped++
				return nil
			}
		}
		data, rerr2 := os.ReadFile(current)
		if rerr2 != nil {
			skipped++
			logf("importFolder read %s: %v", current, rerr2)
			return nil
		}
		if err := writeFileAtomic(abs, data); err != nil {
			skipped++
			logf("importFolder write %s: %v", destRel, err)
			return nil
		}
		imported++
		copied += int64(len(data))
		return nil
	})
	if walkErr != nil {
		logf("importFolder walk error: %v", walkErr)
	}
	return map[string]any{
		"targetDir": destRootRel,
		"imported":  imported,
		"skipped":   skipped,
		"bytes":     copied,
	}, nil
}

func (s *server) notesReadAsset(p rawParams) (any, *rpcError) {
	v, rerr := s.session(p.str("connectionId"))
	if rerr != nil {
		return nil, rerr
	}
	rel := p.str("path")
	if strings.TrimSpace(rel) == "" {
		return nil, errParams("PATH_INVALID", "缺少 path")
	}
	abs, clean, info, rerr := v.stat(rel)
	if rerr != nil {
		return nil, rerr
	}
	if info.IsDir() {
		return nil, errRuntime("NOT_A_DIR", "不是文件: "+displayPath(clean))
	}
	limit := p.intParam("maxBytes", maxInlineBytes)
	limit = clampInt64(limit, 1, maxInlineBytes)
	f, err := os.Open(abs)
	if err != nil {
		return nil, errRuntime("IO_ERROR", err.Error())
	}
	defer func() { _ = f.Close() }()
	buf := make([]byte, limit)
	n, rerr2 := io.ReadFull(f, buf)
	if rerr2 != nil && rerr2 != io.EOF && rerr2 != io.ErrUnexpectedEOF {
		return nil, errRuntime("IO_ERROR", rerr2.Error())
	}
	data := buf[:n]
	return map[string]any{
		"path":        clean,
		"contentType": contentTypeForName(filepath.Base(abs)),
		"dataBase64":  encodeBase64(data),
		"truncated":   info.Size() > int64(n),
		"size":        info.Size(),
	}, nil
}

func (s *server) notesExportNote(p rawParams) (any, *rpcError) {
	v, rerr := s.session(p.str("connectionId"))
	if rerr != nil {
		return nil, rerr
	}
	rel := p.str("path")
	if strings.TrimSpace(rel) == "" {
		return nil, errParams("PATH_INVALID", "缺少 path")
	}
	abs, clean, info, rerr := v.stat(rel)
	if rerr != nil {
		return nil, rerr
	}
	if info.IsDir() || !isNoteName(filepath.Base(abs)) {
		return nil, errRuntime("NOT_A_NOTE", "不是笔记文件: "+displayPath(clean))
	}
	if info.Size() > maxExportBytes {
		return nil, errRuntime("PAYLOAD_TOO_LARGE", "笔记超过 8 MiB")
	}
	data, err := os.ReadFile(abs)
	if err != nil {
		return nil, errRuntime("IO_ERROR", err.Error())
	}
	return map[string]any{
		"name":        filepath.Base(abs),
		"contentType": "text/markdown; charset=utf-8",
		"dataBase64":  encodeBase64(data),
		"size":        len(data),
	}, nil
}

// ------------------------------------------------------------- filesystem ---

type fsEntry struct {
	Name        string `json:"name"`
	URI         string `json:"uri"`
	Kind        string `json:"kind"`
	Size        *int64 `json:"size,omitempty"`
	ModifiedAt  *int64 `json:"modifiedAt,omitempty"`
	ContentType string `json:"contentType,omitempty"`
}

// vaultURI renders mdnotes://vault/<rel> with percent-encoding.
func vaultURI(rel string) string {
	if rel == "" {
		return "mdnotes://vault/"
	}
	u := url.URL{Scheme: "mdnotes", Host: "vault", Path: "/" + rel}
	return u.String()
}

// parseVaultURI accepts mdnotes://vault/<rel>, mdnotes://vault and
// mdnotes:///<rel>, decoding percent escapes exactly once.
func parseVaultURI(raw string) (string, *rpcError) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return "", errParams("PATH_INVALID", "缺少 uri")
	}
	idx := strings.Index(s, "://")
	if idx < 0 {
		return "", errRuntime("UNSUPPORTED", "不是 mdnotes URI: "+s)
	}
	scheme := strings.ToLower(s[:idx])
	if scheme != "mdnotes" {
		return "", errRuntime("UNSUPPORTED", "不支持的 URI 方案: "+scheme)
	}
	rest := s[idx+3:]
	host := ""
	pathPart := ""
	if strings.HasPrefix(rest, "/") {
		pathPart = rest
	} else if i := strings.IndexByte(rest, '/'); i >= 0 {
		host = rest[:i]
		pathPart = rest[i:]
	} else {
		host = rest
	}
	if host != "" && strings.ToLower(host) != "vault" {
		return "", errRuntime("UNSUPPORTED", "不支持的 mdnotes 主机: "+host)
	}
	if i := strings.IndexAny(pathPart, "?#"); i >= 0 {
		pathPart = pathPart[:i]
	}
	decoded, err := url.PathUnescape(pathPart)
	if err != nil {
		decoded = pathPart
	}
	return strings.TrimPrefix(decoded, "/"), nil
}

func fsKind(e fs.DirEntry) string {
	switch {
	case e.IsDir():
		return "directory"
	case e.Type()&os.ModeSymlink != 0:
		return "symlink"
	case e.Type().IsRegular():
		return "file"
	}
	return "other"
}

func fsEntryFrom(rel string, e fs.DirEntry) fsEntry {
	entry := fsEntry{Name: e.Name(), URI: vaultURI(rel), Kind: fsKind(e)}
	info, err := e.Info()
	if err != nil {
		return entry
	}
	if entry.Kind != "directory" {
		size := info.Size()
		modified := info.ModTime().UnixMilli()
		entry.Size = &size
		entry.ModifiedAt = &modified
	}
	if entry.Kind == "file" || entry.Kind == "other" {
		entry.ContentType = contentTypeForName(e.Name())
	}
	return entry
}

func (v *Vault) fsEntryFor(rel string) (fsEntry, *rpcError) {
	abs, clean, perr := v.absPath(rel)
	if perr != nil {
		return fsEntry{}, perr
	}
	info, err := os.Lstat(abs)
	if err != nil {
		if os.IsNotExist(err) {
			return fsEntry{}, errRuntime("NOT_FOUND", "路径不存在: "+displayPath(clean))
		}
		return fsEntry{}, errRuntime("IO_ERROR", err.Error())
	}
	name := filepath.Base(abs)
	entry := fsEntry{Name: name, URI: vaultURI(clean)}
	switch {
	case info.IsDir():
		entry.Kind = "directory"
	case info.Mode()&os.ModeSymlink != 0:
		entry.Kind = "symlink"
	case info.Mode().IsRegular():
		entry.Kind = "file"
	default:
		entry.Kind = "other"
	}
	if entry.Kind != "directory" {
		size := info.Size()
		modified := info.ModTime().UnixMilli()
		entry.Size = &size
		entry.ModifiedAt = &modified
	}
	if entry.Kind == "file" || entry.Kind == "other" {
		entry.ContentType = contentTypeForName(name)
	}
	return entry, nil
}

func (s *server) fsList(p rawParams) (any, *rpcError) {
	v, rerr := s.fsVault(p)
	if rerr != nil {
		return nil, rerr
	}
	rel, rerr := parseVaultURI(p.str("uri"))
	if rerr != nil {
		return nil, rerr
	}
	abs, clean, perr := v.absPath(rel)
	if perr != nil {
		return nil, perr
	}
	info, err := os.Stat(abs)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, errRuntime("NOT_FOUND", "路径不存在: "+displayPath(clean))
		}
		return nil, errRuntime("IO_ERROR", err.Error())
	}
	if !info.IsDir() {
		return nil, errRuntime("NOT_A_DIR", "不是目录: "+displayPath(clean))
	}
	ents, err := os.ReadDir(abs)
	if err != nil {
		return nil, errRuntime("IO_ERROR", err.Error())
	}
	// Hidden entries are listed here on purpose: the user is browsing the real
	// directory through the filesystem provider.
	sort.SliceStable(ents, func(i, j int) bool {
		di, dj := ents[i].IsDir(), ents[j].IsDir()
		if di != dj {
			return di
		}
		li, lj := strings.ToLower(ents[i].Name()), strings.ToLower(ents[j].Name())
		if li != lj {
			return li < lj
		}
		return ents[i].Name() < ents[j].Name()
	})

	cursor := 0
	if raw := strings.TrimSpace(p.str("cursor")); raw != "" {
		n, cerr := strconv.Atoi(raw)
		if cerr != nil || n < 0 {
			return nil, errParams("PATH_INVALID", "cursor 非法: "+raw)
		}
		cursor = n
	}
	limit := int(p.intParam("limit", defaultPageLimit))
	if limit <= 0 {
		limit = defaultPageLimit
	}
	if limit > maxPageLimit {
		limit = maxPageLimit
	}
	if cursor > len(ents) {
		cursor = len(ents)
	}
	end := cursor + limit
	if end > len(ents) {
		end = len(ents)
	}
	entries := make([]fsEntry, 0, end-cursor)
	for _, e := range ents[cursor:end] {
		entries = append(entries, fsEntryFrom(joinRel(clean, e.Name()), e))
	}
	result := map[string]any{"entries": entries}
	if end < len(ents) {
		result["nextCursor"] = strconv.Itoa(end)
	}
	return result, nil
}

func (s *server) fsRead(p rawParams) (any, *rpcError) {
	v, rerr := s.fsVault(p)
	if rerr != nil {
		return nil, rerr
	}
	rel, rerr := parseVaultURI(p.str("uri"))
	if rerr != nil {
		return nil, rerr
	}
	abs, clean, info, rerr := v.stat(rel)
	if rerr != nil {
		return nil, rerr
	}
	if info.IsDir() {
		return nil, errRuntime("UNSUPPORTED", "目录不能作为文件读取: "+displayPath(clean))
	}
	if info.Size() > maxInlineBytes {
		return nil, errRuntime("PAYLOAD_TOO_LARGE", "文件超过 4 MiB: "+displayPath(clean))
	}
	limit := p.intParam("maxBytes", maxInlineBytes)
	limit = clampInt64(limit, 1, maxInlineBytes)
	f, err := os.Open(abs)
	if err != nil {
		return nil, errRuntime("IO_ERROR", err.Error())
	}
	defer func() { _ = f.Close() }()
	buf := make([]byte, limit)
	n, rerr2 := io.ReadFull(f, buf)
	if rerr2 != nil && rerr2 != io.EOF && rerr2 != io.ErrUnexpectedEOF {
		return nil, errRuntime("IO_ERROR", rerr2.Error())
	}
	return map[string]any{
		"dataBase64":  encodeBase64(buf[:n]),
		"contentType": contentTypeForName(filepath.Base(abs)),
		"truncated":   info.Size() > int64(n),
		"etag":        fmt.Sprintf("%d-%d", info.Size(), info.ModTime().UnixMilli()),
	}, nil
}

func (s *server) fsWrite(p rawParams) (any, *rpcError) {
	v, rerr := s.fsVault(p)
	if rerr != nil {
		return nil, rerr
	}
	rel, rerr := parseVaultURI(p.str("uri"))
	if rerr != nil {
		return nil, rerr
	}
	abs, clean, perr := v.absPath(rel)
	if perr != nil {
		return nil, perr
	}
	if clean == "" {
		return nil, errParams("PATH_INVALID", "不能写入笔记库根目录")
	}
	data, derr := decodeBase64(p.str("dataBase64"))
	if derr != nil {
		return nil, derr
	}
	if int64(len(data)) > maxInlineBytes {
		return nil, errRuntime("PAYLOAD_TOO_LARGE", "写入内容超过 4 MiB")
	}
	create := p.boolean("create", true)
	overwrite := p.boolean("overwrite", true)

	exists := false
	var current os.FileInfo
	if info, err := os.Stat(abs); err == nil {
		exists = true
		current = info
		if info.IsDir() {
			return nil, errRuntime("PATH_INVALID", "目标是目录: "+displayPath(clean))
		}
	} else if !os.IsNotExist(err) {
		return nil, errRuntime("IO_ERROR", err.Error())
	}
	if !exists && !create {
		return nil, errRuntime("NOT_FOUND", "文件不存在: "+displayPath(clean))
	}
	if exists && !overwrite {
		return nil, errRuntime("ALREADY_EXISTS", "文件已存在: "+displayPath(clean))
	}
	if etag := strings.TrimSpace(p.str("etag")); etag != "" && exists {
		currentETag := fmt.Sprintf("%d-%d", current.Size(), current.ModTime().UnixMilli())
		if etag != currentETag {
			return nil, errRuntime("CONFLICT", "文件已被外部修改: "+displayPath(clean))
		}
	}
	if err := ensureDir(filepath.Dir(abs)); err != nil {
		return nil, errRuntime("IO_ERROR", "创建目录失败: "+err.Error())
	}
	if err := writeFileAtomic(abs, data); err != nil {
		return nil, errRuntime("IO_ERROR", "写入失败: "+err.Error())
	}
	entry, eerr := v.fsEntryFor(clean)
	if eerr != nil {
		return map[string]any{"success": true}, nil
	}
	return map[string]any{"success": true, "entry": entry}, nil
}

func (s *server) fsCreateDirectory(p rawParams) (any, *rpcError) {
	v, rerr := s.fsVault(p)
	if rerr != nil {
		return nil, rerr
	}
	rel, rerr := parseVaultURI(p.str("uri"))
	if rerr != nil {
		return nil, rerr
	}
	abs, clean, perr := v.absPath(rel)
	if perr != nil {
		return nil, perr
	}
	if clean == "" {
		return nil, errRuntime("ALREADY_EXISTS", "笔记库根目录已存在")
	}
	if info, err := os.Stat(abs); err == nil {
		if !info.IsDir() {
			return nil, errRuntime("ALREADY_EXISTS", "同名文件已存在: "+displayPath(clean))
		}
	} else if !os.IsNotExist(err) {
		return nil, errRuntime("IO_ERROR", err.Error())
	} else if err := os.MkdirAll(abs, 0o755); err != nil {
		return nil, errRuntime("IO_ERROR", "创建目录失败: "+err.Error())
	}
	entry, eerr := v.fsEntryFor(clean)
	if eerr != nil {
		return map[string]any{"success": true}, nil
	}
	return map[string]any{"success": true, "entry": entry}, nil
}

func (s *server) fsDelete(p rawParams) (any, *rpcError) {
	v, rerr := s.fsVault(p)
	if rerr != nil {
		return nil, rerr
	}
	rel, rerr := parseVaultURI(p.str("uri"))
	if rerr != nil {
		return nil, rerr
	}
	abs, clean, perr := v.absPath(rel)
	if perr != nil {
		return nil, perr
	}
	if clean == "" {
		return nil, errParams("PATH_INVALID", "不能删除笔记库根目录")
	}
	info, err := os.Lstat(abs)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, errRuntime("NOT_FOUND", "路径不存在: "+clean)
		}
		return nil, errRuntime("IO_ERROR", err.Error())
	}
	recursive := p.boolean("recursive", false)
	if info.IsDir() && !recursive {
		ents, rerr2 := os.ReadDir(abs)
		if rerr2 != nil {
			return nil, errRuntime("IO_ERROR", rerr2.Error())
		}
		if len(ents) > 0 {
			return nil, errRuntime("IO_ERROR", "目录非空，需要 recursive: "+clean)
		}
		if err := os.Remove(abs); err != nil {
			return nil, errRuntime("IO_ERROR", "删除失败: "+err.Error())
		}
		return map[string]any{"success": true}, nil
	}
	if err := os.RemoveAll(abs); err != nil {
		return nil, errRuntime("IO_ERROR", "删除失败: "+err.Error())
	}
	return map[string]any{"success": true}, nil
}

func (s *server) fsRename(p rawParams) (any, *rpcError) {
	v, rerr := s.fsVault(p)
	if rerr != nil {
		return nil, rerr
	}
	srcRel, rerr := parseVaultURI(p.str("sourceUri"))
	if rerr != nil {
		return nil, rerr
	}
	dstRel, rerr := parseVaultURI(p.str("targetUri"))
	if rerr != nil {
		return nil, rerr
	}
	srcAbs, srcClean, perr := v.absPath(srcRel)
	if perr != nil {
		return nil, perr
	}
	dstAbs, dstClean, perr := v.absPath(dstRel)
	if perr != nil {
		return nil, perr
	}
	if srcClean == "" || dstClean == "" {
		return nil, errParams("PATH_INVALID", "源或目标为笔记库根目录")
	}
	srcInfo, err := os.Lstat(srcAbs)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, errRuntime("NOT_FOUND", "源路径不存在: "+srcClean)
		}
		return nil, errRuntime("IO_ERROR", err.Error())
	}
	if srcInfo.IsDir() {
		if dstClean == srcClean || strings.HasPrefix(dstClean, srcClean+"/") {
			return nil, errParams("PATH_INVALID", "不能把目录移进自己的子树")
		}
	}
	overwrite := p.boolean("overwrite", false)
	if _, serr := os.Lstat(dstAbs); serr == nil {
		if !overwrite {
			return nil, errRuntime("ALREADY_EXISTS", "目标已存在: "+dstClean)
		}
		if srcInfo.IsDir() {
			if err := os.RemoveAll(dstAbs); err != nil {
				return nil, errRuntime("IO_ERROR", err.Error())
			}
		}
	} else if !os.IsNotExist(serr) {
		return nil, errRuntime("IO_ERROR", serr.Error())
	}
	if err := ensureDir(filepath.Dir(dstAbs)); err != nil {
		return nil, errRuntime("IO_ERROR", "创建目标目录失败: "+err.Error())
	}
	if err := renameOverwrite(srcAbs, dstAbs); err != nil {
		return nil, errRuntime("IO_ERROR", "重命名失败: "+err.Error())
	}
	entry, eerr := v.fsEntryFor(dstClean)
	if eerr != nil {
		return map[string]any{"success": true}, nil
	}
	return map[string]any{"success": true, "entry": entry}, nil
}

// ------------------------------------------------------------ file helpers ---

// writeFileAtomic writes data to a temp sibling then renames over the target,
// keeping the permission bits of an existing file.
func writeFileAtomic(target string, data []byte) error {
	mode := os.FileMode(0o644)
	if info, err := os.Stat(target); err == nil {
		mode = info.Mode().Perm()
		if mode == 0 {
			mode = 0o644
		}
	}
	dir := filepath.Dir(target)
	tmp, err := os.CreateTemp(dir, "."+filepath.Base(target)+".tmp*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	discard := func() {
		_ = tmp.Close()
		_ = os.Remove(tmpName)
	}
	if _, err := tmp.Write(data); err != nil {
		discard()
		return err
	}
	if err := tmp.Chmod(mode); err != nil {
		discard()
		return err
	}
	if err := tmp.Sync(); err != nil {
		discard()
		return err
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmpName)
		return err
	}
	if err := os.Rename(tmpName, target); err == nil {
		return nil
	} else {
		// Windows refuses rename onto an existing file: drop it and retry once.
		if rmErr := os.Remove(target); rmErr == nil {
			if retryErr := os.Rename(tmpName, target); retryErr == nil {
				return nil
			}
		}
		_ = os.Remove(tmpName)
		return err
	}
}

// renameOverwrite renames with the same one-shot remove-and-retry fallback.
func renameOverwrite(src, dst string) error {
	if err := os.Rename(src, dst); err == nil {
		return nil
	} else {
		if rmErr := os.Remove(dst); rmErr == nil {
			if retryErr := os.Rename(src, dst); retryErr == nil {
				return nil
			}
		}
		return err
	}
}

func ensureDir(dir string) error {
	info, err := os.Stat(dir)
	if err == nil {
		if info.IsDir() {
			return nil
		}
		return fmt.Errorf("路径已存在且不是目录: %s", dir)
	}
	if !os.IsNotExist(err) {
		return err
	}
	return os.MkdirAll(dir, 0o755)
}

func pathExists(p string) bool {
	_, err := os.Lstat(p)
	return err == nil
}

func probeWritable(dir string) error {
	f, err := os.CreateTemp(dir, ".miko-md-probe-*")
	if err != nil {
		return err
	}
	name := f.Name()
	_, werr := f.WriteString("ok")
	cerr := f.Close()
	_ = os.Remove(name)
	if werr != nil {
		return werr
	}
	return cerr
}

func uniqueNotePath(dirAbs, stem string) string {
	candidate := filepath.Join(dirAbs, stem+".md")
	for i := 2; pathExists(candidate); i++ {
		candidate = filepath.Join(dirAbs, fmt.Sprintf("%s %d.md", stem, i))
	}
	return candidate
}

func uniqueImagePath(dirAbs, stem, ext string) string {
	candidate := filepath.Join(dirAbs, stem+ext)
	for i := 2; pathExists(candidate); i++ {
		candidate = filepath.Join(dirAbs, fmt.Sprintf("%s-%d%s", stem, i, ext))
	}
	return candidate
}

// uniqueRelPath appends " 2", " 3"… to the final segment until it is free.
func uniqueRelPath(v *Vault, destRel string) (string, *rpcError) {
	dir := slashpath.Dir(destRel)
	if dir == "." || dir == "/" {
		dir = ""
	}
	base := slashpath.Base(destRel)
	ext := slashpath.Ext(base)
	stem := strings.TrimSuffix(base, ext)
	for i := 2; i < 10000; i++ {
		candidate := joinRel(dir, fmt.Sprintf("%s %d%s", stem, i, ext))
		abs, _, perr := v.absPath(candidate)
		if perr != nil {
			return "", perr
		}
		if !pathExists(abs) {
			return candidate, nil
		}
	}
	return "", errRuntime("IO_ERROR", "无法生成唯一文件名: "+destRel)
}

func sanitizeNoteTitle(title string) string {
	cleaned := strings.Map(func(r rune) rune {
		switch r {
		case '/', '\\', ':', '*', '?', '"', '<', '>', '|':
			return -1
		}
		if r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, title)
	cleaned = strings.TrimSpace(cleaned)
	cleaned = strings.TrimLeft(cleaned, ".")
	cleaned = strings.TrimSpace(cleaned)
	if ext := strings.ToLower(slashpath.Ext(cleaned)); ext == ".md" || ext == ".markdown" {
		cleaned = strings.TrimSpace(strings.TrimSuffix(cleaned, slashpath.Ext(cleaned)))
	}
	if utf8.RuneCountInString(cleaned) > 120 {
		cleaned = string([]rune(cleaned)[:120])
	}
	return strings.TrimSpace(cleaned)
}

// splitImageName cleans a caller-supplied image file name into stem + extension.
func splitImageName(raw string) (string, string, *rpcError) {
	cleaned := strings.Map(func(r rune) rune {
		switch r {
		case '/', '\\', '*', '?', '"', '<', '>', '|':
			return -1
		}
		if r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, raw)
	cleaned = strings.TrimSpace(cleaned)
	cleaned = strings.TrimLeft(cleaned, ".")
	cleaned = strings.TrimSpace(cleaned)
	if cleaned == "" || cleaned == "." || cleaned == ".." {
		return "", "", errParams("PATH_INVALID", "图片文件名非法")
	}
	ext := slashpath.Ext(cleaned)
	stem := strings.TrimSuffix(cleaned, ext)
	stem = strings.TrimSpace(stem)
	if stem == "" {
		return "", "", errParams("PATH_INVALID", "图片文件名非法: "+raw)
	}
	if len(ext) > 0 {
		ext = strings.ToLower(ext)
		if !isImageName("x"+ext) && ext != ".bin" {
			// keep the caller's extension even when unknown; only sanitize it
			if strings.ContainsAny(ext, " ") {
				ext = strings.ReplaceAll(ext, " ", "_")
			}
		}
	}
	return stem, ext, nil
}

func extForMime(mime string) string {
	m := strings.ToLower(strings.TrimSpace(mime))
	if i := strings.IndexByte(m, ';'); i >= 0 {
		m = strings.TrimSpace(m[:i])
	}
	switch m {
	case "image/png":
		return ".png"
	case "image/jpeg", "image/jpg", "image/pjpeg":
		return ".jpg"
	case "image/gif":
		return ".gif"
	case "image/webp":
		return ".webp"
	case "image/avif":
		return ".avif"
	case "image/bmp", "image/x-ms-bmp":
		return ".bmp"
	case "image/svg+xml", "image/svg":
		return ".svg"
	}
	return ""
}

// sniffImageExt inspects magic bytes; "" means unknown.
func sniffImageExt(data []byte) string {
	switch {
	case len(data) >= 8 && bytes.Equal(data[:8], []byte("\x89PNG\r\n\x1a\n")):
		return ".png"
	case len(data) >= 3 && data[0] == 0xFF && data[1] == 0xD8 && data[2] == 0xFF:
		return ".jpg"
	case len(data) >= 6 && (string(data[:6]) == "GIF87a" || string(data[:6]) == "GIF89a"):
		return ".gif"
	case len(data) >= 12 && string(data[:4]) == "RIFF" && string(data[8:12]) == "WEBP":
		return ".webp"
	case len(data) >= 12 && string(data[4:12]) == "ftypavif":
		return ".avif"
	case len(data) >= 2 && data[0] == 'B' && data[1] == 'M':
		return ".bmp"
	case looksLikeSVG(data):
		return ".svg"
	}
	return ""
}

func looksLikeSVG(data []byte) bool {
	s := bytes.TrimPrefix(data, []byte("\xef\xbb\xbf"))
	s = bytes.TrimSpace(s)
	lower := bytes.ToLower(s)
	if bytes.HasPrefix(lower, []byte("<svg")) {
		return true
	}
	return bytes.HasPrefix(lower, []byte("<?xml"))
}

func contentTypeForName(name string) string {
	ext := strings.ToLower(slashpath.Ext(name))
	switch ext {
	case ".md", ".markdown":
		return "text/markdown; charset=utf-8"
	case ".png":
		return "image/png"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".gif":
		return "image/gif"
	case ".webp":
		return "image/webp"
	case ".avif":
		return "image/avif"
	case ".bmp":
		return "image/bmp"
	case ".svg":
		return "image/svg+xml"
	case ".json":
		return "application/json"
	case ".xml":
		return "application/xml"
	case ".html", ".htm":
		return "text/html; charset=utf-8"
	case ".css":
		return "text/css; charset=utf-8"
	case ".js", ".mjs":
		return "text/javascript; charset=utf-8"
	case ".csv":
		return "text/csv; charset=utf-8"
	}
	if textExts[ext] {
		return "text/plain; charset=utf-8"
	}
	return "application/octet-stream"
}

func noteTitle(rel, content string) string {
	for _, line := range strings.Split(content, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "# ") {
			if title := strings.TrimSpace(strings.TrimPrefix(trimmed, "# ")); title != "" {
				return clipRunes(title, 160)
			}
		}
	}
	base := slashpath.Base(rel)
	return strings.TrimSuffix(base, slashpath.Ext(base))
}

func clipRunes(s string, max int) string {
	if max <= 0 || utf8.RuneCountInString(s) <= max {
		return s
	}
	return string([]rune(s)[:max])
}

func snippetAround(line string, idx, queryLen int) string {
	const pad = 40
	if idx < 0 || idx > len(line) {
		return clipRunes(line, 120)
	}
	end := idx + queryLen
	if end > len(line) {
		end = len(line)
	}
	runes := []rune(line)
	startRune := utf8.RuneCountInString(line[:idx])
	matchRunes := utf8.RuneCountInString(line[idx:end])
	start := startRune - pad
	if start < 0 {
		start = 0
	}
	stop := startRune + matchRunes + pad
	if stop > len(runes) {
		stop = len(runes)
	}
	if start > len(runes) {
		start = len(runes)
	}
	if stop < start {
		stop = start
	}
	return string(runes[start:stop])
}
